import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDomain, beginSso, type Ctx, finishSaml, makeLogger, normalizeIdpCert, type Platform, removeSsoConfig, resolveSession, samlAcsUrl, samlEntityId, saveSamlConfig, setSsoEnforced, signIn, signUp, ssoOverview, verifyDomain } from "../index";
import { type A, assertion, b64, IDP, keypair, response, sign } from "./fake-saml";
import { markVerified, testPlatform, user } from "./harness";

const pw = "correct-horse-battery";
describe("SAML against a fake identity provider with real XML signatures", () => {
  let p: Platform, drop: () => Promise<void>, logs: string[], owner: Ctx, idpKeys: { key: string; cert: string }, evilKeys: { key: string; cert: string }, configId: string;
  const DOMAIN = "corp.example";
  beforeAll(async () => {
    ({ p, drop, logs } = await testPlatform({ config: { demoMode: true, appOrigin: "http://localhost:3000", webauthnRpId: "localhost" } }));
    idpKeys = await keypair("idp.corp.example");
    evilKeys = await keypair("evil.example");
    owner = await user(p, "owner@admin.corp.example", { kind: "organization" });
    const d = await addDomain(p, owner, DOMAIN);
    await verifyDomain(p, owner, DOMAIN, async () => [[d!.token]]);
    configId = (await saveSamlConfig(p, owner, { domain: DOMAIN, idpEntityId: IDP, entryPoint: "https://idp.corp.example/sso", idpCert: idpKeys.cert })).id;
  });
  afterAll(() => drop());

  const acs = () => samlAcsUrl(p, DOMAIN);
  const aud = () => samlEntityId(p, DOMAIN);
  /** Starts a real attempt: the redirect holds a real AuthnRequest whose ID the response has to answer. */
  const start = async (email: string, next?: string) => {
    const s = (await beginSso(p, { email, next }))!;
    expect(s.protocol).toBe("saml");
    const { inflateRawSync } = await import("node:zlib");
    const xml = inflateRawSync(Buffer.from(new URL(s.url).searchParams.get("SAMLRequest")!, "base64")).toString();
    return { binding: s.binding, requestId: /ID="([^"]+)"/.exec(xml)![1]!, url: s.url, xml };
  };
  const good = (email: string, requestId: string, a: A = {}, k = idpKeys) => response(sign(assertion({ nameId: email, audience: aud(), recipient: acs(), inResponseTo: requestId, ...a }), k), { destination: acs(), inResponseTo: requestId });
  const finish = (xml: string, binding: string | undefined) => finishSaml(p, DOMAIN, b64(xml), binding);
  const users = (email: string) => p.db.withSystem(t => t.query<any>("SELECT * FROM users WHERE lower(email)=$1", [email]));

  describe("the good path", () => {
    it("sends a signed-assertion request to the provider, and shows admins what to configure", async () => {
      const s = await start("a@corp.example");
      expect(s.url.startsWith("https://idp.corp.example/sso?")).toBe(true);
      expect(s.xml).toContain(`AssertionConsumerServiceURL="${acs()}"`);
      expect(s.xml).toContain(aud());
      const o = await ssoOverview(p, owner);
      expect(o.samlBaseUrl).toBe("http://localhost:3000/api/v1/auth/saml");
      expect(o.configs[0]).toMatchObject({ protocol: "saml", issuer: IDP });
    });
    it("creates a verified member through JIT, with a session in the tenant", async () => {
      const s = await start("alice@corp.example", "/app/inbox");
      const r = await finish(good("alice@corp.example", s.requestId, { displayName: "Alice A" }), s.binding);
      if (r.kind !== "session") throw new Error("expected a session");
      expect(r.next).toBe("/app/inbox");
      expect(await resolveSession(p, r.token)).toMatchObject({ email: "alice@corp.example", tenantId: owner.tenantId, role: "member", emailVerified: true, name: "Alice A" });
    });
    it("signs the same person back in", async () => {
      const s = await start("alice@corp.example");
      const r = await finish(good("alice@corp.example", s.requestId), s.binding);
      expect(r.kind).toBe("session");
      expect(await users("alice@corp.example")).toHaveLength(1);
    });
    it("a comment in the NameID can't truncate it", async () => {
      const s = await start("x@corp.example");
      await expect(finish(good("ceo@corp.example<!---->.evil.example", s.requestId), s.binding)).rejects.toMatchObject({ code: "sso_domain_mismatch" });
      expect(await users("ceo@corp.example")).toHaveLength(0);
    });
  });

  describe("forgery gets nobody signed in", () => {
    const refused = async (make: (requestId: string) => string, email = "target@corp.example") => {
      const s = await start(email);
      await expect(finish(make(s.requestId), s.binding)).rejects.toMatchObject({ code: "sso_token_invalid" });
      expect(await users(email)).toHaveLength(0);
    };
    it("a tampered NameID", () => refused(id => good("someone@corp.example", id).replace("someone@corp.example", "target@corp.example")));
    it("signed by another key", () => refused(id => good("target@corp.example", id, {}, evilKeys)));
    it("not signed at all", () => refused(id => response(assertion({ nameId: "target@corp.example", audience: aud(), recipient: acs(), inResponseTo: id }), { destination: acs(), inResponseTo: id })));
    it("the wrong audience", () => refused(id => good("target@corp.example", id, { audience: "https://some.other.app/" })));
    it("expired", () => refused(id => good("target@corp.example", id, { notAfter: -120_000 })));
    it("the wrong issuer", () => refused(id => good("target@corp.example", id, { issuer: "https://idp.evil.example/" })));
    it("meant for another service provider's ACS", () => refused(id => good("target@corp.example", id, { recipient: "https://other.app/acs" })));
    it("not XML", () => refused(() => "<<<not xml"));
    it("a signature over an empty document", () => refused(() => ""));
  });

  describe("signature wrapping", () => {
    const signed = (id: string, requestId: string, nameId = "someone@corp.example") => sign(assertion({ id, nameId, audience: aud(), recipient: acs(), inResponseTo: requestId }), idpKeys);
    const evil = (id: string, requestId: string) => assertion({ id, nameId: "target@corp.example", audience: aud(), recipient: acs(), inResponseTo: requestId });
    const attack = async (build: (requestId: string) => string) => {
      const s = await start("target@corp.example");
      await expect(finish(response(build(s.requestId), { destination: acs(), inResponseTo: s.requestId }), s.binding)).rejects.toMatchObject({ code: "sso_token_invalid" });
      expect(await users("target@corp.example")).toHaveLength(0);
    };
    it("the attacker's assertion before the signed one", () => attack(id => evil("_e", id) + signed("_s", id)));
    it("the attacker's assertion after the signed one", () => attack(id => signed("_s", id) + evil("_e", id)));
    it("the signed one moved into Extensions", () => attack(id => `<samlp:Extensions>${signed("_s", id)}</samlp:Extensions>${evil("_e", id)}`));
    it("the signed one nested in the attacker's assertion", () => attack(id => evil("_e", id).replace("</saml:Subject>", `</saml:Subject><saml:Advice>${signed("_s", id)}</saml:Advice>`)));
    it("the attacker's assertion carrying the signature, with the same ID", () => attack(id => {
      const s = signed("_s", id);
      const sig = /<(ds:)?Signature[\s\S]*<\/(ds:)?Signature>/.exec(s)![0];
      return assertion({ id: "_s", nameId: "target@corp.example", audience: aud(), recipient: acs(), inResponseTo: id }).replace("</saml:Issuer>", `</saml:Issuer>${sig}`) + s;
    }));
    it("the signed assertion inside an Object of the attacker's signature", () => attack(id => {
      const s = signed("_s", id);
      const sig = /<(ds:)?Signature[\s\S]*<\/(ds:)?Signature>/.exec(s)![0];
      const moved = sig.replace(/<\/(ds:)?Signature>$/, `<ds:Object xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${s.replace(sig, "")}</ds:Object></ds:Signature>`);
      return assertion({ id: "_e", nameId: "target@corp.example", audience: aud(), recipient: acs(), inResponseTo: id }).replace("</saml:Issuer>", `</saml:Issuer>${moved}`);
    }));
  });

  describe("replay and unsolicited responses", () => {
    it("the same response can't be used twice", async () => {
      const s = await start("replay@corp.example");
      const xml = good("replay@corp.example", s.requestId);
      await expect(finish(xml, s.binding)).resolves.toMatchObject({ kind: "session" });
      await expect(finish(xml, s.binding)).rejects.toMatchObject({ code: "sso_token_invalid" });
    });
    it("a second, freshly signed response to the same request can't either", async () => {
      const s = await start("replay2@corp.example");
      await finish(good("replay2@corp.example", s.requestId), s.binding);
      await expect(finish(good("replay2@corp.example", s.requestId), s.binding)).rejects.toMatchObject({ code: "sso_token_invalid" });
    });
    it("a response nobody asked for is refused, so IdP-initiated sign-in can't be replayed in", async () => {
      const s = await start("unsolicited@corp.example");
      const xml = response(sign(assertion({ nameId: "unsolicited@corp.example", audience: aud(), recipient: acs() }), idpKeys), { destination: acs() });
      await expect(finish(xml, s.binding)).rejects.toMatchObject({ code: "sso_token_invalid" });
      const made = good("unsolicited@corp.example", "_made_up_request_id");
      await expect(finish(made, s.binding)).rejects.toMatchObject({ code: "sso_token_invalid" });
    });
    it("is refused from a browser that didn't start it: login CSRF", async () => {
      const s = await start("csrf@corp.example");
      const xml = good("csrf@corp.example", s.requestId);
      await expect(finish(xml, undefined)).rejects.toMatchObject({ code: "sso_token_invalid" });
      const s2 = await start("csrf2@corp.example");
      await expect(finish(good("csrf2@corp.example", s2.requestId), "attackers-cookie")).rejects.toMatchObject({ code: "sso_token_invalid" });
      expect(await users("csrf@corp.example")).toHaveLength(0);
    });
    it("an expired attempt", async () => {
      const s = await start("late@corp.example");
      await p.db.withSystem(t => t.query("UPDATE sso_flows SET expires_at=now() - interval '1 minute' WHERE kind='saml'"));
      await expect(finish(good("late@corp.example", s.requestId), s.binding)).rejects.toMatchObject({ code: "sso_token_invalid" });
    });
    it("stores only a hash of the request ID, and nothing readable", async () => {
      const s = await start("atrest@corp.example");
      const rows = await p.db.withSystem(t => t.query<any>("SELECT * FROM sso_flows WHERE kind='saml'"));
      expect(JSON.stringify(rows)).not.toContain(s.requestId);
      expect(JSON.stringify(rows)).not.toContain(s.binding);
    });
  });

  describe("the same linking rules as OIDC", () => {
    it("no email_verified attribute means nobody is signed in", async () => {
      const s = await start("noattr@corp.example");
      await expect(finish(good("noattr@corp.example", s.requestId, { emailVerified: null }), s.binding)).rejects.toMatchObject({ code: "sso_email_unverified" });
      const s2 = await start("noattr@corp.example");
      await expect(finish(good("noattr@corp.example", s2.requestId, { emailVerified: "false" }), s2.binding)).rejects.toMatchObject({ code: "sso_email_unverified" });
      expect(await users("noattr@corp.example")).toHaveLength(0);
    });
    it("the provider can't sign in an address on someone else's domain", async () => {
      const s = await start("x@corp.example");
      await expect(finish(good("victim@other.example", s.requestId), s.binding)).rejects.toMatchObject({ code: "sso_domain_mismatch" });
    });
    it("links a proven account on its verified domain, and it keeps its password", async () => {
      const v = await signUp(p, { email: "linked@corp.example", password: pw, name: "L", workspaceKind: "personal" });
      await markVerified(p, v.userId);
      const s = await start("linked@corp.example");
      const r = await finish(good("linked@corp.example", s.requestId), s.binding);
      if (r.kind !== "session") throw new Error("expected a session");
      expect(r.userId).toBe(v.userId);
      expect((await users("linked@corp.example"))[0].password_hash).toBeTruthy();
    });
    it("pre-hijacking: an unproven squatter loses every way in", async () => {
      const q = await signUp(p, { email: "cfo@corp.example", password: "squatter-password-123", name: "S", workspaceKind: "personal" });
      const s = await start("cfo@corp.example");
      const r = await finish(good("cfo@corp.example", s.requestId), s.binding);
      if (r.kind !== "session") throw new Error("expected a session");
      expect(r.userId).toBe(q.userId);
      expect(await resolveSession(p, q.token)).toBeNull();
      await expect(signIn(p, { email: "cfo@corp.example", password: "squatter-password-123" })).rejects.toMatchObject({ status: 401 });
    });
    it("enforcement works the same", async () => {
      await setSsoEnforced(p, owner, configId, true);
      await expect(signIn(p, { email: "linked@corp.example", password: pw })).rejects.toMatchObject({ code: "sso_required" });
      await setSsoEnforced(p, owner, configId, false);
    });
  });

  describe("configuration", () => {
    it("takes PEM or bare base64, and refuses anything else", () => {
      const body = idpKeys.cert.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
      expect(normalizeIdpCert(body, new Date())).toContain("BEGIN CERTIFICATE");
      expect(normalizeIdpCert(idpKeys.cert, new Date())).toContain("BEGIN CERTIFICATE");
      expect(() => normalizeIdpCert("not a cert", new Date())).toThrow(/valid X.509/);
      expect(() => normalizeIdpCert(idpKeys.key, new Date())).toThrow(/valid X.509/);
      expect(() => normalizeIdpCert(idpKeys.cert, new Date(Date.now() + 86_400_000 * 365 * 100))).toThrow(/expired/);
    });
    it.each(["http://idp.example/sso", "javascript:alert(1)", "https://user:pass@idp.example/sso", "not a url"])("refuses the sign-in URL %s", async entryPoint => {
      await expect(saveSamlConfig(p, owner, { domain: DOMAIN, idpEntityId: IDP, entryPoint, idpCert: idpKeys.cert })).rejects.toMatchObject({ code: "entry_point_invalid" });
    });
    it("needs a domain verified by this tenant", async () => {
      await expect(saveSamlConfig(p, owner, { domain: "never-added.example", idpEntityId: IDP, entryPoint: "https://idp.example/sso", idpCert: idpKeys.cert })).rejects.toMatchObject({ code: "domain_unverified" });
    });
    it("ACS on a domain with no SAML config is unavailable", async () => {
      await expect(finishSaml(p, "nowhere.example", b64("<x/>"), "b")).rejects.toMatchObject({ code: "sso_not_available" });
    });
    it("swapping the certificate needs a fresh test before it can be required", async () => {
      await saveSamlConfig(p, owner, { domain: DOMAIN, idpEntityId: IDP, entryPoint: "https://idp.corp.example/sso", idpCert: evilKeys.cert });
      await expect(setSsoEnforced(p, owner, configId, true)).rejects.toMatchObject({ code: "sso_untested" });
      await saveSamlConfig(p, owner, { domain: DOMAIN, idpEntityId: IDP, entryPoint: "https://idp.corp.example/sso", idpCert: idpKeys.cert });
    });
    it("removing it removes the identities it created, and sign-in stops", async () => {
      const o = await user(p, "o@saml-gone.example", { kind: "organization" });
      const d = await addDomain(p, o, "saml-gone.example");
      await verifyDomain(p, o, "saml-gone.example", async () => [[d!.token]]);
      const { id } = await saveSamlConfig(p, o, { domain: "saml-gone.example", idpEntityId: IDP, entryPoint: "https://idp.corp.example/sso", idpCert: idpKeys.cert });
      const s = (await beginSso(p, { email: "a@saml-gone.example" }))!;
      const { inflateRawSync } = await import("node:zlib");
      const requestId = /ID="([^"]+)"/.exec(inflateRawSync(Buffer.from(new URL(s.url).searchParams.get("SAMLRequest")!, "base64")).toString())![1]!;
      const acsUrl = samlAcsUrl(p, "saml-gone.example");
      await finishSaml(p, "saml-gone.example", b64(response(sign(assertion({ nameId: "a@saml-gone.example", audience: samlEntityId(p, "saml-gone.example"), recipient: acsUrl, inResponseTo: requestId }), idpKeys), { destination: acsUrl, inResponseTo: requestId })), s.binding);
      expect(await p.db.withSystem(t => t.query("SELECT 1 FROM identities WHERE provider LIKE $1", [`saml:${id}:%`]))).toHaveLength(1);
      await removeSsoConfig(p, o, id);
      expect(await p.db.withSystem(t => t.query("SELECT 1 FROM identities WHERE provider LIKE $1", [`saml:${id}:%`]))).toHaveLength(0);
      expect(await beginSso(p, { email: "a@saml-gone.example" })).toBeNull();
    });
    it("keeps assertion contents out of the logs", () => {
      expect(logs.join("\n")).not.toContain("target@corp.example");
      expect(logs.join("\n")).not.toContain("<saml");
    });
  });
});
void makeLogger;
