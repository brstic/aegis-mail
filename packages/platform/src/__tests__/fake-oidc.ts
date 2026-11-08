import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

export interface TokenOverrides { iss?: string; aud?: string | string[]; sub?: string; nonce?: string | null; exp?: number; iat?: number; email?: string | null; email_verified?: unknown; name?: string; signWith?: "other" | "hs256" | "none"; extra?: Record<string, unknown> }
interface Grant { challenge: string; redirectUri: string; clientId: string; nonce: string; overrides: TokenOverrides }

/**
 * An in-process OpenID provider with real signed JWTs. It enforces the parts a real provider would: client authentication,
 * single-use codes, the redirect URI and PKCE. Tests choose what goes in the ID token.
 */
export async function fakeOidc(opts: { clientId: string; clientSecret: string; issuerPath?: string; kid?: string }) {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const other = await generateKeyPair("RS256", { extractable: true });
  const kid = opts.kid ?? "k1";
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  const grants = new Map<string, Grant>();
  const seen = { tokenRequests: 0, verifiers: [] as string[], authMethods: [] as string[] };
  let server: Server;
  let base = "";
  const issuer = () => `${base}${opts.issuerPath ?? ""}`;
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
    if (url.pathname === `${opts.issuerPath ?? ""}/.well-known/openid-configuration`) {
      return send(200, { issuer: issuer(), authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, jwks_uri: `${base}/jwks`, response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"], code_challenge_methods_supported: ["S256"] });
    }
    if (url.pathname === "/jwks") return send(200, { keys: [jwk] });
    // For a real browser: signs in whoever was hinted at, and sends them back.
    if (url.pathname === "/authorize") {
      const q = approve(url.href, { email: url.searchParams.get("login_hint") ?? undefined });
      res.writeHead(302, { location: `${url.searchParams.get("redirect_uri")}?${q}` });
      return void res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      seen.tokenRequests++;
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      const basic = req.headers.authorization?.replace(/^Basic /, "");
      const [id, secret] = basic ? Buffer.from(basic, "base64").toString().split(":").map(decodeURIComponent) : [form.get("client_id"), form.get("client_secret")];
      seen.authMethods.push(basic ? "basic" : "post");
      if (id !== opts.clientId || secret !== opts.clientSecret) return send(401, { error: "invalid_client" });
      const code = form.get("code") ?? "";
      const g = grants.get(code);
      grants.delete(code);
      if (!g || g.redirectUri !== form.get("redirect_uri") || g.clientId !== id) return send(400, { error: "invalid_grant" });
      const verifier = form.get("code_verifier") ?? "";
      seen.verifiers.push(verifier);
      if (createHash("sha256").update(verifier).digest("base64url") !== g.challenge) return send(400, { error: "invalid_grant", error_description: "pkce" });
      return send(200, { access_token: randomBytes(16).toString("hex"), token_type: "Bearer", expires_in: 3600, id_token: await idToken(g) });
    }
    send(404, { error: "not_found" });
  });
  function approve(authUrl: string, overrides: TokenOverrides = {}) {
    const u = new URL(authUrl);
    const code = randomBytes(16).toString("hex");
    grants.set(code, { challenge: u.searchParams.get("code_challenge")!, redirectUri: u.searchParams.get("redirect_uri")!, clientId: u.searchParams.get("client_id")!, nonce: u.searchParams.get("nonce")!, overrides });
    return new URLSearchParams({ code, state: u.searchParams.get("state")! });
  }
  async function idToken(g: Grant) {
    const o = g.overrides, now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = { ...(o.nonce === null ? {} : { nonce: o.nonce ?? g.nonce }), ...(o.email === null ? {} : { email: o.email ?? "person@corp.example" }), ...(o.email_verified === undefined ? { email_verified: true } : o.email_verified === null ? {} : { email_verified: o.email_verified }), ...(o.name ? { name: o.name } : {}), ...(o.extra ?? {}) };
    const body = { iss: o.iss ?? issuer(), aud: o.aud ?? opts.clientId, sub: o.sub ?? `subject-for-${o.email ?? "unknown"}`, iat: o.iat ?? now, exp: o.exp ?? now + 300, ...claims };
    if (o.signWith === "none") return `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify(body)).toString("base64url")}.`;
    const j = new SignJWT(body);
    if (o.signWith === "hs256") return j.setProtectedHeader({ alg: "HS256", kid }).sign(new TextEncoder().encode(opts.clientSecret.padEnd(32, "x")));
    return j.setProtectedHeader({ alg: "RS256", kid }).sign(o.signWith === "other" ? other.privateKey : privateKey);
  }
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    get issuer() { return issuer(); },
    seen,
    /** What the provider does after the person signs in: reads the request, and mints a code for it. */
    approve,
    close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
