import { CAPABILITIES, type MailAdapter, type ProviderKind } from "@aegis/domain";
import type { Tx } from "@aegis/db";
import { randomToken } from "@aegis/cryptography";
import { createHash } from "node:crypto";
import { audit } from "./audit";
import { errorCode } from "./log";
import { AppError, badRequest, type AccountRow, type Ctx, notFound, type Platform, type StoredCredential } from "./context";
import { recordErasure } from "./deletion-log";
import { DemoAdapter } from "./demo-adapter";
import { destroyCredential, eraseMailboxContent } from "./erasure";
import { cancelJobs, enqueue } from "./jobs";

const credCtx = (a: { tenant_id: string; id: string }) => ({ tenantId: a.tenant_id, keyClass: "credential" as const, table: "credential_envelopes", recordId: a.id });
const COLORS = ["#2f6f5e", "#4b5d8a", "#8a5a2b", "#7a4a7a", "#3f7a8a", "#8a4b4b"];

export async function publicAccounts(p: Platform, ctx: Ctx) {
  return p.db.withUser(ctx, async t => {
    const rows = await t.query<any>(
      `SELECT a.*, s.phase, s.last_success_at, s.last_attempt_at, s.last_error_code, s.messages_synced,
        (SELECT count(*)::int FROM messages m WHERE m.account_id=a.id AND m.folder_role='inbox' AND NOT m.is_read AND NOT m.held AND m.tombstoned_at IS NULL) unread, app.can_send_account(a.id) can_send
       FROM mail_accounts a LEFT JOIN sync_states s ON s.account_id=a.id ORDER BY a.is_primary DESC, a.created_at`);
    return rows.map(a => ({
      id: a.id, kind: a.kind as ProviderKind, email: a.email, displayName: a.display_name, color: a.color, isPrimary: a.is_primary, status: a.status, statusDetail: a.status_detail,
      readOnly: a.read_only, simulated: a.settings?.simulated ?? null, unread: a.unread, owned: a.owner_user_id === ctx.userId, canSend: a.can_send, aliases: (a.settings?.aliases ?? []) as { address: string; name?: string }[],
      sync: { phase: a.phase ?? "initial", lastSuccessAt: a.last_success_at, lastAttemptAt: a.last_attempt_at, lastError: a.last_error_code, messagesSynced: a.messages_synced ?? 0 },
      capabilities: CAPABILITIES[a.kind as ProviderKind],
    }));
  });
}

/** Creates the account row and credential. Credential is write-only for this role: it can't be read back here. */
export async function connectAccount(p: Platform, ctx: Ctx, input: { kind: ProviderKind; email: string; displayName: string; readOnly?: boolean; credential: StoredCredential; settings?: Record<string, unknown>; color?: string; isPrimary?: boolean; scopes?: string[] }): Promise<string> {
  if (input.kind === "demo" && !p.config.demoMode) throw badRequest("demo_disabled", "Demo mailboxes aren't available here.");
  const existing = await p.db.withUser(ctx, t => t.query<any>("SELECT id, status FROM mail_accounts WHERE kind=$1 AND lower(email)=lower($2) AND owner_user_id=$3", [input.kind, input.email, ctx.userId]));
  const count = await p.db.withUser(ctx, t => t.one<{ c: number }>("SELECT count(*)::int c FROM mail_accounts WHERE status<>'disconnected'"));
  const id = existing[0]?.id as string | undefined;
  const accountId = id ?? (await p.db.withUser(ctx, t => t.one<{ id: string }>(
    `INSERT INTO mail_accounts(tenant_id,owner_user_id,kind,email,display_name,color,is_primary,read_only,status,settings) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9) RETURNING id`,
    [ctx.tenantId, ctx.userId, input.kind, input.email.toLowerCase(), input.displayName, input.color ?? COLORS[(count?.c ?? 0) % COLORS.length], input.isPrimary ?? (count?.c ?? 0) === 0, input.readOnly ?? false, JSON.stringify(input.settings ?? {})])))!.id;
  const blob = await p.envelope.sealJson({ tenantId: ctx.tenantId, keyClass: "credential", table: "credential_envelopes", recordId: accountId }, input.credential);
  await p.db.withUser(ctx, async t => {
    // A definer function does the swap, so this role never gains read access to envelopes.
    await t.query("SELECT app.replace_credential($1,$2,$3)", [accountId, input.credential.kind ?? "password", blob]);
    if (id) await t.query("UPDATE mail_accounts SET status='active', status_detail=NULL, read_only=$2, settings=settings || $3::jsonb WHERE id=$1", [accountId, input.readOnly ?? false, JSON.stringify(input.settings ?? {})]);
    await t.query("INSERT INTO sync_states(account_id,tenant_id) VALUES ($1,$2) ON CONFLICT (account_id) DO UPDATE SET phase = CASE WHEN sync_states.cursor_enc IS NULL THEN 'initial' ELSE sync_states.phase END, consecutive_failures=0, last_error_code=NULL", [accountId, ctx.tenantId]);
    if (input.scopes) await t.query("INSERT INTO oauth_grants(account_id,tenant_id,provider,scopes) VALUES ($1,$2,$3,$4) ON CONFLICT (account_id) DO UPDATE SET scopes=$4, granted_at=now()", [accountId, ctx.tenantId, input.kind, input.scopes]);
    await audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: "account.connected", targetType: "account", targetId: accountId, meta: { provider: input.kind, scopes: input.scopes } });
  });
  await p.db.withSystem(t => enqueue(t, { tenantId: ctx.tenantId, kind: "sync.account", payload: { accountId }, dedupeKey: `sync:${accountId}` }));
  return accountId;
}

