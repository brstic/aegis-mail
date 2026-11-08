import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createTestDb, Db, ensureLogin } from "@aegis/db";
import { LocalDevKms } from "@aegis/cryptography";
import { auditLog, connectAccount, createPlatform, type Ctx, deletionLogTick, demoSession, DEMO_OPERATOR, drainJobs, enqueue, FileDeletionSink, getThread, limitsFor, grantOperator, listThreads, makeLogger, type Platform, resolveSession, seedDemo, signIn, signUp, startWorker, tick, requireOperator } from "../index";
import { mime } from "@aegis/test-fixtures";
import { webClient, type WebClient } from "./web-harness";

const CANARY = {
  subject: "CANARY-SUBJECT-ZX81", senderName: "CANARY-SENDER-NAME", sender: "canary-sender@canary-domain.test", body: "CANARY-BODY-TEXT-QQ", mailbox: "canary-mailbox@canary-tenant.test",
  mailboxName: "CANARY-MAILBOX-NAME", member: "canary-member@canary-tenant.test", memberName: "CANARY-MEMBER-NAME", ownerName: "CANARY-OWNER-NAME", owner: "canary-owner@canary-tenant.test", label: "CANARY-LABEL", anthropic: "CANARY-ANTHROPIC-KEY",
};
const PW = "correct-horse-battery";
const UUID0 = "00000000-0000-4000-8000-000000000000";

