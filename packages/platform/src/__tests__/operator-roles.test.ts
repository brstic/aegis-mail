import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createTestDb, Db, ensureLogin } from "@aegis/db";
import { LocalDevKms } from "@aegis/cryptography";
import { acceptInvite, checkSeatLimit, connectAccount, createPlatform, type Ctx, drainJobs, enqueue, grantOperator, invite, limitsFor, listOperators, makeLogger, operatorSuspend, type Platform, requireOperator, revokeOperator, signUp, syncOperatorsFromEnv, usageFor, incrementUsage } from "../index";
import { mime } from "@aegis/test-fixtures";

// The gateway_* tables are left in the schema from migration 006 although gateway mode was dropped (2026-11-07). They can still hold mail, so they stay out of reach too.
const MAIL_TABLES = ["messages", "message_contents", "message_search", "message_embeddings", "threads", "attachments", "contacts", "drafts", "tasks", "credential_envelopes", "security_analyses", "quarantine_items", "priority_decisions", "demo_mailbox", "ai_artifacts", "ai_usage", "mail_labels", "message_labels", "mail_folders", "user_feedback", "send_approvals", "incident_shares", "proposed_actions", "automation_runs", "tenant_keys", "oauth_grants", "gateway_spool", "gateway_holds", "gateway_hold_owner_meta", "gateway_recipients", "dev_outbox", "outbound_mail"];
const CANARY = "ZEBRA-CANARY-SUBJECT-771";

