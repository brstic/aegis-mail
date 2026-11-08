import { DEMO_ACCOUNTS, DEMO_INCOMING, DEMO_MESSAGES, mime, type DemoSeedMessage } from "@aegis/test-fixtures";
import { randomUUID } from "node:crypto";
import { hash } from "@node-rs/argon2";
import { connectAccount } from "./accounts";
import { audit } from "./audit";
import { createWorkspace } from "./auth";
import { AppError, type Ctx, type Platform } from "./context";
import { createAutomation } from "./automations";
import { enqueue } from "./jobs";
import { updatePrefs } from "./prefs";
import { drainJobs } from "./worker";

export const DEMO_LOGIN = { email: "morgan@demo.aegis.example", password: "demo-password-not-secret", name: "Morgan Lee" };
/** A synthetic platform operator. Refused outside demo mode, whatever the database says. */
export const DEMO_OPERATOR = { email: "operator@demo.aegis.example", password: "demo-password-not-secret", name: "Demo Operator" };
/** A second synthetic tenant, for the operator screens to act on without disturbing the main demo workspace. */
export const DEMO_SECOND_OWNER = { email: "avery@demo.aegis.example", password: "demo-password-not-secret", name: "Avery Stone" };
export const DEMO_ADMIN = { email: "riley@demo.aegis.example", password: "demo-password-not-secret", name: "Riley Chen" };