export async function loadAccount(t: Tx, accountId: string) { return t.one<AccountRow>("SELECT * FROM mail_accounts WHERE id=$1", [accountId]); }

/** Worker-only: decrypts the credential. */
export async function adapterFor(p: Platform, tenantId: string, accountId: string): Promise<{ adapter: MailAdapter; account: AccountRow }> {
  const { account, row } = await p.db.withWorker(tenantId, async t => ({ account: await loadAccount(t, accountId), row: await t.one<any>("SELECT blob FROM credential_envelopes WHERE account_id=$1", [accountId]) }));
  if (!account) throw new AppError(404, "account_missing", "Account not found");
  const credential = row ? await p.envelope.openJson<StoredCredential>(credCtx(account), row.blob) : null;
  if (p.adapterFactory) return { account, adapter: await p.adapterFactory(account, credential, p) };
  if (account.kind === "demo") return { account, adapter: new DemoAdapter(p, account) };
  if (!credential) throw new AppError(409, "no_credential", "No credential on file");
  const { createAdapter } = await import("@aegis/mail-adapters");
  const adapter = createAdapter(account.kind as "gmail", { email: account.email, readOnly: account.read_only }, credential as never, {
    oauth: oauthConfig(p),
    fetch: p.fetch,
    onCredentialUpdate: async c => {
      const blob = await p.envelope.sealJson(credCtx(account), c);
      await p.db.withWorker(tenantId, t => t.query("UPDATE credential_envelopes SET blob=$2, updated_at=now() WHERE account_id=$1", [accountId, blob]));
    },
    gmailPubsubTopic: p.config.google?.pubsubTopic,
    graphWebhookUrl: p.config.microsoft?.webhookUrl,
    graphClientState: account.settings?.graphClientState,
  });
  return { account, adapter };
}

export function oauthConfig(p: Platform) {
  return { gmail: p.config.google ? { clientId: p.config.google.clientId, clientSecret: p.config.google.clientSecret } : undefined, microsoft: p.config.microsoft ? { clientId: p.config.microsoft.clientId, clientSecret: p.config.microsoft.clientSecret } : undefined };
}

/** Only accessible to the owner. A grantee can't rename, pause or remove someone else's mailbox. */
async function ownedAccount(t: Tx, ctx: Ctx, accountId: string) {
  const a = await loadAccount(t, accountId);
  if (!a) throw notFound();
  if (a.owner_user_id !== ctx.userId) throw new AppError(403, "forbidden", "Only the mailbox owner can do this.");
  return a;
}

