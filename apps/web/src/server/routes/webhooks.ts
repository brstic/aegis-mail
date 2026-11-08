import { AppError, handleGmailPush, handleGraphNotifications } from "@aegis/platform";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { platform } from "../platform";
import { readLimited, type RouteDef } from "../router";

const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

/** Webhooks only ever cause a deduplicated sync. See ADR-0005. Content is fetched by the worker through the API. */
export const webhookRoutes: RouteDef[] = [
  { m: "POST", p: "/webhooks/gmail", auth: false, skipOrigin: true, h: async ({ req }) => {
    const p = platform();
    const audience = p.config.google?.pubsubAudience, sender = p.config.google?.pubsubServiceAccount;
    // Any Google service account can mint a token for any audience, so the sender must be pinned as well.
    if (!audience || !sender) throw new AppError(503, "not_configured", "Not configured");
    const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
    if (!token) throw new AppError(401, "unauthenticated", "Missing token");
    const { payload } = await jwtVerify(token, GOOGLE_JWKS, { audience, issuer: ["https://accounts.google.com", "accounts.google.com"] }).catch(() => { throw new AppError(401, "unauthenticated", "Invalid token"); });
    if (payload.email !== sender || payload.email_verified !== true) throw new AppError(401, "unauthenticated", "Invalid token");
    const { parseGmailPush } = await import("@aegis/mail-adapters");
    const parsed = parseGmailPush(JSON.parse(await readLimited(req, 64_000).catch(() => "null") || "null"));
    // Acknowledge malformed payloads so Pub/Sub doesn't redeliver them forever.
    if (parsed) await handleGmailPush(p, parsed.emailAddress);
    // The same answer either way, so this can't reveal whether an address is connected.
    return { ok: true };
  } },
  { m: "POST", p: "/webhooks/graph", auth: false, skipOrigin: true, h: async ({ req }) => {
    const { graphValidationResponse } = await import("@aegis/mail-adapters");
    const validation = graphValidationResponse(req.url);
    if (validation) return validation;
    let payload: { value?: { subscriptionId: string; clientState?: string; lifecycleEvent?: string }[] } | null = null;
    try { payload = JSON.parse(await readLimited(req, 1_000_000)); } catch { payload = null; }
    await handleGraphNotifications(platform(), Array.isArray(payload?.value) ? payload.value : []);
    return new Response(null, { status: 202 });
  } },
];