/** Under the real non-superuser logins, the way the product runs. Nothing here uses an owner connection except to set up and check. */
describe("operator and usage contexts under real logins", () => {
  let ownerUrl: string, drop: () => Promise<void>, admin: Db, adminP: Platform, web: Platform, worker: Platform, webDb: Db, workerDb: Db, owner: Ctx & { token: string }, operatorId: string, acct: string;

  beforeAll(async () => {
    const t = await createTestDb("oproles"); admin = t.db; drop = t.drop; ownerUrl = t.url;
    await ensureLogin(t.url, "aegis_web_login", "aegis_web_conn");
    await ensureLogin(t.url, "aegis_worker_login", "aegis_worker_conn");
    const as = (login: string) => { const u = new URL(t.url); u.username = login; return u.toString(); };
    webDb = new Db(as("aegis_web_login"), 5, { keyRole: "aegis_app" });
    workerDb = new Db(as("aegis_worker_login"), 5, { keyRole: "aegis_worker" });
    const kms = new LocalDevKms(randomBytes(32));
    const shared = { kms, config: { demoMode: true, appOrigin: "http://localhost:3000", webauthnRpId: "localhost" }, log: makeLogger(() => {}), env: {} };
    web = createPlatform({ db: webDb, ...shared });
    worker = createPlatform({ db: workerDb, ...shared });
    adminP = createPlatform({ db: admin, ...shared });
    const s = await signUp(web, { email: "owner@tenant.example", password: "correct-horse-battery", name: "Owner", workspaceKind: "organization" });
    owner = { tenantId: s.tenantId, userId: s.userId, sessionId: s.sessionId, token: s.token };
    const o = await signUp(web, { email: "ops@service.example", password: "correct-horse-battery", name: "Ops", workspaceKind: "personal" });
    operatorId = o.userId;
    await admin.withSystem(q => q.query("UPDATE users SET email_verified_at=now() WHERE id=$1", [operatorId]));
    await grantOperator(adminP, "ops@service.example", "cli");
    acct = await connectAccount(web, owner, { kind: "demo", email: "owner@tenant.example", displayName: "O", credential: { kind: "demo" } });
    await webDb.withUser(owner, q => q.query("INSERT INTO demo_mailbox(account_id,tenant_id,remote_id,internal_date,raw) VALUES ($1,$2,'m1',now(),$3)", [acct, owner.tenantId, Buffer.from(mime({ from: "a@oak.test", subject: CANARY, text: "Body" }))]));
    await drainJobs(worker);
  });
  afterAll(async () => { await webDb.close(); await workerDb.close(); await drop(); });

  describe("aegis_operator", () => {
    it("has no grant on any table, in any schema", async () => {
      expect(await admin.withSystem(q => q.query("SELECT table_name FROM information_schema.role_table_grants WHERE grantee='aegis_operator'"))).toEqual([]);
      expect(await admin.withSystem(q => q.query("SELECT table_name FROM information_schema.column_privileges WHERE grantee='aegis_operator'"))).toEqual([]);
    });
    it("an operator can't read mail with raw SQL, whichever table", async () => {
      // The check is against every table in the database, so a table added later is covered without editing this test.
      const all = await admin.withSystem(q => q.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public'"));
      expect(all.length).toBeGreaterThan(40);
      for (const { tablename } of all) await expect(webDb.withOperator(operatorId, q => q.query(`SELECT * FROM ${tablename} LIMIT 1`)), tablename).rejects.toThrow(/permission denied/);
    });
    it("nor write to one", async () => {
      await expect(webDb.withOperator(operatorId, q => q.query("UPDATE messages SET held=false"))).rejects.toThrow(/permission denied/);
      await expect(webDb.withOperator(operatorId, q => q.query("DELETE FROM messages"))).rejects.toThrow(/permission denied/);
      await expect(webDb.withOperator(operatorId, q => q.query("UPDATE tenant_limit_overrides SET value='0'"))).rejects.toThrow(/permission denied/);
      await expect(webDb.withOperator(operatorId, q => q.query("INSERT INTO platform_admins(user_id,source) VALUES ($1,'cli')", [operatorId]))).rejects.toThrow(/permission denied/);
    });
    it("every op.* function is closed to the other contexts", async () => {
      const fns = await admin.withSystem(q => q.query<{ sig: string }>("SELECT p.oid::regprocedure::text sig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='op'"));
      expect(fns.length).toBeGreaterThan(20);
      for (const role of ["aegis_app", "aegis_worker", "aegis_web_conn", "aegis_worker_conn", "aegis_usage", "aegis_billing", "aegis_gateway"]) {
        for (const { sig } of fns) {
          const r = await admin.withSystem(q => q.one<{ ok: boolean }>("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role, sig]));
          expect(r!.ok, `${role} ${sig}`).toBe(false);
        }
      }
      await expect(webDb.withUser(owner, q => q.query("SELECT * FROM op.list_tenants(NULL,10,0)"))).rejects.toThrow(/permission denied/);
      await expect(webDb.withSystem(q => q.query("SELECT * FROM op.list_tenants(NULL,10,0)"))).rejects.toThrow(/permission denied/);
      await expect(workerDb.withWorker(owner.tenantId, q => q.query("SELECT * FROM op.list_tenants(NULL,10,0)"))).rejects.toThrow(/permission denied/);
    });
    it("internal helpers and the granting functions aren't callable by operators", async () => {
      for (const sql of ["SELECT op.record(NULL,'x',NULL,NULL,NULL,NULL,NULL)", "SELECT op.cli_grant($1,'cli')", "SELECT op.cli_revoke($1,NULL)", "SELECT * FROM op.cli_list()"]) {
        await expect(webDb.withOperator(operatorId, q => q.query(sql, sql.includes("$1") ? [owner.userId] : []))).rejects.toThrow(/permission denied/);
      }
    });
    it("the functions themselves re-check: an ID that isn't an operator gets nothing and can change nothing", async () => {
      const nobody = owner.userId;
      await expect(webDb.withOperator(nobody, q => q.query("SELECT * FROM op.list_tenants(NULL,10,0)"))).resolves.toEqual([]);
      await expect(webDb.withOperator(nobody, q => q.query("SELECT * FROM op.mailbox_stats()"))).resolves.toEqual([]);
      await expect(webDb.withOperator(nobody, q => q.query("SELECT * FROM op.audit_log(10,NULL)"))).resolves.toEqual([]);
      for (const sql of ["SELECT * FROM op.tenant_detail($1)", "SELECT op.suspend_tenant($1,'because')", "SELECT op.set_override($1,'accounts','5','because',NULL)", "SELECT * FROM op.owner_contact($1,'because')"]) {
        await expect(webDb.withOperator(nobody, q => q.query(sql, [owner.tenantId])), sql).rejects.toMatchObject({ code: "42501" });
      }
    });
    it("no function's result has a column for content, a mailbox address, a job payload, or a credential", async () => {
      const cols = await admin.withSystem(q => q.query<{ fn: string; col: string }>(
        `SELECT p.proname fn, a.col FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace, unnest(p.proargnames, p.proargmodes) AS a(col, mode) WHERE n.nspname='op' AND a.mode='t'`));
      expect(cols.length).toBeGreaterThan(40);
      const allowedEmail = new Set(["owner_contact", "cli_list"]);
      for (const c of cols) {
        expect(`${c.fn}.${c.col}`).not.toMatch(/subject|sender|body|snippet|raw|payload|envelope|blob|secret|token|password|hash|recipient|credential/i);
        if (/email|address/i.test(c.col)) expect(allowedEmail.has(c.fn), `${c.fn}.${c.col}`).toBe(true);
      }
    });
    it("the owner-contact path is the only function that yields an address, and it needs a reason", async () => {
      await expect(webDb.withOperator(operatorId, q => q.query("SELECT * FROM op.owner_contact($1,'')", [owner.tenantId]))).rejects.toMatchObject({ code: "22023" });
      expect(await webDb.withOperator(operatorId, q => q.query("SELECT * FROM op.owner_contact($1,'support request')", [owner.tenantId]))).toEqual([{ name: "Owner", email: "owner@tenant.example" }]);
    });
  });

  describe("the definer role behind those functions", () => {
    it("isn't a superuser and has no way round row security", async () => {
      expect(await admin.withSystem(q => q.one("SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname='aegis_operator_definer'"))).toEqual({ rolsuper: false, rolbypassrls: false, rolcanlogin: false });
    });
    it("owns every op.* function", async () => {
      expect(await admin.withSystem(q => q.query("SELECT p.proname, r.rolname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='op' AND r.rolname<>'aegis_operator_definer'"))).toEqual([]);
    });
    it("has no privilege on any mail table", async () => {
      for (const table of MAIL_TABLES) {
        const r = await admin.withSystem(q => q.one<{ ok: boolean }>("SELECT has_table_privilege('aegis_operator_definer',$1,'SELECT') OR has_any_column_privilege('aegis_operator_definer',$1,'SELECT') ok", [table]));
        expect(r!.ok, table).toBe(false);
      }
    });
    it("can't read the mailbox address column, a job's payload, or a person's secrets", async () => {
      const col = (table: string, c: string) => admin.withSystem(q => q.one<{ ok: boolean }>("SELECT has_column_privilege('aegis_operator_definer',$1,$2,'SELECT') ok", [table, c]));
      for (const [t, c] of [["mail_accounts", "email"], ["mail_accounts", "display_name"], ["mail_accounts", "settings"], ["jobs", "payload"], ["jobs", "tenant_id"], ["users", "password_hash"], ["users", "totp_secret_enc"], ["sessions", "token_hash"]] as const) {
        expect((await col(t, c))!.ok, `${t}.${c}`).toBe(false);
      }
    });
    it("really does work with those limits, in a real run", async () => {
      const r = await webDb.withOperator(operatorId, q => q.query<any>("SELECT * FROM op.list_tenants(NULL,10,0)"));
      expect(r.find(x => x.id === owner.tenantId)).toMatchObject({ mailboxes: 1, members: 1 });
      expect(await webDb.withOperator(operatorId, q => q.query("SELECT * FROM op.mailbox_stats()"))).toEqual([{ provider: "demo", status: "active", count: 1 }]);
    });
  });

  describe("operator audit log", () => {
    it("operators have no update or delete, and neither does the role that writes it", async () => {
      await expect(webDb.withOperator(operatorId, q => q.query("UPDATE operator_audit_log SET reason='x'"))).rejects.toThrow(/permission denied/);
      await expect(webDb.withOperator(operatorId, q => q.query("DELETE FROM operator_audit_log"))).rejects.toThrow(/permission denied/);
      for (const priv of ["UPDATE", "DELETE", "TRUNCATE"]) {
        const r = await admin.withSystem(q => q.one<{ ok: boolean }>("SELECT has_table_privilege('aegis_operator_definer','operator_audit_log',$1) ok", [priv]));
        expect(r!.ok, priv).toBe(false);
      }
    });
    it("even the table owner can't rewrite it: the trigger refuses", async () => {
      await webDb.withOperator(operatorId, q => q.query("SELECT op.suspend_tenant($1,'probe')", [owner.tenantId]));
      await webDb.withOperator(operatorId, q => q.query("SELECT op.unsuspend_tenant($1,'probe')", [owner.tenantId]));
      await expect(admin.withSystem(q => q.query("UPDATE operator_audit_log SET reason='rewritten'"))).rejects.toThrow(/append-only/);
      await expect(admin.withSystem(q => q.query("DELETE FROM operator_audit_log"))).rejects.toThrow(/append-only/);
    });
  });

  describe("aegis_usage", () => {
    it("has no grant on any mail table", async () => {
      for (const table of MAIL_TABLES) await expect(webDb.withUsage(q => q.query(`SELECT * FROM ${table} LIMIT 1`)), table).rejects.toThrow(/permission denied/);
      await expect(webDb.withUsage(q => q.query("SELECT email FROM mail_accounts"))).rejects.toThrow(/permission denied/);
      await expect(webDb.withUsage(q => q.query("SELECT email FROM users"))).rejects.toThrow(/permission denied/);
    });
    it("reads limits and can't change them", async () => {
      await expect(webDb.withUsage(q => q.query("SELECT 1 FROM tenant_limit_overrides"))).resolves.toBeDefined();
      await expect(webDb.withUsage(q => q.query("INSERT INTO tenant_limit_overrides(tenant_id,key,value,reason) VALUES ($1,'accounts','99','me')", [owner.tenantId]))).rejects.toThrow(/permission denied/);
    });
    it("nor do the usage definer's functions reach content", async () => {
      for (const table of MAIL_TABLES) {
        const r = await admin.withSystem(q => q.one<{ ok: boolean }>("SELECT has_table_privilege('aegis_usage_definer',$1,'SELECT') OR has_any_column_privilege('aegis_usage_definer',$1,'SELECT') ok", [table]));
        expect(r!.ok, table).toBe(false);
      }
      const r = await admin.withSystem(q => q.one<{ ok: boolean }>("SELECT has_column_privilege('aegis_usage_definer','mail_accounts','email','SELECT') ok"));
      expect(r!.ok).toBe(false);
      expect(await admin.withSystem(q => q.one("SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname='aegis_usage_definer'"))).toEqual({ rolsuper: false, rolbypassrls: false, rolcanlogin: false });
    });
    it("the worker can reach it, and neither process can become the operator from the worker side", async () => {
      await expect(workerDb.withUsage(q => q.query("SELECT 1 FROM usage_counters LIMIT 1"))).resolves.toBeDefined();
      await expect(workerDb.withOperator(operatorId, q => q.query("SELECT 1"))).rejects.toThrow(/permission denied to set role/);
    });
    it("the retired billing roles have nothing left in this database", async () => {
      for (const role of ["aegis_billing", "aegis_billing_definer"]) {
        expect(await admin.withSystem(q => q.query("SELECT table_name FROM information_schema.role_table_grants WHERE grantee=$1", [role])), role).toEqual([]);
        expect(await admin.withSystem(q => q.query("SELECT table_name FROM information_schema.column_privileges WHERE grantee=$1", [role])), role).toEqual([]);
        expect(await admin.withSystem(q => q.query("SELECT p.proname FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE r.rolname=$1", [role])), role).toEqual([]);
        expect(await admin.withSystem(q => q.query("SELECT tablename, policyname FROM pg_policies WHERE $1 = ANY(roles)", [role])), role).toEqual([]);
      }
    });
  });

  describe("tenants can't change their own limits or usage", () => {
    it("not with raw SQL, from either process", async () => {
      await expect(webDb.withUser(owner, q => q.query("INSERT INTO usage_counters(tenant_id,period,metric,value) VALUES ($1,'2026-01','ai_actions',0)", [owner.tenantId]))).rejects.toThrow(/permission denied/);
      await expect(webDb.withUser(owner, q => q.query("INSERT INTO tenant_limit_overrides(tenant_id,key,value,reason) VALUES ($1,'accounts','99','me')", [owner.tenantId]))).rejects.toThrow(/permission denied/);
      await expect(webDb.withUser(owner, q => q.query("DELETE FROM tenant_limit_overrides"))).rejects.toThrow(/permission denied/);
      await expect(workerDb.withWorker(owner.tenantId, q => q.query("UPDATE usage_counters SET value=0"))).rejects.toThrow(/permission denied/);
    });
    it("nor lift a suspension", async () => {
      await expect(webDb.withUser(owner, q => q.query("DELETE FROM tenant_suspensions"))).rejects.toThrow(/permission denied/);
      await expect(webDb.withSystem(q => q.query("DELETE FROM tenant_suspensions"))).rejects.toThrow(/permission denied/);
      await expect(workerDb.withWorker(owner.tenantId, q => q.query("DELETE FROM tenant_suspensions"))).rejects.toThrow(/permission denied/);
    });
    it("safety can't be named as a limit, even by the table owner", async () => {
      for (const key of ["securityWarnings", "securityAnalysis", "quarantine", "export", "sso", "policies"]) {
        await expect(admin.withSystem(q => q.query("INSERT INTO tenant_limit_overrides(tenant_id,key,value,reason) VALUES ($1,$2,'0','x')", [owner.tenantId, key])), key).rejects.toThrow(/check constraint/);
        await expect(webDb.withOperator(operatorId, q => q.query("SELECT op.set_override($1,$2,'0','some reason',NULL)", [owner.tenantId, key])), key).rejects.toMatchObject({ code: "22023" });
      }
    });
    it("limit values are checked in the database, too", async () => {
      for (const value of ["true", "-1", "1.5", "\"5\""]) {
        await expect(webDb.withOperator(operatorId, q => q.query("SELECT op.set_override($1,'accounts',$2,'some reason',NULL)", [owner.tenantId, value])), value).rejects.toMatchObject({ code: "22023" });
      }
      await expect(admin.withSystem(q => q.query("INSERT INTO tenant_limit_overrides(tenant_id,key,value,reason) VALUES ($1,'accounts','-1','x')", [owner.tenantId]))).rejects.toThrow(/check constraint/);
      await webDb.withOperator(operatorId, q => q.query("SELECT op.set_override($1,'accounts','null','no limit here',NULL)", [owner.tenantId]));
      expect((await limitsFor(web, owner.tenantId)).accounts).toBeNull();
      await webDb.withOperator(operatorId, q => q.query("SELECT op.clear_override($1,'accounts','done')", [owner.tenantId]));
    });
  });

  describe("usage and limits work across the process boundary", () => {
    it("counted in web and worker, read in both, and a limit set by an operator applies in both", async () => {
      const s = await signUp(web, { email: "bb@tenant.example", password: "correct-horse-battery", name: "BB", workspaceKind: "organization" });
      const ctx = { tenantId: s.tenantId, userId: s.userId };
      await admin.withSystem(q => q.query("UPDATE users SET email_verified_at=now() WHERE id=$1", [s.userId]));
      const { acceptUrl } = await invite(web, ctx, { email: "bb2@tenant.example", role: "member" });
      const m = await signUp(web, { email: "bb2@tenant.example", password: "correct-horse-battery", name: "BB2", workspaceKind: "personal" });
      await admin.withSystem(q => q.query("UPDATE users SET email_verified_at=now() WHERE id=$1", [m.userId]));
      await acceptInvite(web, m.userId, "bb2@tenant.example", acceptUrl!.split("/").pop()!);
      await drainJobs(worker);

      await incrementUsage(worker, ctx.tenantId, "ai_actions", 5);
      await incrementUsage(web, ctx.tenantId, "ai_actions", 2);
      expect(await usageFor(worker, ctx.tenantId)).toMatchObject({ aiActions: 7, seats: 2 });
      expect(await usageFor(web, ctx.tenantId)).toMatchObject({ aiActions: 7, seats: 2 });

      await webDb.withOperator(operatorId, q => q.query("SELECT op.set_override($1,'seats','2','agreed size',NULL)", [ctx.tenantId]));
      expect((await limitsFor(worker, ctx.tenantId)).seats).toBe(2);
      await expect(checkSeatLimit(web, ctx)).rejects.toMatchObject({ status: 403, code: "limit_reached" });
    });
  });

  describe("granting access", () => {
    it("the web and worker logins can't grant it, by any route", async () => {
      for (const db of [webDb, workerDb]) {
        await expect(db.withSystem(q => q.query("INSERT INTO platform_admins(user_id,source) VALUES ($1,'cli')", [owner.userId]))).rejects.toThrow(/permission denied/);
        await expect(db.withSystem(q => q.query("SELECT op.cli_grant($1,'cli')", [owner.userId]))).rejects.toThrow(/permission denied/);
      }
      expect(await requireOperator(web, { userId: owner.userId, sessionId: owner.sessionId! }).catch(e => e.status)).toBe(404);
    });
    it("needs an existing account with a verified address, so a listed address can't be claimed by signing up", async () => {
      expect((await grantOperator(adminP, "nobody-yet@service.example")).outcome).toBe("no_account");
      const s = await signUp(web, { email: "claimer@service.example", password: "correct-horse-battery", name: "C", workspaceKind: "personal" });
      expect((await grantOperator(adminP, "claimer@service.example")).outcome).toBe("unverified");
      await expect(requireOperator(web, { userId: s.userId, sessionId: s.sessionId })).rejects.toMatchObject({ status: 404 });
    });
    it("the env list syncs: additions granted, removals revoked, CLI grants left alone", async () => {
      const add = async (email: string) => { const s = await signUp(web, { email, password: "correct-horse-battery", name: "E", workspaceKind: "personal" }); await admin.withSystem(q => q.query("UPDATE users SET email_verified_at=now() WHERE id=$1", [s.userId])); return s; };
      const a = await add("env1@service.example");
      await add("env2@service.example");
      const r1 = await syncOperatorsFromEnv(adminP, "ENV1@service.example, env2@service.example,not-registered@service.example");
      expect(r1.map(x => x.outcome).sort()).toEqual(["granted", "granted", "no_account"]);
      await expect(requireOperator(web, { userId: a.userId, sessionId: a.sessionId })).resolves.toBeTruthy();
      const r2 = await syncOperatorsFromEnv(adminP, "env2@service.example");
      expect(r2.find(x => x.email === "env1@service.example")?.outcome).toBe("revoked");
      await expect(requireOperator(web, { userId: a.userId, sessionId: a.sessionId })).rejects.toMatchObject({ status: 404 });
      const list = await listOperators(adminP);
      expect(list.find(x => x.email === "ops@service.example")).toMatchObject({ source: "cli", revoked_at: null });
    });
    it("revoking takes effect at once, in the database as well as the gate", async () => {
      const s = await signUp(web, { email: "gone@service.example", password: "correct-horse-battery", name: "G", workspaceKind: "personal" });
      await admin.withSystem(q => q.query("UPDATE users SET email_verified_at=now() WHERE id=$1", [s.userId]));
      await grantOperator(adminP, "gone@service.example");
      const op = await requireOperator(web, { userId: s.userId, sessionId: s.sessionId });
      expect(await revokeOperator(adminP, "gone@service.example")).toBe(true);
      // Holding an operator context from before the revoke doesn't help.
      await expect(operatorSuspend(web, op, owner.tenantId, "too late")).rejects.toMatchObject({ status: 404 });
      await expect(webDb.withOperator(s.userId, q => q.query("SELECT * FROM op.whoami()"))).resolves.toEqual([]);
    });
  });

  it("enqueue stays content-free for the new job kinds", async () => {
    await webDb.withSystem(q => enqueue(q, { tenantId: owner.tenantId, kind: "usage.tenant_snapshot" }));
    await expect(webDb.withSystem(q => enqueue(q, { tenantId: owner.tenantId, kind: "usage.tenant_snapshot", payload: { customerEmail: "a@b.example" } }))).rejects.toThrow(/not allowed/);
    await drainJobs(worker);
    // The snapshot ran in the worker, under the worker login, and wrote the gauges.
    const gauges = await admin.withSystem(q => q.query<{ metric: string }>("SELECT metric FROM usage_counters WHERE tenant_id=$1 ORDER BY metric", [owner.tenantId]));
    expect(gauges.map(g => g.metric)).toEqual(expect.arrayContaining(["active_mailboxes", "index_bytes", "seats"]));
  });

  describe("static: no path to content in the operator code", () => {
    const FORBIDDEN = /\b(messages|message_contents|message_search|attachments|threads|contacts|drafts|tasks|credential_envelopes|security_analyses|quarantine_items|priority_decisions|demo_mailbox|ai_artifacts|send_approvals|incident_shares|gateway_spool|gateway_holds)\b|getThread|listThreads|getFocus|exportData|envelope|openJson|withUser|withWorker|withKeys|impersonat|adapterFor|mail_accounts/i;
    const root = join(__dirname, "../../../..");
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    it("the route module", () => {
      expect(strip(readFileSync(join(root, "apps/web/src/server/routes/operator.ts"), "utf8"))).not.toMatch(FORBIDDEN);
    });
    it("the service module", () => {
      expect(strip(readFileSync(join(root, "packages/platform/src/operator.ts"), "utf8"))).not.toMatch(FORBIDDEN);
    });
    it("every admin page", () => {
      const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
      const pages = walk(join(root, "apps/web/src/app/admin"));
      expect(pages.length).toBeGreaterThan(4);
      for (const f of pages) {
        const src = strip(readFileSync(f, "utf8"));
        expect(src, f).not.toMatch(/\/threads|\/messages|\/focus|impersonat|view.?email|getThread|listThreads/i);
      }
    });
    it("there's no route for impersonation, export, debug, or anything that sounds like content", () => {
      const src = readFileSync(join(root, "apps/web/src/server/routes/operator.ts"), "utf8");
      const paths = [...src.matchAll(/route\("(GET|POST|PATCH|DELETE)", "([^"]+)"/g)].map(m => m[2]!);
      expect(paths.length).toBeGreaterThan(10);
      for (const path of paths) expect(path).not.toMatch(/impersonat|sudo|login-as|export|debug|prompt|mail|message|thread|content|raw|dump|sql/i);
    });
    it("the routes are mounted", () => {
      expect(readFileSync(join(root, "apps/web/src/app/api/v1/[...path]/route.ts"), "utf8")).toContain("...operatorRoutes");
    });
    it("the migrations add no mail table to the operator role or its definer", () => {
      for (const file of ["009_billing_admin.sql", "021_remove_billing.sql"]) {
        const sql = readFileSync(join(root, "packages/db/migrations", file), "utf8");
        for (const line of sql.split("\n").filter(l => /^GRANT .*TO aegis_operator/.test(l))) expect(line, line).not.toMatch(/\b(messages|message_contents|threads|drafts|credential_envelopes|attachments|tasks|contacts)\b/);
      }
    });
  });
});
