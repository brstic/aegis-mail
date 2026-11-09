import { CAPABILITIES, type ProviderKind } from "@aegis/domain";
import { audit } from "./audit";
import { badRequest, type Ctx, forbidden, type Platform } from "./context";
import { disconnectAccount } from "./accounts";
import { getThread } from "./mail";
import { getPrefs } from "./prefs";
import { providerFor } from "./ai-service";
import { hostedModelName } from "./ai-usage";
import { reauthenticate } from "./auth";
import { recordErasure } from "./deletion-log";
import { accountMemberships, eraseAccount, type ErasureScope, tombstoneAndPurge } from "./erasure";
import { enqueue } from "./jobs";

/** Reads actual configuration so the Privacy Center can't drift from reality. */
export async function privacyCenter(p: Platform, ctx: Ctx) {
  const prefs = await getPrefs(p, ctx);
  const provider = await providerFor(p, ctx);
  const data = await p.db.withUser(ctx, async t => ({
    org: await t.one<any>("SELECT privacy_mode, kind FROM organizations WHERE id=$1", [ctx.tenantId]),
    accounts: await t.query<any>("SELECT a.id, a.kind, a.email, a.display_name, a.read_only, a.status, a.settings, g.scopes, g.provider, g.granted_at FROM mail_accounts a LEFT JOIN oauth_grants g ON g.account_id=a.id WHERE a.status<>'disconnected'"),
    policy: await t.one<any>("SELECT retention_days, policy FROM tenant_policies WHERE tenant_id=$1", [ctx.tenantId]),
    keys: await t.query<any>("SELECT key_class, max(version) version, min(kms_id) kms FROM tenant_keys WHERE tenant_id=$1 GROUP BY key_class", [ctx.tenantId]),
    indexed: await t.one<{ c: number }>("SELECT count(*)::int c FROM message_search"),
    vectors: await t.one<{ c: number }>("SELECT count(*)::int c FROM message_embeddings"),
    sealed: await t.one<{ c: number }>("SELECT count(*)::int c FROM message_contents WHERE sealed_blob IS NOT NULL"),
  }));
  const hostedConfigured = !!p.config.ai;
  // Security review uses the server's hosted model for every mailbox. Only the workspace-wide switch turns it off.
  const reviewModel = p.config.ai && data.policy?.policy?.hostedModelsDisabled !== true ? hostedModelName(p.config.ai) : null;
  const reviewProvider = p.config.ai?.provider === "anthropic" ? "Anthropic" : "OpenAI";
  const clamd = !!p.config.clamd;
  return {
    mode: {
      id: "managed", name: "Managed processing", claim: "Content-blind administration with controlled server-side processing",
      plain: "Your mail is decrypted in memory on our servers so it can be scanned and organized. It's stored encrypted. Administrators, including your own organization's, have no feature that shows mail content. This isn't zero-knowledge: someone who controls production servers and code could change the software to read mail.",
      notClaimed: ["Zero knowledge or zero access", "End-to-end encryption of ordinary email", "Protection from your mail provider, which can still read your mail"],
    },
    processors: [
      { name: "Application servers", purpose: "Rendering and API", plaintext: true, condition: "While you use the app" },
      { name: "Background workers", purpose: "Fetch, scan, classify", plaintext: true, condition: "Always, while a mailbox is connected" },
      { name: "PostgreSQL database", purpose: "Storage", plaintext: false, condition: prefs.serverSearchEnabled === false ? "Bodies, subjects and participants are encrypted" : "Bodies, subjects and participants are encrypted, apart from the search index", caveat: prefs.serverSearchEnabled === false ? "Search index turned off" : `Words from subjects and bodies, and sender and recipient addresses, are stored unencrypted for ${data.indexed?.c ?? 0} messages, readable by anyone with raw database access. You can turn this off.` },
      { name: "Embedding model on this server", purpose: "Semantic search", plaintext: !!p.embeddings && prefs.serverSearchEnabled !== false && prefs.semanticSearchEnabled !== false, condition: !p.embeddings ? "Not enabled on this deployment" : prefs.serverSearchEnabled === false || prefs.semanticSearchEnabled === false ? "Off for your account" : "Reads each message's subject and opening text on this server. Nothing is sent to a model provider", caveat: p.embeddings ? `${data.vectors?.c ?? 0} vectors stored, encrypted like message bodies. They're opened in memory to answer a search.` : undefined },
      { name: "Malware scanner (clamd)", purpose: "Attachment scanning", plaintext: clamd, condition: clamd ? "Runs on attachments" : "Not configured. Attachments only get baseline checks and aren't reported as virus-free." },
      { name: "Transactional mail relay", purpose: "Verification, password reset and invitation email, and the digest if you turn it on", plaintext: p.mailer?.kind === "smtp", condition: p.mailer?.kind === "smtp" ? "Sees the recipient and those messages, which never contain your mail" : p.mailer ? "Not in use: mail is only recorded on this deployment" : "Not configured on this deployment" },
      { name: "Hosted AI model", purpose: "Security review of incoming mail", plaintext: !!reviewModel, condition: reviewModel ? `Active for every mailbox on this server: ${reviewModel}, run by ${reviewProvider}. It reads each message's text and what was found inside its attachments` : hostedConfigured ? "Turned off for this workspace by its administrators" : "Not configured on this deployment" },
      { name: "Hosted AI model", purpose: "Summaries, drafts", plaintext: provider.hosted, condition: provider.hosted ? `Active: ${provider.model}` : hostedConfigured ? "Available, but off until you turn it on" : "Not configured on this deployment" },
    ],
    keys: { provider: p.kms.id, productionSafe: p.kms.productionSafe, classes: data.keys.map((k: any) => ({ class: k.key_class, version: Number(k.version) })), recovery: "Keys are managed by the service, so we can restore access after you lose a password. That's also why this isn't zero-access.", warning: p.kms.productionSafe ? null : "Development key store in use. Not for production." },
    model: { id: provider.id, model: provider.model, hosted: provider.hosted, hostedConfigured, consent: prefs.hostedModelConsent === true, securityReview: reviewModel ? { model: reviewModel, provider: reviewProvider } : null, training: "Your email is never used to train models by this product.", retention: provider.hosted || reviewModel ? "Governed by the model provider's API terms. Verify your own agreement." : "Nothing leaves this deployment." },
    connections: data.accounts.map((a: any) => ({ id: a.id, kind: a.kind, email: a.email, displayName: a.display_name, readOnly: a.read_only, status: a.status, simulated: a.settings?.simulated ?? null, credential: CAPABILITIES[a.kind as ProviderKind].oauth ? "OAuth token" : a.kind === "demo" ? "Synthetic, no credential" : "App password", scopes: a.scopes ?? [], grantedAt: a.granted_at, limitations: CAPABILITIES[a.kind as ProviderKind].limitations, revokeSupported: CAPABILITIES[a.kind as ProviderKind].revokeSupported })),
    region: p.config.region ?? null,
    controls: { summariesEnabled: prefs.summariesEnabled !== false, topicsEnabled: prefs.topicsEnabled !== false, storeAttachments: prefs.storeAttachments !== false, aiEnabled: prefs.aiEnabled !== false, personalizationEnabled: prefs.personalizationEnabled !== false, hostedModelConsent: prefs.hostedModelConsent === true, serverSearchEnabled: prefs.serverSearchEnabled !== false, semanticSearchEnabled: prefs.semanticSearchEnabled !== false },
    retention: { days: data.policy?.retention_days ?? null, plain: data.policy?.retention_days ? `Cached messages are deleted after ${data.policy.retention_days} days.` : "Cached messages are kept while the mailbox is connected, then deleted when you disconnect and choose to delete." },
    sealedCount: data.sealed?.c ?? 0,
    review: { status: "No independent review completed", certifications: [] as string[], note: "No SOC 2, ISO 27001 or penetration test has been completed. We'll list them here only once they're real." },
    admins: "Administrators can see aggregate security counts and policy changes. No admin screen, API or database role shows message content.",
    origin: "Gmail, Outlook, iCloud and other mail providers keep their own access to your mail. This product can't change that.",
  };
}