export async function updateAccount(p: Platform, ctx: Ctx, accountId: string, patch: { displayName?: string; color?: string; isPrimary?: boolean; paused?: boolean; aliases?: { address: string; name?: string }[] }) {
  await p.db.withUser(ctx, async t => {
    await ownedAccount(t, ctx, accountId);
    if (patch.isPrimary) await t.query("UPDATE mail_accounts SET is_primary=false WHERE owner_user_id=$1", [ctx.userId]);
    await t.query(
      `UPDATE mail_accounts SET display_name=COALESCE($2,display_name), color=COALESCE($3,color), is_primary=COALESCE($4,is_primary),
       status = CASE WHEN $5::boolean IS TRUE AND status='active' THEN 'paused' WHEN $5::boolean IS FALSE AND status='paused' THEN 'active' ELSE status END WHERE id=$1`,
      [accountId, patch.displayName ?? null, patch.color ?? null, patch.isPrimary ?? null, patch.paused ?? null]);
    // Send-as addresses. We can't verify them, so the worker sends from one only if it's still listed here, and the provider has the final say.
    if (patch.aliases) await t.query("UPDATE mail_accounts SET settings = settings || jsonb_build_object('aliases', $2::jsonb) WHERE id=$1", [accountId, JSON.stringify(patch.aliases)]);
  });
}

export async function requestSync(p: Platform, ctx: Ctx, accountId: string) {
  const a = await p.db.withUser(ctx, t => loadAccount(t, accountId));
  if (!a) throw notFound();
  await p.db.withSystem(async t => { await enqueue(t, { tenantId: ctx.tenantId, kind: "sync.account", payload: { accountId }, dedupeKey: `sync:${accountId}` }); });
  await p.db.withUser(ctx, t => audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: "account.sync_requested", targetType: "account", targetId: accountId }));
}

/**
 * Disconnect, web side. Sync stops and any requested deletion of cached mail happens now. Provider revocation needs the
 * credential, which this role can't read, so it runs as a worker job.
 */
export async function disconnectAccount(p: Platform, ctx: Ctx, accountId: string, opts: { deleteData: boolean }) {
  const a = await p.db.withUser(ctx, async t => {
    const acc = await ownedAccount(t, ctx, accountId);
    await t.query("UPDATE mail_accounts SET status='disconnected' WHERE id=$1", [accountId]);
    if (opts.deleteData) {
      // Now, not when the worker gets to it. The docs promise immediately.
      await eraseMailboxContent(t, accountId);
      await recordErasure(t, { kind: "mailbox", tenantId: ctx.tenantId, accountId });
    }
    await audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: "account.disconnected", targetType: "account", targetId: accountId, meta: { provider: acc.kind } });
    return acc;
  });
  await p.db.withSystem(async t => {
    await cancelJobs(t, accountId);
    await enqueue(t, { tenantId: ctx.tenantId, kind: "account.disconnect", payload: { accountId, reason: opts.deleteData ? "delete" : "keep" }, maxAttempts: 3 });
  });
  const cap = CAPABILITIES[a.kind as ProviderKind];
  return { revokeSupported: cap.revokeSupported, manualRevokeNeeded: !cap.revokeSupported, caps: cap.limitations };
}

/** Worker side. Revocation is best effort; the credential is destroyed regardless. */
export async function finishDisconnect(p: Platform, tenantId: string, accountId: string, deleteData: boolean) {
  const row = await p.db.withWorker(tenantId, t => t.one<any>("SELECT kind, status FROM mail_accounts WHERE id=$1", [accountId]));
  // Reconnected before this ran: the credential on file is the new one, and revoking it would break the fresh connection.
  if (!row || row.status !== "disconnected") return;
  const kind = row.kind;
  let revoked = false;
  try {
    const { adapter } = await adapterFor(p, tenantId, accountId);
    await adapter.stopPush?.().catch(() => {});
    revoked = await adapter.revoke();
    await adapter.close?.();
  } catch { /* The user is told how to finish at the provider. */ }
  await p.db.withWorker(tenantId, async t => {
    await destroyCredential(t, accountId);
    if (deleteData) await t.query("DELETE FROM mail_accounts WHERE id=$1", [accountId]);
    // Removing a member gets here without the web path, so this is what records it. Recording the same mailbox twice is one entry.
    await recordErasure(t, { kind: deleteData ? "mailbox" : "credential", tenantId, accountId });
    await audit(t, { tenantId, event: "token.revoked", targetType: "account", targetId: accountId, meta: { provider: kind, outcome: revoked ? "revoked" : "manual_revoke_needed" } });
    if (deleteData) await audit(t, { tenantId, event: "data.deleted", targetType: "account", targetId: accountId, meta: { kind: "mailbox" } });
  });
}

