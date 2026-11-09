import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { createDatabase, dropDatabase, migrate, MIGRATIONS_DIR } from "./index";

/**
 * 021 removes billing from a database that has been in use: it has to carry real rows across, not just build cleanly from nothing.
 * This applies 001 to 020 the way `migrate` does, fills in what an existing deployment could hold, then lets `migrate` apply 021.
 */
describe("migration 021 on a database that was in use", () => {
  const base = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/postgres";
  const u = new URL(base);
  u.pathname = `/aegis_test_m021_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  const url = u.toString();
  let c: pg.Client;
  const ids = { org: "11111111-1111-4111-8111-111111111111", owner: "22222222-2222-4222-8222-222222222222", biller: "33333333-3333-4333-8333-333333333333", sso: "44444444-4444-4444-8444-444444444444" };
  const q = async <T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []) => (await c.query<T>(sql, params)).rows;

  beforeAll(async () => {
    await createDatabase(url);
    c = new pg.Client({ connectionString: url });
    await c.connect();
    await q("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const f of readdirSync(MIGRATIONS_DIR).filter(n => n.endsWith(".sql")).sort()) {
      if (f >= "021") break;
      await q("BEGIN");
      await q("SELECT pg_advisory_xact_lock(727001)");
      await q("CREATE EXTENSION IF NOT EXISTS pgcrypto");
      await q(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
      await q("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
      await q("COMMIT");
    }
    await q("INSERT INTO organizations(id,kind,name,plan) VALUES ($1,'organization','Old Co','business')", [ids.org]);
    await q("INSERT INTO users(id,email,name) VALUES ($1,'owner@old.example','Owner'), ($2,'biller@old.example','Biller')", [ids.owner, ids.biller]);
    await q("INSERT INTO memberships(tenant_id,user_id,role) VALUES ($1,$2,'owner'), ($1,$3,'billing_manager')", [ids.org, ids.owner, ids.biller]);
    await q("INSERT INTO invitations(tenant_id,email,role,token_hash,invited_by,expires_at) VALUES ($1,'next@old.example','billing_manager','tok',$2, now() + interval '1 day')", [ids.org, ids.owner]);
    await q("INSERT INTO sso_configs(id,tenant_id,domain,protocol,issuer,saml_entry_point,saml_idp_cert,jit_role) VALUES ($1,$2,'old.example','saml','https://idp.old.example','https://idp.old.example/sso','cert','billing_manager')", [ids.sso, ids.org]);
    await q("INSERT INTO subscriptions(tenant_id,plan,status,provider,external_id,customer_id) VALUES ($1,'business','active','stripe','sub_1','cus_1')", [ids.org]);
    await q("INSERT INTO invoices(tenant_id,external_id,amount_cents,currency,status) VALUES ($1,'in_1',1000,'usd','paid')", [ids.org]);
    await q("INSERT INTO usage_counters(tenant_id,period,metric,value) VALUES ($1,'2026-10','ai_actions',42)", [ids.org]);
    await q("INSERT INTO tenant_entitlement_overrides(tenant_id,key,value,reason) VALUES ($1,'accounts','40','kept'), ($1,'sso','true','dropped')", [ids.org]);
    await q("INSERT INTO jobs(tenant_id,kind,dedupe_key) VALUES ($1,'billing.seat_sync','seats:old'), ($1,'sync.account',NULL)", [ids.org]);
    await migrate(url);
  });
  afterAll(async () => { await c?.end(); await dropDatabase(url); });

  it("was applied by migrate, after the others", async () => {
    // Later migrations run after it in the same call, so it's the first one `migrate` had to apply here, not the last on record.
    const applied = (await q("SELECT name FROM schema_migrations ORDER BY name")).map(r => r.name);
    expect(applied).toContain("021_remove_billing.sql");
    expect(applied).toEqual([...applied].sort());
  });

  it("turns billing managers into members, and says so in the workspace's audit log", async () => {
    expect(await q("SELECT user_id, role FROM memberships WHERE tenant_id=$1 ORDER BY role", [ids.org])).toEqual([{ user_id: ids.biller, role: "member" }, { user_id: ids.owner, role: "owner" }]);
    expect(await q("SELECT event, target_id, meta FROM audit_events WHERE tenant_id=$1", [ids.org])).toEqual([{ event: "member.role_changed", target_id: ids.biller, meta: { role: "member", outcome: "role_retired" } }]);
    expect((await q("SELECT role FROM invitations WHERE tenant_id=$1", [ids.org]))[0].role).toBe("member");
    expect((await q("SELECT jit_role FROM sso_configs WHERE id=$1", [ids.sso]))[0].jit_role).toBe("member");
  });

  it("won't take billing_manager again, anywhere", async () => {
    await expect(q("INSERT INTO memberships(tenant_id,user_id,role) VALUES ($1,$2,'billing_manager') ON CONFLICT (tenant_id,user_id) DO UPDATE SET role=EXCLUDED.role", [ids.org, ids.biller])).rejects.toThrow(/memberships_role_check/);
    await expect(q("UPDATE invitations SET role='billing_manager'")).rejects.toThrow(/invitations_role_check/);
    await expect(q("UPDATE sso_configs SET jit_role='billing_manager'")).rejects.toThrow(/sso_configs_jit_role_check/);
  });

  it("drops billing state and keeps usage", async () => {
    const tables = (await q<{ t: string }>("SELECT tablename t FROM pg_tables WHERE schemaname='public'")).map(r => r.t);
    for (const t of ["subscriptions", "invoices", "billing_webhook_events", "usage_reports", "tenant_entitlement_overrides"]) expect(tables, t).not.toContain(t);
    expect(tables).toContain("usage_counters");
    expect(await q("SELECT value FROM usage_counters WHERE tenant_id=$1", [ids.org])).toEqual([{ value: 42 }]);
    expect(await q("SELECT 1 FROM information_schema.columns WHERE table_name='organizations' AND column_name='plan'")).toEqual([]);
    const fns = (await q<{ f: string }>("SELECT proname f FROM pg_proc WHERE proname LIKE 'billing%' OR proname IN ('enqueue_seat_sync','scheduler_billing_tenants','plan_stats','paying_stats','extend_trial')")).map(r => r.f);
    expect(fns).toEqual([]);
    expect(await q("SELECT 1 FROM pg_trigger WHERE tgname='memberships_seat_sync'")).toEqual([]);
  });

  it("keeps an operator's numeric limits and drops feature switches", async () => {
    expect(await q("SELECT key, value, reason FROM tenant_limit_overrides WHERE tenant_id=$1", [ids.org])).toEqual([{ key: "accounts", value: 40, reason: "kept" }]);
  });

  it("cancels billing work that was still queued, and leaves the rest", async () => {
    expect(await q("SELECT kind, state FROM jobs WHERE tenant_id=$1 ORDER BY kind", [ids.org])).toEqual([{ kind: "billing.seat_sync", state: "cancelled" }, { kind: "sync.account", state: "queued" }]);
  });
});