/** Export of what this user can see: portable JSON. */
export async function exportData(p: Platform, ctx: Ctx) {
  const threads = await p.db.withUser(ctx, t => t.query<any>("SELECT DISTINCT COALESCE(thread_id,id) id FROM messages WHERE tombstoned_at IS NULL AND envelope_enc IS NOT NULL LIMIT 5000"));
  const out = [];
  for (const th of threads) {
    const full = await getThread(p, ctx, th.id).catch(() => null);
    if (full) out.push({ subject: full.subject, account: full.account.email, messages: full.messages.map(m => ({ from: m.from, to: m.to, date: m.date, subject: m.subject, text: m.text, security: m.security?.label })) });
  }
  await p.db.withUser(ctx, t => audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: "data.exported", meta: { count: out.length } }));
  return { exportedAt: p.now().toISOString(), threads: out };
}

/** Re-authenticates, then disconnects everything in every workspace, removes the user, and shreds personal workspaces' keys. */
export async function deleteAccount(p: Platform, ctx: Ctx, input: { confirmEmail: string; email: string; password: string; totp?: string }) {
  if (input.confirmEmail.toLowerCase() !== input.email.toLowerCase()) throw badRequest("confirm_mismatch", "Type your email address to confirm.");
  await reauthenticate(p, ctx, input.password, input.totp);
  const memberships = await accountMemberships(p.db, ctx.userId);
  // Check every workspace first, so this can't half-finish.
  for (const m of memberships.filter(x => x.kind === "organization" && x.role === "owner")) {
    const others = await p.db.withSystem(t => t.one<{ c: number }>("SELECT count(*)::int c FROM memberships WHERE tenant_id=$1 AND role='owner' AND user_id<>$2", [m.tenant_id, ctx.userId]));
    if (!others?.c) throw forbidden("Make someone else an owner of each organization you own before deleting your account.");
  }
  await eraseAccount(liveErasureScope(p), ctx.userId);
}

/** In the owner's own request context. Revocation needs the credential, so it and the key destruction wait for the worker. */
function liveErasureScope(p: Platform): ErasureScope {
  return {
    db: p.db,
    tenantTx: (c, fn) => p.db.withUser(c, fn),
    eraseMailbox: async (c, accountId) => { await disconnectAccount(p, c, accountId, { deleteData: true }); },
    inScrub: async (t, personalTenants, userId) => {
      // Runs in the worker after revocations, which need the credential key.
      for (const tenantId of personalTenants) await enqueue(t, { tenantId, kind: "tenant.shred" });
      await recordErasure(t, { kind: "account", userId });
    },
  };
}

/** Enforces retention: bodies, search words and everything derived go. Tombstones remain so sync doesn't resurrect them. */
export async function retentionSweep(p: Platform, tenantId: string) {
  return p.db.withWorker(tenantId, async t => {
    const pol = await t.one<any>("SELECT retention_days FROM tenant_policies WHERE tenant_id=$1", [tenantId]);
    if (!pol?.retention_days) return 0;
    const r = await tombstoneAndPurge(t, "tenant_id=$1 AND internal_date < now() - ($2::int * interval '1 day') AND tombstoned_at IS NULL", [tenantId, pol.retention_days]);
    for (const m of r) await recordErasure(t, { kind: "message_purged", tenantId, accountId: m.account_id, messageId: m.id });
    return r.length;
  });
}