// ---------- OAuth mailbox authorization (separate from product login) ----------
const stateHash = (s: string) => createHash("sha256").update(s).digest("hex");

export async function beginMailboxOAuth(p: Platform, ctx: Ctx, provider: "gmail" | "microsoft", opts: { readOnly: boolean; loginHint?: string }) {
  const configured = provider === "gmail" ? p.config.google : p.config.microsoft;
  if (!configured) throw new AppError(503, "provider_not_configured", `${provider === "gmail" ? "Google" : "Microsoft"} connections aren't configured on this deployment.`);
  const { buildAuthorizationUrl, generatePkce } = await import("@aegis/mail-adapters");
  const state = randomToken(32);
  const pkce = await generatePkce();
  const verifierEnc = await p.envelope.seal({ tenantId: ctx.tenantId, keyClass: "credential", table: "oauth_flows", recordId: stateHash(state) }, pkce.codeVerifier);
  await p.db.withSystem(t => t.query("INSERT INTO oauth_flows(state_hash,user_id,tenant_id,provider,verifier_enc,read_only,expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + interval '10 minutes')", [stateHash(state), ctx.userId, ctx.tenantId, provider, verifierEnc, opts.readOnly]));
  const url = buildAuthorizationUrl(provider, { redirectUri: `${p.config.appOrigin}/api/v1/oauth/${provider}/callback`, state, codeChallenge: pkce.codeChallenge, readOnly: opts.readOnly, loginHint: opts.loginHint }, oauthConfig(p));
  return { url };
}

/** State binds the callback to the session that began it, which stops mailbox-swap and login-CSRF attacks. */
export async function finishMailboxOAuth(p: Platform, ctx: Ctx, provider: "gmail" | "microsoft", q: { state: string; code: string }) {
  const flow = await p.db.withSystem(t => t.one<any>("DELETE FROM oauth_flows WHERE state_hash=$1 AND provider=$2 AND expires_at>now() RETURNING *", [stateHash(q.state), provider]));
  if (!flow || flow.user_id !== ctx.userId || flow.tenant_id !== ctx.tenantId) throw badRequest("oauth_state_invalid", "That connection attempt expired or didn't start here. Try connecting again.");
  const verifier = (await p.envelope.open({ tenantId: ctx.tenantId, keyClass: "credential", table: "oauth_flows", recordId: stateHash(q.state) }, flow.verifier_enc)).toString("utf8");
  const { exchangeCode, userinfo } = await import("@aegis/mail-adapters");
  const redirectUri = `${p.config.appOrigin}/api/v1/oauth/${provider}/callback`;
  // expectedState is the value whose hash matched this session's flow row above.
  const cred = await exchangeCode(provider, { code: q.code, state: q.state, expectedState: q.state, codeVerifier: verifier, redirectUri }, { config: oauthConfig(p), fetch: p.fetch });
  const email = await userinfo(provider, cred.accessToken, { fetch: p.fetch });
  const accountId = await connectAccount(p, ctx, { kind: provider, email, displayName: email, readOnly: flow.read_only, credential: { ...cred, kind: "oauth", provider }, scopes: cred.scopes });
  // The provider just proved who owns this address. If it's the sign-in address, that's the verification.
  const { verifyByConnectedMailbox } = await import("./identity");
  await verifyByConnectedMailbox(p, ctx, provider, email).catch(e => p.log.warn("auth.mailbox_verify_failed", { errorCode: errorCode(e) }));
  return accountId;
}