/** The operator API through the real dispatcher and real route module, on the real web login. */
describe("operator area through its routes", () => {
  let drop: () => Promise<void>, admin: Db, adminP: Platform, web: Platform, worker: Platform, webDb: Db, workerDb: Db, client: WebClient;
  let owner: Ctx & { token: string }, member: Ctx & { token: string }, operator: { token: string; userId: string }, acct: string, threadId: string;
  const OPS = "ops@service.example";

  const allRoutes = () => client.routes.operator!;
  const pathFor = (r: { p: string }) => r.p.replace(":id", UUID0);
  const as = (token: string | null) => ({
    get: (path: string) => client.call("GET", `/operator${path}`, { token }),
    post: (path: string, body: unknown = {}) => client.call("POST", `/operator${path}`, { token, body }),
  });

  beforeAll(async () => {
    const t = await createTestDb("opweb"); admin = t.db; drop = t.drop;
    await ensureLogin(t.url, "aegis_web_login", "aegis_web_conn");
    await ensureLogin(t.url, "aegis_worker_login", "aegis_worker_conn");
    const login = (l: string) => { const u = new URL(t.url); u.username = l; return u.toString(); };
    webDb = new Db(login("aegis_web_login"), 5, { keyRole: "aegis_app" });
    workerDb = new Db(login("aegis_worker_login"), 5, { keyRole: "aegis_worker" });
    const kms = new LocalDevKms(randomBytes(32));
    const shared = { kms, config: { demoMode: true, appOrigin: "http://localhost:3000", webauthnRpId: "localhost", anthropicApiKey: CANARY.anthropic }, log: makeLogger(() => {}), env: {} };
    web = createPlatform({ db: webDb, ...shared });
    worker = createPlatform({ db: workerDb, ...shared });
    adminP = createPlatform({ db: admin, ...shared });
    client = await webClient(web, ["operator", "auth", "org"]);

    const s = await signUp(web, { email: CANARY.owner, password: PW, name: CANARY.ownerName, workspaceKind: "organization", workspaceName: "Neutral Tenant" });
    owner = { tenantId: s.tenantId, userId: s.userId, sessionId: s.sessionId, token: s.token };
    const m = await signUp(web, { email: CANARY.member, password: PW, name: CANARY.memberName, workspaceKind: "personal" });
    await admin.withSystem(q => q.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES ($1,$2,'member')", [owner.tenantId, m.userId]));
    await admin.withSystem(q => q.query("UPDATE sessions SET active_tenant_id=$2 WHERE id=$1", [m.sessionId, owner.tenantId]));
    member = { tenantId: owner.tenantId, userId: m.userId, sessionId: m.sessionId, token: m.token };
    const o = await signUp(web, { email: OPS, password: PW, name: "Ops Person", workspaceKind: "personal" });
    await admin.withSystem(q => q.query("UPDATE users SET email_verified_at=now() WHERE id=$1", [o.userId]));
    await grantOperator(adminP, OPS, "cli");
    operator = { token: o.token, userId: o.userId };

    // A mailbox full of things an operator must never see.
    acct = await connectAccount(web, owner, { kind: "demo", email: CANARY.mailbox, displayName: CANARY.mailboxName, credential: { kind: "demo" } });
    await webDb.withUser(owner, q => q.query("INSERT INTO demo_mailbox(account_id,tenant_id,remote_id,internal_date,raw) VALUES ($1,$2,'m1',now(),$3)", [acct, owner.tenantId, Buffer.from(mime({ from: `"${CANARY.senderName}" <${CANARY.sender}>`, subject: CANARY.subject, text: `${CANARY.body} Can you review?` }))]));
    await drainJobs(worker);
    threadId = (await listThreads(web, owner, { view: "inbox", limit: 5 })).items[0]!.id;
  });
  afterAll(async () => { await webDb.close(); await workerDb.close(); await drop(); });

  describe("who gets in", () => {
    const expectHidden = async (r: { status: number; json: any }, label: string) => {
      expect(r.status, label).toBe(404);
      expect(r.json, label).toEqual({ error: { code: "not_found", message: "Not found" } });
    };
    it("every route 404s for a tenant owner, with the same body as a path that doesn't exist", async () => {
      expect(allRoutes().length).toBeGreaterThanOrEqual(12);
      const missing = await client.call("GET", "/operator/no-such-route", { token: owner.token });
      await expectHidden(missing, "control");
      for (const r of allRoutes()) await expectHidden(await client.call(r.m, pathFor(r), { token: owner.token, ...(r.m === "GET" ? {} : { body: { reason: "a reason", key: "accounts", value: 5, until: new Date(Date.now() + 86400000).toISOString() } }) }), `${r.m} ${r.p}`);
    });
    it("every route 404s for a member, and with no session at all", async () => {
      for (const token of [member.token, null]) {
        for (const r of allRoutes()) await expectHidden(await client.call(r.m, pathFor(r), { token, ...(r.m === "GET" ? {} : { body: {} }) }), `${token ? "member" : "anon"} ${r.m} ${r.p}`);
      }
    });
    it("bad input from a non-operator is still a 404, so it can't be used to find routes", async () => {
      await expectHidden(await client.call("POST", `/operator/tenants/${owner.tenantId}/suspend`, { token: owner.token, rawBody: "not json" }), "bad json");
      await expectHidden(await client.call("POST", `/operator/tenants/${owner.tenantId}/suspend`, { token: owner.token, body: { reason: "" } }), "short reason");
      await expectHidden(await client.call("GET", "/operator/jobs?state=nonsense", { token: owner.token }), "bad query");
    });
    it("owner actions really did nothing", async () => {
      expect(await admin.withSystem(q => q.query("SELECT 1 FROM tenant_suspensions"))).toEqual([]);
      expect(await admin.withSystem(q => q.query("SELECT 1 FROM tenant_limit_overrides"))).toEqual([]);
    });
    it("an operator gets through every route, and a cross-origin write doesn't", async () => {
      for (const r of allRoutes().filter(x => x.m === "GET")) {
        const res = await client.call("GET", pathFor(r), { token: operator.token });
        expect([200, 404], `${r.p}`).toContain(res.status);
        if (!r.p.includes(":id")) expect(res.status, r.p).toBe(200);
      }
      expect((await client.call("POST", `/operator/tenants/${owner.tenantId}/suspend`, { token: operator.token, body: { reason: "cross origin" }, origin: "https://evil.test" })).status).toBe(403);
      expect(await admin.withSystem(q => q.query("SELECT 1 FROM tenant_suspensions"))).toEqual([]);
    });
    it("outside demo mode, what opens the door is a second factor shown to this session, not one on the account", async () => {
      const s = await signUp(web, { email: "ops2@service.example", password: PW, name: "Ops2", workspaceKind: "personal" });
      await admin.withSystem(q => q.query("UPDATE users SET email_verified_at=now() WHERE id=$1", [s.userId]));
      await grantOperator(adminP, "ops2@service.example", "cli");
      const live = createPlatform({ db: webDb, kms: web.kms, config: { demoMode: false, appOrigin: "http://localhost:3000", webauthnRpId: "localhost" }, log: makeLogger(() => {}), env: {} });
      const session = { userId: s.userId, sessionId: s.sessionId };
      await expect(requireOperator(live, session)).rejects.toMatchObject({ status: 404 });
      await admin.withSystem(q => q.query("UPDATE users SET totp_enabled=true WHERE id=$1", [s.userId]));
      await expect(requireOperator(live, session)).rejects.toMatchObject({ status: 404 });
      await admin.withSystem(q => q.query("UPDATE sessions SET auth_method='passkey' WHERE id=$1", [s.sessionId]));
      await expect(requireOperator(live, session)).rejects.toMatchObject({ status: 404 });
      await admin.withSystem(q => q.query("UPDATE sessions SET mfa_passed=true WHERE id=$1", [s.sessionId]));
      await expect(requireOperator(live, session)).resolves.toBeTruthy();
    });
    it("a demo-seeded operator is refused outside demo mode, even with MFA", async () => {
      const q = await createTestDb("opdemo");
      try {
        const kms = new LocalDevKms(randomBytes(32));
        const demo = createPlatform({ db: q.db, kms, config: { demoMode: true, appOrigin: "http://localhost:3000", webauthnRpId: "localhost" }, log: makeLogger(() => {}), env: {} });
        await seedDemo(demo);
        const s = await demoSession(demo, DEMO_OPERATOR.email);
        const info = await resolveSession(demo, s.token);
        await expect(requireOperator(demo, info)).resolves.toBeTruthy();
        await q.db.withSystem(t => t.query("UPDATE users SET totp_enabled=true WHERE lower(email)=$1", [DEMO_OPERATOR.email]));
        const live = createPlatform({ db: q.db, kms, config: { demoMode: false, appOrigin: "http://localhost:3000", webauthnRpId: "localhost" }, log: makeLogger(() => {}), env: {} });
        await expect(requireOperator(live, info)).rejects.toMatchObject({ status: 404 });
        // Seeding twice adds nothing, and the extra demo tenant exists for the console to act on.
        await seedDemo(demo);
        expect((await q.db.withSystem(t => t.query("SELECT 1 FROM users WHERE lower(email)=$1", [DEMO_OPERATOR.email]))).length).toBe(1);
        expect((await q.db.withSystem(t => t.query("SELECT 1 FROM organizations WHERE name='Harbor Co (demo)'"))).length).toBe(1);
      } finally { await q.drop(); }
    }, 180_000);
  });

  describe("screens", () => {
    it("overview: counts by provider and status, and the queue", async () => {
      const r = (await as(operator.token).get("/overview")).json;
      expect(r.mailboxes).toContainEqual({ provider: "demo", status: "active", count: 1 });
      expect(r.users.total).toBeGreaterThanOrEqual(3);
      expect(r.sync.mailboxes).toBeGreaterThanOrEqual(1);
      expect(Object.keys(r).sort()).toEqual(["mailboxes", "queue", "sync", "tenants", "users"]);
    });
    it("tenant list and detail have counts and no member or mailbox details", async () => {
      const list = (await as(operator.token).get("/tenants?search=neutral")).json;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: owner.tenantId, name: "Neutral Tenant", kind: "organization", members: 2, mailboxes: 1 });
      expect(Object.keys(list[0]).sort()).toEqual(["createdAt", "id", "kind", "mailboxes", "members", "name", "suspendedAt"]);
      const d = (await as(operator.token).get(`/tenants/${owner.tenantId}`)).json;
      expect(d.tenant).toMatchObject({ members: 2, mailboxes: 1 });
      expect(d.mailboxes).toEqual([{ provider: "demo", status: "active", count: 1 }]);
      expect(Object.keys(d.tenant).join()).not.toMatch(/email|owner/i);
      // No instance default and no override: no limit, said so for each one.
      expect(d.limits).toHaveLength(5);
      for (const l of d.limits) expect(l).toMatchObject({ value: null, instanceDefault: null, source: "none" });
    });
    it("a personal workspace's name, which holds a person's name by default, is replaced with a label", async () => {
      const personal = await signUp(web, { email: "named@tenant.example", password: PW, name: "Identifiable Person", workspaceKind: "personal" });
      const d = (await as(operator.token).get(`/tenants/${personal.tenantId}`)).json;
      expect(d.tenant.name).toBe("Personal workspace");
      expect((await as(operator.token).get("/tenants?search=Identifiable")).json).toEqual([]);
    });
    it("an unknown tenant is a 404 for an operator too", async () => {
      expect((await as(operator.token).get(`/tenants/${UUID0}`)).status).toBe(404);
    });
    it("health reports state and never a secret value", async () => {
      const q = createPlatform({ db: webDb, kms: web.kms, config: { ...web.config, limits: { accounts: 7 } }, log: makeLogger(() => {}), env: {} });
      const { operatorHealth } = await import("../operator");
      const h = await operatorHealth(q, { userId: operator.userId, __operator: true });
      expect(h).toMatchObject({ database: { ok: true }, kms: { type: expect.any(String) }, hostedAi: { configured: true }, limits: { instanceDefaults: { accounts: 7, seats: null } }, scanner: { configured: false, kind: "baseline" } });
      expect(JSON.stringify(h)).not.toMatch(/CANARY/);
    });
    it("health says the deletion log is configured only when a worker with a sink has said so, and never shows the path", async () => {
      expect((await as(operator.token).get("/health")).json.deletionLog).toMatchObject({ configured: false, ok: false, lastSeenAt: null });
      await deletionLogTick(worker); // This worker has no sink.
      expect((await as(operator.token).get("/health")).json.deletionLog.configured).toBe(false);
      const path = "/secret/mount/deletions.jsonl";
      await deletionLogTick(createPlatform({ db: worker.db, kms: worker.kms, config: worker.config, log: makeLogger(() => {}), env: {}, deletionSink: new FileDeletionSink(path) }));
      const h = (await as(operator.token).get("/health")).json;
      expect(h.deletionLog).toMatchObject({ configured: true, ok: true });
      expect(JSON.stringify(h)).not.toContain("secret/mount");
    });
    it("health sees the worker's heartbeat when one is running", async () => {
      const before = (await as(operator.token).get("/health")).json;
      expect(before.worker.ok).toBe(false);
      const w = startWorker(worker, { pollMs: 20, tickMs: 60_000, concurrency: 1 });
      await new Promise(r => setTimeout(r, 200));
      await w.stop();
      const after = (await as(operator.token).get("/health")).json;
      expect(after.worker.ok).toBe(true);
    });
  });

  describe("job queue", () => {
    it("shows kind and error code and nothing else from the job, and retries only dead jobs by ID", async () => {
      const id = await webDb.withSystem(async q => {
        const j = await enqueue(q, { tenantId: owner.tenantId, kind: "provider.change", payload: { accountId: acct, messageId: UUID0 } });
        await q.query("UPDATE jobs SET state='dead', last_error_code='grant_revoked', finished_at=now(), attempts=8 WHERE id=$1", [j]);
        return j!;
      });
      const list = (await as(operator.token).get("/jobs?state=dead")).json;
      const job = list.find((x: any) => x.id === id);
      expect(job).toMatchObject({ kind: "provider.change", errorCode: "grant_revoked", state: "dead" });
      expect(Object.keys(job).sort()).toEqual(["attempts", "createdAt", "errorCode", "finishedAt", "id", "kind", "maxAttempts", "state"]);
      expect(JSON.stringify(list)).not.toContain(acct);
      expect((await as(operator.token).post(`/jobs/${id}/retry`)).status).toBe(200);
      expect(await admin.withSystem(q => q.one<any>("SELECT state, attempts, last_error_code FROM jobs WHERE id=$1", [id]))).toEqual({ state: "queued", attempts: 0, last_error_code: null });
      expect((await as(operator.token).post(`/jobs/${id}/retry`)).status).toBe(409);
      await admin.withSystem(q => q.query("UPDATE jobs SET state='cancelled' WHERE id=$1", [id]));
    });
    it("a retry that would duplicate queued work says so", async () => {
      const [dead] = await admin.withSystem(q => q.query<{ id: string }>("INSERT INTO jobs(tenant_id,kind,dedupe_key,state) VALUES ($1,'sync.account','dup-key','dead') RETURNING id", [owner.tenantId]));
      await admin.withSystem(q => q.query("INSERT INTO jobs(tenant_id,kind,dedupe_key,state,run_at) VALUES ($1,'sync.account','dup-key','queued',now() + interval '1 day')", [owner.tenantId]));
      const r = await as(operator.token).post(`/jobs/${dead!.id}/retry`);
      expect(r.status).toBe(409);
      expect(r.json.error.code).toBe("already_queued");
      await admin.withSystem(q => q.query("UPDATE jobs SET state='cancelled' WHERE dedupe_key='dup-key'"));
    });
  });

  describe("limits", () => {
    it("a limit needs a reason, changes what applies, and the tenant's owner sees it", async () => {
      expect((await as(operator.token).post(`/tenants/${owner.tenantId}/overrides`, { key: "accounts", value: 40 })).status).toBe(400);
      expect((await as(operator.token).post(`/tenants/${owner.tenantId}/overrides`, { key: "accounts", value: 40, reason: "x" })).status).toBe(400);
      expect((await as(operator.token).post(`/tenants/${owner.tenantId}/overrides`, { key: "accounts", value: 40, reason: "Agreed with the customer" })).status).toBe(200);
      expect((await limitsFor(web, owner.tenantId)).accounts).toBe(40);
      const d = (await as(operator.token).get(`/tenants/${owner.tenantId}`)).json;
      expect(d.limits.find((l: any) => l.key === "accounts")).toMatchObject({ value: 40, source: "override" });
      const seen = (await auditLog(web, owner)).rows.find((r: any) => r.event === "operator.override_set");
      expect(seen?.meta).toMatchObject({ reason: "Agreed with the customer", fields: ["accounts"] });
      expect((await auditLog(web, member)).rows.find((r: any) => r.event === "operator.override_set")).toBeUndefined();
      expect((await as(operator.token).post(`/tenants/${owner.tenantId}/overrides/clear`, { key: "accounts", reason: "No longer needed" })).status).toBe(200);
      expect((await limitsFor(web, owner.tenantId)).accounts).toBeNull();
      expect((await auditLog(web, owner)).rows.find((r: any) => r.event === "operator.override_cleared")).toBeTruthy();
    });
    it("null sets no limit for one workspace, over an instance default", async () => {
      const withDefault = createPlatform({ db: webDb, kms: web.kms, config: { ...web.config, limits: { accounts: 3 } }, log: makeLogger(() => {}), env: {} });
      expect((await limitsFor(withDefault, owner.tenantId)).accounts).toBe(3);
      expect((await as(operator.token).post(`/tenants/${owner.tenantId}/overrides`, { key: "accounts", value: null, reason: "Their own server account" })).status).toBe(200);
      expect((await limitsFor(withDefault, owner.tenantId)).accounts).toBeNull();
      expect((await as(operator.token).post(`/tenants/${owner.tenantId}/overrides/clear`, { key: "accounts", reason: "Back to the default" })).status).toBe(200);
      expect((await limitsFor(withDefault, owner.tenantId)).accounts).toBe(3);
    });
    it("only the five limits can be set: no safety feature, no feature switch, and only whole numbers", async () => {
      for (const key of ["securityWarnings", "quarantine", "securityAnalysis", "export", "sso", "policies", "securityCenter", "sharedMailboxes"]) {
        const r = await as(operator.token).post(`/tenants/${owner.tenantId}/overrides`, { key, value: 0, reason: "should not work" });
        expect(r.status, key).toBe(400);
      }
      for (const value of [false, -1, 1.5, "5"]) expect((await as(operator.token).post(`/tenants/${owner.tenantId}/overrides`, { key: "seats", value, reason: "should not work" })).status, String(value)).toBe(400);
    });
  });

  describe("owner contact", () => {
    it("needs a reason, returns one owner, and appears in both audit logs", async () => {
      expect((await as(operator.token).post(`/tenants/${owner.tenantId}/owner-contact`, {})).status).toBe(400);
      const r = await as(operator.token).post(`/tenants/${owner.tenantId}/owner-contact`, { reason: "Support ticket 42" });
      expect(r.json).toEqual({ name: CANARY.ownerName, email: CANARY.owner });
      expect((await auditLog(web, owner)).rows.find((x: any) => x.event === "operator.owner_contact_viewed")?.meta.reason).toBe("Support ticket 42");
      const ops = (await as(operator.token).get("/audit")).json;
      expect(ops.find((x: any) => x.action === "tenant.owner_contact_viewed")).toMatchObject({ tenantId: owner.tenantId, reason: "Support ticket 42", operator: "Ops Person" });
    });
  });

  describe("suspension", () => {
    it("blocks sign-in and existing sessions, stops sync, deletes nothing, is audited, and reverses", async () => {
      const before = await admin.withSystem(q => q.one<{ m: number; a: number }>("SELECT (SELECT count(*)::int FROM messages WHERE tenant_id=$1) m, (SELECT count(*)::int FROM mail_accounts WHERE tenant_id=$1) a", [owner.tenantId]));
      expect(before!.m).toBeGreaterThan(0);
      expect((await as(operator.token).post(`/tenants/${owner.tenantId}/suspend`, {})).status).toBe(400);
      expect((await as(operator.token).post(`/tenants/${owner.tenantId}/suspend`, { reason: "Abuse report 7" })).status).toBe(200);

      // Can't get in, by any of the ways in, and the message says why and that nothing's gone.
      await expect(signIn(web, { email: CANARY.owner, password: PW })).rejects.toMatchObject({ status: 403, code: "workspace_suspended", message: expect.stringMatching(/Nothing has been deleted.*Abuse report 7/) });
      const signin = await client.call("POST", "/auth/signin", { body: { email: CANARY.owner, password: PW } });
      expect(signin.status).toBe(403);
      expect(signin.json.error.code).toBe("workspace_suspended");
      // A session from before the suspension stops working.
      expect(await resolveSession(web, owner.token)).toBeNull();
      expect((await client.call("GET", "/me", { token: owner.token })).status).toBe(401);

      // Sync stops: not scheduled by the tick, and a job already queued does nothing.
      await webDb.withSystem(q => q.query("UPDATE jobs SET state='cancelled' WHERE tenant_id=$1 AND state='queued'", [owner.tenantId]));
      await admin.withSystem(q => q.query("INSERT INTO demo_mailbox(account_id,tenant_id,remote_id,internal_date,raw) VALUES ($1,$2,'m2',now(),$3)", [acct, owner.tenantId, Buffer.from(mime({ from: "x@oak.test", subject: "During suspension", text: "x" }))]));
      await tick(worker);
      expect(await admin.withSystem(q => q.query("SELECT 1 FROM jobs WHERE tenant_id=$1 AND kind='sync.account' AND state='queued'", [owner.tenantId]))).toEqual([]);
      await workerDb.withSystem(q => enqueue(q, { tenantId: owner.tenantId, kind: "sync.account", payload: { accountId: acct } }));
      await drainJobs(worker);

      // Nothing was deleted, and the new message wasn't ingested.
      const during = await admin.withSystem(q => q.one<{ m: number; a: number }>("SELECT (SELECT count(*)::int FROM messages WHERE tenant_id=$1) m, (SELECT count(*)::int FROM mail_accounts WHERE tenant_id=$1) a", [owner.tenantId]));
      expect(during).toEqual(before);

      // Retention and destructive jobs wait.
      await workerDb.withSystem(q => enqueue(q, { tenantId: owner.tenantId, kind: "account.disconnect", payload: { accountId: acct, reason: "delete" } }));
      await drainJobs(worker);
      expect(await admin.withSystem(q => q.one<any>("SELECT state FROM jobs WHERE tenant_id=$1 AND kind='account.disconnect' ORDER BY created_at DESC LIMIT 1", [owner.tenantId]))).toEqual({ state: "queued" });
      expect((await admin.withSystem(q => q.one<{ a: number }>("SELECT count(*)::int a FROM mail_accounts WHERE tenant_id=$1", [owner.tenantId])))!.a).toBe(before!.a);
      await admin.withSystem(q => q.query("UPDATE jobs SET state='cancelled' WHERE tenant_id=$1 AND kind='account.disconnect'", [owner.tenantId]));

      // The operator sees it; the list and detail say so.
      expect((await as(operator.token).get(`/tenants/${owner.tenantId}`)).json.tenant).toMatchObject({ suspendedReason: "Abuse report 7" });
      expect((await as(operator.token).get("/tenants?search=neutral")).json[0].suspendedAt).toBeTruthy();

      // Reversible.
      expect((await as(operator.token).post(`/tenants/${owner.tenantId}/unsuspend`, { reason: "Report was mistaken" })).status).toBe(200);
      expect((await as(operator.token).post(`/tenants/${owner.tenantId}/unsuspend`, { reason: "Report was mistaken" })).status).toBe(409);
      const back = await signIn(web, { email: CANARY.owner, password: PW });
      expect(back.token).toBeTruthy();
      expect((await resolveSession(web, owner.token))?.tenantId).toBe(owner.tenantId);
      expect((await getThread(web, owner, threadId)).messages[0]!.text).toContain(CANARY.body);
      await workerDb.withSystem(q => enqueue(q, { tenantId: owner.tenantId, kind: "sync.account", payload: { accountId: acct } }));
      await drainJobs(worker);
      expect((await admin.withSystem(q => q.one<{ m: number }>("SELECT count(*)::int m FROM messages WHERE tenant_id=$1", [owner.tenantId])))!.m).toBe(before!.m + 1);

      // The tenant can see all of this in its own audit log afterwards.
      const events = (await auditLog(web, owner)).rows.map((r: any) => r.event);
      expect(events).toContain("operator.tenant_suspended");
      expect(events).toContain("operator.tenant_unsuspended");
    });
    it("someone with another workspace can still sign in to that one, and doesn't see the suspended one", async () => {
      const s = await signUp(web, { email: "two@tenant.example", password: PW, name: "Two", workspaceKind: "personal" });
      const other = await signUp(web, { email: "orgowner@tenant.example", password: PW, name: "Org", workspaceKind: "organization" });
      await admin.withSystem(q => q.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES ($1,$2,'member')", [other.tenantId, s.userId]));
      expect((await as(operator.token).post(`/tenants/${other.tenantId}/suspend`, { reason: "Abuse report 8" })).status).toBe(200);
      const back = await signIn(web, { email: "two@tenant.example", password: PW });
      const info = await resolveSession(web, back.token);
      expect(info?.tenantId).toBe(s.tenantId);
      expect(info?.workspaces.map(w => w.id)).toEqual([s.tenantId]);
      // They're told why it's gone from their list, by the API the app shell reads.
      const me = await client.call("GET", "/me", { token: back.token });
      expect(me.json.suspendedWorkspaces).toEqual([{ name: "Org's organization", reason: "Abuse report 8" }]);
      await expect(signIn(web, { email: "orgowner@tenant.example", password: PW })).rejects.toMatchObject({ code: "workspace_suspended" });
      await as(operator.token).post(`/tenants/${other.tenantId}/unsuspend`, { reason: "done with this test" });
    });
    it("a demo sign-in into a suspended workspace is refused the same way", async () => {
      const q = await createTestDb("opsusp");
      try {
        const demo = createPlatform({ db: q.db, kms: new LocalDevKms(randomBytes(32)), config: { demoMode: true, appOrigin: "http://localhost:3000", webauthnRpId: "localhost" }, log: makeLogger(() => {}), env: {} });
        await seedDemo(demo);
        const op = await q.db.withSystem(t => t.one<{ id: string }>("SELECT id FROM users WHERE lower(email)=$1", [DEMO_OPERATOR.email]));
        const tenant = await q.db.withSystem(t => t.one<{ id: string }>("SELECT id FROM organizations WHERE name='Harbor Co (demo)'"));
        await q.db.withOperator(op!.id, t => t.query("SELECT op.suspend_tenant($1,'testing')", [tenant!.id]));
        await expect(demoSession(demo, "avery@demo.aegis.example")).rejects.toMatchObject({ code: "workspace_suspended" });
      } finally { await q.drop(); }
    }, 180_000);
  });

  describe("operator audit log", () => {
    it("records every action with who, what, when and why", async () => {
      const rows = (await as(operator.token).get("/audit?limit=200")).json;
      const actions = new Set(rows.map((r: any) => r.action));
      for (const a of ["tenant.viewed", "tenant.override_set", "tenant.override_cleared", "tenant.suspended", "tenant.unsuspended", "tenant.owner_contact_viewed", "job.retried", "operator.granted"]) expect(actions, a).toContain(a);
      expect(rows.find((r: any) => r.action === "tenant.suspended" && r.reason === "Abuse report 7")).toMatchObject({ operator: "Ops Person", tenant: "Neutral Tenant" });
    });
  });

  describe("canary scan", () => {
    it("no operator response contains a subject, sender, body, mailbox address, member, or secret", async () => {
      const responses: string[] = [];
      const record = (r: { text: string }) => { responses.push(r.text); return r; };
      for (const r of allRoutes().filter(x => x.m === "GET")) {
        for (const path of r.p.includes(":id") ? [r.p.replace(":id", owner.tenantId)] : [r.p]) record(await client.call("GET", path, { token: operator.token }));
      }
      record(await as(operator.token).get("/jobs?state=queued"));
      record(await as(operator.token).get("/jobs?state=running"));
      record(await as(operator.token).get("/tenants?limit=200"));
      record(await as(operator.token).post(`/tenants/${owner.tenantId}/overrides`, { key: "automations", value: 9, reason: "canary scan" }));
      record(await as(operator.token).post(`/tenants/${owner.tenantId}/overrides/clear`, { key: "automations", reason: "canary scan" }));
      record(await as(operator.token).post(`/tenants/${owner.tenantId}/suspend`, { reason: "canary scan" }));
      record(await as(operator.token).post(`/tenants/${owner.tenantId}/unsuspend`, { reason: "canary scan" }));
      record(await as(operator.token).get("/audit?limit=200"));
      const all = responses.join("\n");
      expect(all.length).toBeGreaterThan(2000);
      for (const [name, value] of Object.entries(CANARY)) {
        // The owner's own address and name are only reachable through the owner-contact route, which isn't in this scan.
        expect(all.includes(value), `${name} leaked`).toBe(false);
      }
      expect(all).not.toContain(acct);
      expect(all).not.toContain(threadId);
      expect(all).not.toMatch(/canary-domain|canary-tenant/i);
    });
    it("the canary is real: the mailbox owner can see it, so the scan above is looking for something that exists", async () => {
      const t = await getThread(web, owner, threadId);
      expect(t.messages[0]!.subject).toBe(CANARY.subject);
      expect(t.messages[0]!.text).toContain(CANARY.body);
      expect((await admin.withSystem(q => q.one<any>("SELECT email FROM mail_accounts WHERE id=$1", [acct])))!.email).toBe(CANARY.mailbox);
    });
    it("the owner of a tenant can't see any of the operator's own data", async () => {
      await expect(webDb.withUser(owner, q => q.query("SELECT * FROM operator_audit_log"))).rejects.toThrow(/permission denied/);
      await expect(webDb.withUser(owner, q => q.query("SELECT * FROM platform_admins"))).rejects.toThrow(/permission denied/);
    });
  });
});
