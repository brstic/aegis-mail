import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { createTestDb } from "@aegis/db";
import { LocalDevKms } from "@aegis/cryptography";
import { assertContentFree, connectAccount, type Ctx, createPlatform, deleteAccount, disconnectAccount, drainJobs, enqueue, errorCode, getThread, makeLogger, type Platform, retentionSweep, scrub, sealMessage, signUp, updatePrefs, listThreads, cleanMeta } from "../index";
import { deliver, demoAccount, user } from "./harness";

const CANARY = "KUMQUAT-CANARY-8841";
const PASSWORD_CANARY = "imap-password-canary-5521";

describe("data at rest, logs, jobs", () => {
  let p: Platform, url: string, drop: () => Promise<void>, ctx: Ctx, acct: string, msg: any; const logs: string[] = [];
  const dump = async () => {
    const c = new pg.Client({ connectionString: url }); await c.connect();
    const tables = (await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'demo_mailbox'")).rows.map(r => r.tablename);
    const out: Record<string, string> = {};
    for (const t of tables) {
      const rows = (await c.query(`SELECT * FROM ${t}`)).rows;
      out[t] = JSON.stringify(rows, (_k, v) => (v && v.type === "Buffer" ? Buffer.from(v.data).toString("latin1") : v));
    }
    await c.end();
    return out;
  };
  beforeAll(async () => {
    const d = await createTestDb("rest"); url = d.url; drop = d.drop;
    p = createPlatform({ db: d.db, kms: new LocalDevKms(randomBytes(32)), config: { demoMode: true, appOrigin: "http://localhost:3000", webauthnRpId: "localhost" }, log: makeLogger(l => logs.push(l)), env: {} });
    ctx = await user(p, "rest@example.org");
    acct = await demoAccount(p, ctx, "rest@example.org");
    msg = await deliver(p, ctx, acct, { from: `"Canary Sender" <canary.sender@oak.test>`, subject: `Subject ${CANARY}`, text: `Body ${CANARY}`, attachments: [{ filename: `${CANARY}.pdf`, contentType: "application/pdf", content: `%PDF ${CANARY}` }] });
  });
  afterAll(() => drop());

  it("a raw database dump exposes subjects, bodies, senders and filenames only through the disclosed search index", async () => {
    const d = await dump();
    for (const [table, text] of Object.entries(d)) {
      if (table === "message_search") continue; // Disclosed plaintext lexemes, tested below.
      expect(text.toUpperCase().includes(CANARY.slice(0, 7)), `plaintext in ${table}`).toBe(false);
      expect(text.includes("canary.sender"), `sender in ${table}`).toBe(false);
    }
  });
  it("the search index is the disclosed exception, and opting out erases it", async () => {
    expect((await dump()).message_search!.toLowerCase()).toContain("kumquat");
    await updatePrefs(p, ctx, { serverSearchEnabled: false });
    expect((await dump()).message_search!.toLowerCase()).not.toContain("kumquat");
    expect((await listThreads(p, ctx, { view: "inbox", q: "kumquat", limit: 5 })).items).toEqual([]);
  });
  it("logs carry no content, addresses or tokens", () => {
    const all = logs.join("\n");
    expect(all.length).toBeGreaterThan(0);
    expect(all.toUpperCase()).not.toContain("KUMQUAT");
    expect(all).not.toContain("canary.sender");
    expect(all).not.toContain("rest@example.org");
  });
  it("the logger drops unknown fields, even at a careless call site", () => {
    const out: string[] = [];
    makeLogger(l => out.push(l)).info("x", { subject: "secret", body: "secret", token: "secret", accountId: "ok", nested: { a: 1 } });
    expect(out[0]).not.toContain("secret");
    expect(JSON.parse(out[0]!).droppedFields).toBe(4);
    expect(scrub({ errorCode: "x".repeat(500) }).errorCode).toHaveLength(128);
  });
  it("errors are logged by name, not message, since messages can embed tokens", () => {
    expect(errorCode(new Error("Bearer ya29.secret"))).toBe("Error");
  });
  it("job payloads refuse content", async () => {
    expect(() => assertContentFree({ subject: "hi" })).toThrow(/not allowed/);
    expect(() => assertContentFree({ accountId: "x".repeat(200) })).toThrow(/too long/);
    expect(() => assertContentFree({ change: { body: "x" } })).toThrow(/not allowed/);
    await expect(p.db.withSystem(t => enqueue(t, { tenantId: ctx.tenantId, kind: "tick", payload: { text: "secret" } }))).rejects.toThrow();
  });
  it("audit metadata drops unknown fields", () => expect(cleanMeta({ subject: "x", body: "y", role: "ok" })).toEqual({ role: "ok" }));

  it("credentials are stored only as ciphertext", async () => {
    const id = await connectAccount(p, ctx, { kind: "imap", email: "imap@example.org", displayName: "IMAP", credential: { kind: "password", username: "u", password: PASSWORD_CANARY, imap: { host: "imap.example.org", port: 993, security: "tls" } } });
    await p.db.withSystem(t => t.query("UPDATE jobs SET state='cancelled' WHERE payload->>'accountId'=$1", [id]));
    const d = await dump();
    for (const [table, text] of Object.entries(d)) expect(text.includes(PASSWORD_CANARY), table).toBe(false);
    expect(logs.join("").includes(PASSWORD_CANARY)).toBe(false);
  });

  it("client-sealed mode: after sealing, the server can't produce the body", async () => {
    const m2 = await deliver(p, ctx, acct, { from: "a@b.test", subject: "Sealed", text: "seal me KIWI-99" });
    await sealMessage(p, ctx, m2.id, { ciphertext: randomBytes(64).toString("base64"), meta: { alg: "AES-GCM", kdf: "PBKDF2-SHA256", iterations: 600000, salt: "c2FsdA==", iv: "aXY=", v: 1 } });
    const t = await getThread(p, ctx, m2.thread_id);
    expect(t.messages[0]!.sealed).toBe(true);
    expect(t.messages[0]!.text).toBe("");
    expect(JSON.stringify(await dump())).not.toContain("KIWI-99");
  });

  it("retention deletes bodies and keeps tombstones so sync doesn't resurrect them", async () => {
    await p.db.withSystem(t => t.query("UPDATE tenant_policies SET retention_days=1 WHERE tenant_id=$1", [ctx.tenantId]));
    await p.db.withWorker(ctx.tenantId, t => t.query("UPDATE messages SET internal_date=now() - interval '10 days' WHERE id=$1", [msg.id]));
    expect(await retentionSweep(p, ctx.tenantId)).toBeGreaterThan(0);
    const row = await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT tombstoned_at, envelope_enc FROM messages WHERE id=$1", [msg.id]));
    expect(row.tombstoned_at).not.toBeNull();
    expect(row.envelope_enc).toBeNull();
    await p.db.withSystem(t => t.query("UPDATE sync_states SET cursor_enc=NULL, phase='initial' WHERE account_id=$1", [acct]));
    await p.db.withSystem(t => enqueue(t, { tenantId: ctx.tenantId, kind: "sync.account", payload: { accountId: acct } }));
    await drainJobs(p);
    const after = await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT tombstoned_at FROM messages WHERE id=$1", [msg.id]));
    expect(after.tombstoned_at).not.toBeNull();
  });
});

describe("disconnect and account deletion", () => {
  let p: Platform, url: string, drop: () => Promise<void>;
  beforeAll(async () => {
    const d = await createTestDb("del"); url = d.url; drop = d.drop;
    p = createPlatform({ db: d.db, kms: new LocalDevKms(randomBytes(32)), config: { demoMode: true, appOrigin: "http://localhost:3000", webauthnRpId: "localhost" }, log: makeLogger(() => {}), env: {} });
  });
  afterAll(() => drop());

  it("disconnect with delete removes credential, messages and cancels jobs", async () => {
    const ctx = await user(p, "dc@example.org");
    const acct = await demoAccount(p, ctx, "dc@example.org");
    await deliver(p, ctx, acct, { from: "a@b.test", subject: "x", text: "x" });
    const r = await disconnectAccount(p, ctx, acct, { deleteData: true });
    expect(r.revokeSupported).toBe(true);
    await drainJobs(p);
    const c = new pg.Client({ connectionString: url }); await c.connect();
    for (const t of ["messages", "message_contents", "credential_envelopes", "threads"]) expect((await c.query(`SELECT 1 FROM ${t} WHERE account_id=$1`, [acct])).rowCount, t).toBe(0);
    await c.end();
  });

  it("disconnect without delete stops sync but keeps cache", async () => {
    const ctx = await user(p, "dk@example.org");
    const acct = await demoAccount(p, ctx, "dk@example.org");
    await deliver(p, ctx, acct, { from: "a@b.test", subject: "keep", text: "x" });
    await disconnectAccount(p, ctx, acct, { deleteData: false });
    await drainJobs(p);
    expect((await listThreads(p, ctx, { view: "inbox", limit: 5 })).items).toHaveLength(1);
    await p.db.withSystem(t => enqueue(t, { tenantId: ctx.tenantId, kind: "sync.account", payload: { accountId: acct } }));
    await drainJobs(p);
    const cred = await p.db.withWorker(ctx.tenantId, t => t.one("SELECT 1 FROM credential_envelopes WHERE account_id=$1", [acct]));
    expect(cred).toBeNull();
  });

  it("deleting a personal account crypto-shreds its tenant keys, making backups unreadable", async () => {
    const s = await signUp(p, { email: "shred@example.org", password: "correct-horse-battery", name: "Shred", workspaceKind: "personal" });
    const ctx = { tenantId: s.tenantId, userId: s.userId };
    const acct = await demoAccount(p, ctx, "shred@example.org");
    await deliver(p, ctx, acct, { from: "a@b.test", subject: "x", text: "x" });
    const sealedBackup = await p.envelope.seal({ tenantId: ctx.tenantId, keyClass: "body", table: "backup", recordId: "r" }, "backup copy");
    await deleteAccount(p, ctx, { confirmEmail: "shred@example.org", email: "shred@example.org", password: "correct-horse-battery" });
    await drainJobs(p);
    await expect(p.envelope.open({ tenantId: ctx.tenantId, keyClass: "body", table: "backup", recordId: "r" }, sealedBackup)).rejects.toThrow();
    const u = await p.db.withSystem(t => t.one<any>("SELECT email, password_hash FROM users WHERE id=$1", [ctx.userId]));
    expect(u.email).toContain("deleted-");
    expect(u.password_hash).toBeNull();
  });
});
