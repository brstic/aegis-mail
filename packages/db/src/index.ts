import pg from "pg";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Return bytea as Buffer, bigint as number when safe, dates as Date (default).
pg.types.setTypeParser(20, v => Number(v));

export type Row = Record<string, any>;
export interface Tx {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T | null>;
}

export interface UserCtx { tenantId: string; userId: string }

function txOf(client: pg.PoolClient): Tx {
  return {
    async query<T extends Row>(sql: string, params: unknown[] = []) { return (await client.query(sql, params as unknown[])).rows as T[]; },
    async one<T extends Row>(sql: string, params: unknown[] = []) { return ((await client.query(sql, params as unknown[])).rows[0] as T | undefined) ?? null; },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class Db {
  readonly pool: pg.Pool;
  /** The context this process may use for tenant key access. A web login can't become aegis_worker. */
  private readonly keyRole: "aegis_app" | "aegis_worker";
  constructor(connectionString: string, max = 10, opts: { keyRole?: "aegis_app" | "aegis_worker" } = {}) {
    this.keyRole = opts.keyRole ?? "aegis_worker";
    this.pool = new pg.Pool({ connectionString, max });
    // A failed idle client must not crash the process.
    this.pool.on("error", () => {});
  }
  async close() { await this.pool.end(); }

  private async tx<T>(setup: (t: Tx) => Promise<void>, fn: (t: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const t = txOf(client);
      await setup(t);
      const out = await fn(t);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /** Request context: RLS sees only mailboxes this user owns or was explicitly granted. */
  withUser<T>(ctx: UserCtx, fn: (t: Tx) => Promise<T>): Promise<T> {
    if (!UUID.test(ctx.tenantId) || !UUID.test(ctx.userId)) throw new Error("invalid context");
    return this.tx(async t => {
      await t.query("SET LOCAL ROLE aegis_app");
      await t.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [ctx.tenantId, ctx.userId]);
    }, fn);
  }

  /** Background context constrained to a single tenant. Holds no user identity. */
  withWorker<T>(tenantId: string, fn: (t: Tx) => Promise<T>): Promise<T> {
    if (!UUID.test(tenantId)) throw new Error("invalid context");
    return this.tx(async t => {
      await t.query("SET LOCAL ROLE aegis_worker");
      await t.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', '', true)", [tenantId]);
    }, fn);
  }

  /** Tenant key material only. Tenant-scoped with no user identity, in whichever context this process holds. */
  withKeys<T>(tenantId: string, fn: (t: Tx) => Promise<T>): Promise<T> {
    if (!UUID.test(tenantId)) throw new Error("invalid context");
    return this.tx(async t => {
      await t.query(`SET LOCAL ROLE ${this.keyRole}`);
      await t.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', '', true)", [tenantId]);
    }, fn);
  }

  /** Usage counters and instance limits across tenants. Holds no user identity, and the role has no grant on any mail table. */
  withUsage<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
    return this.tx(async t => {
      await t.query("SET LOCAL ROLE aegis_usage");
      await t.query("SELECT set_config('app.tenant_id', '', true), set_config('app.user_id', '', true)");
    }, fn);
  }

  /** Platform operators. The role has no table grants at all: it can only call op.* functions, each of which re-checks this ID. */
  withOperator<T>(operatorUserId: string, fn: (t: Tx) => Promise<T>): Promise<T> {
    if (!UUID.test(operatorUserId)) throw new Error("invalid context");
    return this.tx(async t => {
      await t.query("SET LOCAL ROLE aegis_operator");
      await t.query("SELECT set_config('app.operator_id', $1, true), set_config('app.tenant_id', '', true), set_config('app.user_id', '', true)", [operatorUserId]);
    }, fn);
  }

  /**
   * Pre-authentication and job-claim paths only: users, sessions, passkeys, memberships lookup, jobs.
   * Reviewed exception. A static test forbids mail tables inside withSystem.
   */
  withSystem<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
    return this.tx(async () => {}, fn);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, "..", "migrations");

export async function migrate(connectionString: string, opts: { log?: (s: string) => void } = {}) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    // Serialize concurrent migrators (roles are cluster-wide, so use a global key).
    await client.query("SELECT pg_advisory_lock(727001)");
    // Security definer functions that read RLS-forced tables run as their owner. If that owner is subject to RLS they
    // don't fail, they quietly return no rows: lookups come back empty and access checks say no. Refuse to create that state.
    const self = (await client.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
    if (!self?.rolsuper && !self?.rolbypassrls) throw new Error("Migrations must run as a role with SUPERUSER or BYPASSRLS. Otherwise definer functions silently return nothing. See docs/runbooks/deploy.md.");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map(r => r.name as string));
    for (const f of readdirSync(MIGRATIONS_DIR).filter(n => n.endsWith(".sql")).sort()) {
      if (done.has(f)) continue;
      opts.log?.(`applying ${f}`);
      await client.query("BEGIN");
      try {
        await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
        await client.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
        await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727001)").catch(() => {});
    await client.end();
  }
}

function adminUrl(url: string) { const u = new URL(url); u.pathname = "/postgres"; return u.toString(); }
function dbName(url: string) {
  const name = new URL(url).pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`refusing unusual database name: ${name}`);
  return name;
}

export async function createDatabase(url: string) {
  const c = new pg.Client({ connectionString: adminUrl(url) });
  await c.connect();
  try {
    const name = dbName(url);
    const exists = await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (!exists.rowCount) await c.query(`CREATE DATABASE ${name}`);
  } finally { await c.end(); }
}

/** Only ever drops databases prefixed aegis_. */
export async function dropDatabase(url: string) {
  const name = dbName(url);
  if (!name.startsWith("aegis_")) throw new Error(`refusing to drop non-aegis database: ${name}`);
  const c = new pg.Client({ connectionString: adminUrl(url) });
  await c.connect();
  try { await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await c.end(); }
}

/** Creates a passwordless local login role in a connection group. Development and tests only. */
export async function ensureLogin(adminUrl: string, login: string, group: string) {
  if (!/^[a-z_]+$/.test(login) || !/^[a-z_]+$/.test(group)) throw new Error("bad role name");
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query("SELECT pg_advisory_lock(727002)");
    const exists = await c.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [login]);
    if (!exists.rowCount) await c.query(`CREATE ROLE ${login} LOGIN`);
    await c.query(`GRANT ${group} TO ${login}`);
  } finally {
    await c.query("SELECT pg_advisory_unlock(727002)").catch(() => {});
    await c.end();
  }
}

export async function createTestDb(prefix = "t"): Promise<{ url: string; db: Db; drop: () => Promise<void> }> {
  const base = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/postgres";
  const u = new URL(base);
  u.pathname = `/aegis_test_${prefix}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  const url = u.toString();
  await createDatabase(url);
  await migrate(url);
  const db = new Db(url, 5);
  return { url, db, drop: async () => { await db.close(); await dropDatabase(url); } };
}