async function insertDemo(p: Platform, ctx: Ctx, accountId: string, m: { hoursAgo: number; folder?: string; read?: boolean; starred?: boolean; input: DemoSeedMessage["input"] }) {
  const when = new Date(p.now().getTime() - m.hoursAgo * 36e5);
  const raw = Buffer.from(mime({ ...m.input, date: when.toUTCString() }));
  const tenantId = ctx.tenantId;
  await p.db.withUser(ctx, t => t.query("INSERT INTO demo_mailbox(account_id,tenant_id,remote_id,internal_date,raw,folder_role,is_read,is_starred) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [accountId, tenantId, `demo-${randomUUID()}`, when, raw, m.folder ?? "inbox", m.read ?? false, m.starred ?? false]));
}

/** Idempotent. Real pipeline over synthetic mail: seeds the store, then syncs through the DemoAdapter. */
export async function seedDemo(p: Platform) {
  if (!p.config.demoMode) throw new AppError(409, "not_demo", "Seeding is only for demo mode.");
  await seedDemoOperator(p);
  const existing = await p.db.withSystem(t => t.one<{ id: string }>("SELECT id FROM users WHERE lower(email)=$1", [DEMO_LOGIN.email]));
  if (existing) {
    // A database seeded before address verification existed.
    await p.db.withSystem(t => t.query("UPDATE users SET email_verified_at=COALESCE(email_verified_at, now()) WHERE lower(email) IN ($1,$2)", [DEMO_LOGIN.email, DEMO_ADMIN.email]));
    return { created: false };
  }
  const pw = await hash(DEMO_LOGIN.password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
  const ids = await p.db.withSystem(async t => {
    const u = await t.one<{ id: string }>("INSERT INTO users(email,name,password_hash,email_verified_at) VALUES ($1,$2,$3,now()) RETURNING id", [DEMO_LOGIN.email, DEMO_LOGIN.name, pw]);
    const a = await t.one<{ id: string }>("INSERT INTO users(email,name,password_hash,email_verified_at) VALUES ($1,$2,$3,now()) RETURNING id", [DEMO_ADMIN.email, DEMO_ADMIN.name, pw]);
    const tenantId = await createWorkspace(t, u!.id, "organization", "Fernhill Studio (demo)");
    await t.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES ($1,$2,'security_admin')", [tenantId, a!.id]);
    return { userId: u!.id, adminId: a!.id, tenantId };
  });
  const ctx: Ctx = { tenantId: ids.tenantId, userId: ids.userId };
  const accountIds: Record<string, string> = {};
  for (const [key, a] of Object.entries(DEMO_ACCOUNTS)) {
    accountIds[key] = await connectAccount(p, ctx, { kind: "demo", email: a.email, displayName: a.displayName, color: a.color, isPrimary: a.primary, credential: { kind: "demo" }, settings: { simulated: a.simulated } });
  }
  // Insert oldest first so relationship history builds up the way it would in a real mailbox.
  for (const m of [...DEMO_MESSAGES].sort((x, y) => y.hoursAgo - x.hoursAgo)) await insertDemo(p, ctx, accountIds[m.account]!, m);
  await p.db.withSystem(async t => { for (const id of Object.values(accountIds)) await enqueue(t, { tenantId: ids.tenantId, kind: "sync.account", payload: { accountId: id }, dedupeKey: `sync:${id}` }); });
  await drainJobs(p);
  await updatePrefs(p, ctx, { defaultView: "inbox", density: "comfortable", layout: "full", automationLevel: "assist" });
  await createAutomation(p, ctx, { name: "Bank detail changes: keep out of the inbox", enabled: false, definition: { trigger: "message.classified", match: "all", conditions: [{ type: "body_contains", terms: ["bank details", "banking details"] }], actions: [{ type: "hold" }] } });
  await p.db.withWorker(ids.tenantId, async t => {
    const work = accountIds.work!;
    for (const [name, color] of [["Clients", "#2f6f5e"], ["Finance", "#8a5a2b"], ["Later", "#4b5d8a"]]) await t.query("INSERT INTO mail_labels(tenant_id,account_id,name,color) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [ids.tenantId, work, name, color]);
    await audit(t, { tenantId: ids.tenantId, event: "account.sync_requested", meta: { outcome: "demo_seed" } });
  });
  return { created: true, ...ids };
}

/** Idempotent, and separate from the workspace seed so an already-seeded database gets it on the next `pnpm db:seed`. */
async function seedDemoOperator(p: Platform) {
  if (await p.db.withSystem(t => t.one("SELECT 1 FROM users WHERE lower(email)=$1", [DEMO_OPERATOR.email]))) return;
  const pw = await hash(DEMO_OPERATOR.password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
  await p.db.withSystem(async t => {
    const op = await t.one<{ id: string }>("INSERT INTO users(email,name,password_hash,email_verified_at) VALUES ($1,$2,$3,now()) RETURNING id", [DEMO_OPERATOR.email, DEMO_OPERATOR.name, pw]);
    await createWorkspace(t, op!.id, "personal", "Operator's own workspace (demo)");
    await t.query("SELECT op.cli_grant($1,'demo')", [op!.id]);
    const owner = await t.one<{ id: string }>("INSERT INTO users(email,name,password_hash,email_verified_at) VALUES ($1,$2,$3,now()) RETURNING id", [DEMO_SECOND_OWNER.email, DEMO_SECOND_OWNER.name, pw]);
    await createWorkspace(t, owner!.id, "organization", "Harbor Co (demo)");
  });
}

/** "Simulate new mail" control. Refuses outside demo mode. */
export async function simulateIncoming(p: Platform, ctx: Ctx, index?: number) {
  if (!p.config.demoMode) throw new AppError(409, "not_demo", "This is only available in demo mode.");
  const def = DEMO_INCOMING[(index ?? Math.floor(Math.random() * 1e6)) % DEMO_INCOMING.length]!;
  const email = DEMO_ACCOUNTS[def.account].email;
  const acct = await p.db.withUser(ctx, t => t.one<{ id: string; kind: string }>("SELECT id, kind FROM mail_accounts WHERE email=$1", [email]));
  if (!acct || acct.kind !== "demo") throw new AppError(404, "not_found", "Demo mailbox not found. It may have been disconnected.");
  await insertDemo(p, ctx, acct.id, { hoursAgo: 0, input: def.input });
  await p.db.withSystem(t => enqueue(t, { tenantId: ctx.tenantId, kind: "sync.account", payload: { accountId: acct.id }, dedupeKey: `sync:${acct.id}` }));
  return { accountId: acct.id };
}
