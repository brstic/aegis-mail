import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createDatabase, Db, dropDatabase, ensureLogin } from "@aegis/db";
import { KeyDestroyedError } from "@aegis/cryptography";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyChange, type Ctx, createPlatform, DeletionLogBrokenError, type DeletionEntry, deleteAccount, disconnectAccount, drainJobs, FileDeletionSink, getThread, listThreads, type LogLine, makeLogger, type Platform, reapplyDeletions, reapStuckJobs, removeMember, resolveSession, retentionSweep, sealMessage, shipDeletionLog, signIn, tick, updatePrefs, verifyLogText } from "../index";
import { deliver, demoAccount, testPlatform, user } from "./harness";

const run = promisify(execFile);
const SECRET = "RESTORE-DRILL-SENTINEL";

/** A real pg_dump and pg_restore into a second database. What a backup can and can't do is a promise in the privacy docs, so it's tested. */
const hasTools = (() => { try { execFileSync("pg_dump", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
describe.skipIf(!hasTools)("restore drill", () => {
  let p: Platform, drop: () => Promise<void>, ctx: Ctx & { token: string }, threadId: string, sourceUrl: string, restoredUrl: string, restored: Db, dir: string;
  const email = "drill@fernhill.example";

  beforeAll(async () => {
    ({ p, drop } = await testPlatform());
    ctx = await user(p, email);
    const acct = await demoAccount(p, ctx, email);
    // Enough of each kind of content to reach everything derived from it: a task, a due date, a summary, an attachment, a contact.
    threadId = (await deliver(p, ctx, acct, { from: `"SenderNameSentinel" <sal@client.test>`, subject: `SubjectSentinel contract`, text: `Can you check ${SECRET} and send the contract by Friday? Please review BodySentinel too.`, attachments: [{ filename: "FilenameSentinel.pdf", contentType: "application/pdf", content: "%PDF-1.4 AttachmentSentinel" }] })).thread_id;
    const name = await p.db.withSystem(t => t.one<{ d: string }>("SELECT current_database() AS d"));
    const base = new URL(process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/postgres");
    base.pathname = `/${name!.d}`;
    sourceUrl = base.toString();
    base.pathname = `/${name!.d}_restored`;
    restoredUrl = base.toString();
    dir = mkdtempSync(join(tmpdir(), "aegis-drill-"));
    await run("pg_dump", ["-Fc", "-f", join(dir, "backup.dump"), sourceUrl]);
    await createDatabase(restoredUrl);
    await run("pg_restore", ["--no-owner", "--dbname", restoredUrl, join(dir, "backup.dump")]);
    restored = new Db(restoredUrl);
  }, 120_000);
  afterAll(async () => {
    await restored?.close();
    if (restoredUrl) await dropDatabase(restoredUrl);
    if (dir) rmSync(dir, { recursive: true, force: true });
    await drop();
  });

  const fromBackup = (kms: Platform["kms"]) => createPlatform({ db: restored, kms, config: p.config, log: p.log });

  it("a restored database opens mail, with the same KMS", async () => {
    const t = await getThread(fromBackup(p.kms), ctx, threadId);
    expect(t.messages[0]!.text).toContain(SECRET);
  });

  it("the only readable message content in the backup is the disclosed search index", async () => {
    const { stdout } = await run("pg_restore", ["--data-only", "-f", "-", join(dir, "backup.dump")], { maxBuffer: 512 * 1024 * 1024 });
    const tablesWith = (needle: string) => {
      const hits = new Set<string>();
      let table = "";
      for (const line of stdout.split("\n")) {
        const m = line.match(/^COPY (\S+)/);
        if (m) table = m[1]!;
        if (line.includes(needle)) hits.add(table);
      }
      return [...hits].sort();
    };
    // Nothing keeps these as written. demo_mailbox.raw would, but it's bytea, stands in for Gmail's own storage, and demo mailboxes are refused outside demo mode.
    for (const needle of [SECRET, "SubjectSentinel", "SenderNameSentinel", "BodySentinel", "FilenameSentinel", "AttachmentSentinel"]) expect(tablesWith(needle), needle).toEqual([]);
    // The search index lowercases, and is the plaintext the Privacy Center discloses, with an opt-out. Nothing else may hold the words.
    for (const needle of ["restore-drill-sentinel", "subjectsentinel", "bodysentinel", "sal@client.test"]) expect(tablesWith(needle), needle).toEqual(["public.message_search"]);
  });

  it("a backup taken before an account is deleted stays readable until it expires, so backup expiry is part of the deletion promise", async () => {
    await deleteAccount(p, ctx, { confirmEmail: email, email, password: "correct-horse-battery" });
    await expect(getThread(p, ctx, threadId)).rejects.toBeTruthy();
    // Deleting the wrapped tenant key from the live database doesn't touch the copy of it in the backup, and the root key still unwraps it.
    const t = await getThread(fromBackup(p.kms), ctx, threadId);
    expect(t.messages[0]!.text).toContain(SECRET);
  });
});

const PASSWORD = "correct-horse-battery";
const CIPHERTEXT = { ciphertext: Buffer.alloc(64, 7).toString("base64"), meta: { alg: "AES-GCM" as const, kdf: "PBKDF2-SHA256" as const, iterations: 600_000, salt: "c2FsdA", iv: "aXY", v: 1 as const } };
/** What must never reach the log: addresses, names, subjects, bodies, filenames. */
const CONTENT = ["@fernhill.example", "@client.test", "PersonNameSentinel", "SubjectSentinel", "BodySentinel", "FilenameSentinel", "subjectsentinel", "bodysentinel"];

/**
 * The deletion log against real dumps. A backup is taken, then everything that erases runs and ships through the real job queue, then the
 * backup is restored into a fresh database for each case. Reapply runs on the restore operator's own login, never as an owner.
 */
describe.skipIf(!hasTools)("deletion log against real backups", () => {
  let p: Platform, drop: () => Promise<void>, dir: string, logPath: string, baseUrl: URL, dump: string;
  const restores: { url: string; admin: Db; op: Db }[] = [];
  type Who = Ctx & { token: string };
  let gone: Who, goneThread: string, mover: Who, moverGone: string, moverGoneThread: string, moverKept: string, moverKeptThread: string, moverIdle: string, sealer: Who, sealedMsg: string, sealedThread: string, otherThread: string, retained: Who, oldThread: string, freshThread: string, searcher: Who, searcherThread: string, survivor: Who, survivorThread: string, orgOwner: Who, leaver: Who, leaverMailbox: string, leaverThread: string, early: Who, earlySealed: string, providerGone: { accountId: string; thread: string; remoteId: string; tenantId: string };

  const mail = (who: string) => ({ from: `"PersonNameSentinel ${who}" <sal@client.test>`, subject: `SubjectSentinel ${who}`, text: `BodySentinel ${who} please review`, attachments: [{ filename: `FilenameSentinel${who}.pdf`, contentType: "application/pdf", content: "%PDF-1.4 x" }] });
  const person = async (name: string, opts: { kind?: "personal" | "organization" } = {}) => user(p, `${name}@fernhill.example`, opts);

  const logLines = (path = logPath) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as LogLine);
  const copyLog = (tag: string, edit?: (lines: string[]) => string) => {
    const to = join(dir, `${tag}.log`);
    copyFileSync(logPath, to);
    if (edit) writeFileSync(to, edit(readFileSync(to, "utf8").split("\n").slice(0, -1)));
    return to;
  };
  const asLogin = (url: string, login: string) => { const u = new URL(url); u.username = login; return u.toString(); };

  const restore = async (tag: string, from = dump) => {
    const u = new URL(baseUrl);
    u.pathname = `${baseUrl.pathname}_${tag}`;
    const url = u.toString();
    await createDatabase(url);
    await run("pg_restore", ["--no-owner", "--dbname", url, from]);
    await ensureLogin(url, "aegis_restore_login", "aegis_restore_conn");
    const r = { url, admin: new Db(url, 4), op: new Db(asLogin(url, "aegis_restore_login"), 4) };
    restores.push(r);
    return r;
  };
  const platformOn = (db: Db) => createPlatform({ db, kms: p.kms, config: p.config, log: makeLogger(() => {}), env: {}, deletionSink: null });
  const readable = async (db: Db, c: Ctx, thread: string) => (await getThread(platformOn(db), c, thread)).messages[0]!.text;
  const count = async (db: Db, sql: string, params: unknown[] = []) => (await db.withSystem(t => t.one<{ c: number }>(`SELECT count(*)::int c FROM ${sql}`, params)))!.c;
  const everything = async (db: Db) => {
    const out: Record<string, number> = {};
    for (const table of ["users", "memberships", "mail_accounts", "messages", "message_contents", "message_search", "attachments", "tenant_keys", "credential_envelopes", "threads", "audit_events", "jobs"]) out[table] = await count(db, table);
    out.scrubbed = await count(db, "users WHERE deleted_at IS NOT NULL");
    return out;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "aegis-deletion-log-"));
    logPath = join(dir, "deletions.log");
    ({ p, drop } = await testPlatform({ deletionSink: new FileDeletionSink(logPath) }));
    const name = await p.db.withSystem(t => t.one<{ d: string }>("SELECT current_database() AS d"));
    baseUrl = new URL(process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/postgres");
    baseUrl.pathname = `/${name!.d}`;

    gone = await person("gone");
    goneThread = (await deliver(p, gone, await demoAccount(p, gone, "gone@fernhill.example"), mail("gone"))).thread_id;

    mover = await person("mover");
    moverGone = await demoAccount(p, mover, "mover-a@fernhill.example");
    moverKept = await demoAccount(p, mover, "mover-b@fernhill.example");
    moverIdle = await demoAccount(p, mover, "mover-c@fernhill.example");
    moverGoneThread = (await deliver(p, mover, moverGone, mail("moverGone"))).thread_id;
    moverKeptThread = (await deliver(p, mover, moverKept, mail("moverKept"))).thread_id;
    await deliver(p, mover, moverIdle, mail("moverIdle"));

    sealer = await person("sealer");
    const sealerBox = await demoAccount(p, sealer, "sealer@fernhill.example");
    const toSeal = await deliver(p, sealer, sealerBox, mail("sealed"));
    sealedMsg = toSeal.id; sealedThread = toSeal.thread_id;
    otherThread = (await deliver(p, sealer, sealerBox, mail("unsealed"))).thread_id;

    retained = await person("retained");
    const retainedBox = await demoAccount(p, retained, "retained@fernhill.example");
    oldThread = (await deliver(p, retained, retainedBox, mail("old"), { hoursAgo: 24 * 90 })).thread_id;
    freshThread = (await deliver(p, retained, retainedBox, mail("fresh"))).thread_id;

    searcher = await person("searcher");
    searcherThread = (await deliver(p, searcher, await demoAccount(p, searcher, "searcher@fernhill.example"), mail("searcher"))).thread_id;

    orgOwner = await person("orgowner", { kind: "organization" });
    leaver = await person("leaver");
    await p.db.withSystem(t => t.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES ($1,$2,'member')", [orgOwner.tenantId, leaver.userId]));
    const leaverCtx = { tenantId: orgOwner.tenantId, userId: leaver.userId };
    leaverMailbox = await demoAccount(p, leaverCtx, "leaver@fernhill.example");
    leaverThread = (await deliver(p, leaverCtx, leaverMailbox, mail("leaver"))).thread_id;

    const prov = await person("provider");
    const provBox = await demoAccount(p, prov, "provider@fernhill.example");
    const provMsg = await deliver(p, prov, provBox, mail("provider"));
    providerGone = { accountId: provBox, thread: provMsg.thread_id, remoteId: provMsg.remoteId, tenantId: prov.tenantId };

    survivor = await person("survivor");
    survivorThread = (await deliver(p, survivor, await demoAccount(p, survivor, "survivor@fernhill.example"), mail("survivor"))).thread_id;

    // Before the backup, and shipped: so the backup holds a witness of the log, and a seal it must keep.
    early = await person("early");
    const earlyMsg = await deliver(p, early, await demoAccount(p, early, "early@fernhill.example"), mail("early"));
    earlySealed = earlyMsg.id;
    await sealMessage(p, early, earlySealed, CIPHERTEXT);
    await drainJobs(p);

    dump = join(dir, "backup.dump");
    await run("pg_dump", ["-Fc", "-f", dump, baseUrl.toString()]);

    // Everything below is what the backup doesn't know about.
    await deleteAccount(p, gone, { confirmEmail: "gone@fernhill.example", email: "gone@fernhill.example", password: PASSWORD });
    await disconnectAccount(p, mover, moverGone, { deleteData: true });
    await disconnectAccount(p, mover, moverIdle, { deleteData: false });
    await sealMessage(p, sealer, sealedMsg, CIPHERTEXT);
    await p.db.withSystem(t => t.query("UPDATE tenant_policies SET retention_days=30 WHERE tenant_id=$1", [retained.tenantId]));
    expect(await retentionSweep(p, retained.tenantId)).toBe(1);
    await updatePrefs(p, searcher, { serverSearchEnabled: false });
    await removeMember(p, orgOwner, leaver.userId);
    await p.db.withWorker(providerGone.tenantId, t => t.query("UPDATE demo_mailbox SET deleted=true WHERE account_id=$1 AND remote_id=$2", [providerGone.accountId, providerGone.remoteId]));
    const provAccount = await p.db.withWorker(providerGone.tenantId, t => t.one<any>("SELECT * FROM mail_accounts WHERE id=$1", [providerGone.accountId]));
    await applyChange(p, provAccount, { fetchRaw: async () => Buffer.alloc(0) }, { type: "delete", remoteId: providerGone.remoteId });
    await drainJobs(p);
  }, 240_000);

  afterAll(async () => {
    for (const r of restores) { await r.op.close(); await r.admin.close(); await dropDatabase(r.url); }
    if (dir) rmSync(dir, { recursive: true, force: true });
    await drop();
  });

  it("the worker's real job shipped every kind of erasure, with an empty job payload", async () => {
    const kinds = logLines().map(l => l.kind);
    expect(new Set(kinds)).toEqual(new Set(["account", "tenant_shred", "mailbox", "credential", "message_sealed", "message_purged", "search_off"]));
    expect(await count(p.db, "deletion_outbox WHERE shipped_at IS NULL")).toBe(0);
    const jobs = await p.db.withSystem(t => t.query<any>("SELECT state, payload FROM jobs WHERE kind='deletion.ship'"));
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) { expect(j.state).toBe("done"); expect(j.payload).toEqual({}); }
    expect(verifyLogText(readFileSync(logPath, "utf8")).problems).toEqual([]);
  });

  it("a mailbox recorded on both the web and worker paths is one entry", () => {
    expect(logLines().filter(l => l.kind === "mailbox" && l.accountId === moverGone)).toHaveLength(1);
    expect(logLines().filter(l => l.kind === "mailbox" && l.accountId === leaverMailbox)).toHaveLength(1);
  });

  it("the log holds only ids, a kind and a time, in the file and in the outbox", async () => {
    const text = readFileSync(logPath, "utf8");
    for (const needle of CONTENT) expect(text, needle).not.toContain(needle);
    const allowed = new Set(["v", "seq", "id", "kind", "tenantId", "userId", "accountId", "messageId", "at", "prev", "hash"]);
    for (const l of logLines()) {
      for (const [k, v] of Object.entries(l)) {
        expect(allowed.has(k), k).toBe(true);
        if (v === null || k === "v" || k === "seq") continue;
        if (k === "at") expect(v).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
        else if (k === "kind") expect(v).toMatch(/^[a-z_]+$/);
        else if (k === "prev" || k === "hash") expect(v).toMatch(/^[0-9a-f]{64}$/);
        else expect(v).toMatch(/^[0-9a-f-]{36}$/);
      }
    }
    const rows = JSON.stringify(await p.db.withSystem(t => t.query("SELECT * FROM deletion_outbox")));
    for (const needle of CONTENT) expect(rows, needle).not.toContain(needle);
  });

  it("restoring brings the deleted data back, and reapply erases it again on the operator's own login", async () => {
    const r = await restore("main");
    const goneKeysBefore = await count(r.admin, "tenant_keys WHERE tenant_id=$1", [gone.tenantId]);
    expect(goneKeysBefore).toBeGreaterThan(0);

    // The current behaviour, and why this exists.
    expect(await readable(r.admin, gone, goneThread)).toContain("BodySentinel gone");
    expect(await readable(r.admin, mover, moverGoneThread)).toContain("BodySentinel moverGone");
    expect(await readable(r.admin, sealer, sealedThread)).toContain("BodySentinel sealed");
    expect(await readable(r.admin, retained, oldThread)).toContain("BodySentinel old");
    expect(await readable(r.admin, { tenantId: orgOwner.tenantId, userId: leaver.userId }, leaverThread)).toContain("BodySentinel leaver");
    expect(await count(r.admin, "message_search WHERE tenant_id=$1", [searcher.tenantId])).toBeGreaterThan(0);
    expect(await count(r.admin, "message_search WHERE tenant_id=$1", [gone.tenantId])).toBeGreaterThan(0);
    expect((await listThreads(platformOn(r.admin), gone, { view: "inbox", limit: 10 })).items.length).toBeGreaterThan(0);
    expect((await resolveSession(platformOn(r.admin), gone.token))?.email).toBe("gone@fernhill.example");
    await signIn(platformOn(r.admin), { email: "gone@fernhill.example", password: PASSWORD });
    const sealedCipher = (await r.admin.withSystem(t => t.one<{ blob_enc: Buffer }>("SELECT blob_enc FROM message_contents WHERE message_id=$1", [sealedMsg])))!.blob_enc;
    expect(sealedCipher).toBeTruthy();
    const goneRow = await r.admin.withSystem(t => t.one<{ id: string; envelope_enc: Buffer }>("SELECT id, envelope_enc FROM messages WHERE tenant_id=$1 AND envelope_enc IS NOT NULL LIMIT 1", [gone.tenantId]));
    const earlyBlob = (await r.admin.withSystem(t => t.one<{ sealed_blob: Buffer }>("SELECT sealed_blob FROM message_contents WHERE message_id=$1", [earlySealed])))!.sealed_blob;
    expect(earlyBlob).toBeTruthy();

    const report = await reapplyDeletions(r.op, logPath);
    expect(report.chain.ok).toBe(true);
    expect(report.chain.witnessRows).toBeGreaterThan(0);
    expect(report.applied).toMatchObject({ account: 1, tenant_shred: 0, mailbox: 3, credential: 1, message_sealed: 1, message_purged: 2, search_off: 1 });
    expect(report.alreadyErased.tenant_shred).toBe(1);
    expect(JSON.stringify(report)).not.toMatch(/fernhill|Sentinel/i);

    // Deleted account: unreadable, unlisted, and no way in.
    await expect(readable(r.admin, gone, goneThread)).rejects.toBeTruthy();
    expect((await listThreads(platformOn(r.admin), gone, { view: "inbox", limit: 10 })).items).toEqual([]);
    expect((await listThreads(platformOn(r.admin), gone, { view: "inbox", q: "bodysentinel", limit: 10 })).items).toEqual([]);
    expect(await count(r.admin, "message_search WHERE tenant_id=$1", [gone.tenantId])).toBe(0);
    expect(await resolveSession(platformOn(r.admin), gone.token)).toBeNull();
    await expect(signIn(platformOn(r.admin), { email: "gone@fernhill.example", password: PASSWORD })).rejects.toBeTruthy();
    const scrubbed = await r.admin.withSystem(t => t.one<any>("SELECT email, name, password_hash, deleted_at FROM users WHERE id=$1", [gone.userId]));
    expect(scrubbed).toMatchObject({ email: `deleted-${gone.userId}@deleted.invalid`, name: "Deleted user", password_hash: null });
    expect(scrubbed.deleted_at).toBeTruthy();

    // Crypto-shred: the restored wrapped keys are really gone, so a ciphertext taken before the replay no longer opens, even with the root key.
    expect(await count(r.admin, "tenant_keys WHERE tenant_id=$1", [gone.tenantId])).toBe(0);
    await expect(platformOn(r.admin).envelope.open({ tenantId: gone.tenantId, keyClass: "body", table: "messages", recordId: goneRow!.id }, goneRow!.envelope_enc)).rejects.toBeInstanceOf(KeyDestroyedError);

    // Disconnected with deletion: gone. Its sibling kept its mail, and the one disconnected with "keep" stays down.
    await expect(readable(r.admin, mover, moverGoneThread)).rejects.toBeTruthy();
    expect(await count(r.admin, "mail_accounts WHERE id=$1", [moverGone])).toBe(0);
    expect(await count(r.admin, "credential_envelopes WHERE account_id=$1", [moverGone])).toBe(0);
    expect(await readable(r.admin, mover, moverKeptThread)).toContain("BodySentinel moverKept");
    expect(await count(r.admin, "credential_envelopes WHERE account_id=$1", [moverKept])).toBe(1);
    expect(await count(r.admin, "credential_envelopes WHERE account_id=$1", [moverIdle])).toBe(0);
    expect((await r.admin.withSystem(t => t.one<any>("SELECT status FROM mail_accounts WHERE id=$1", [moverIdle])))!.status).toBe("disconnected");
    expect(await count(r.admin, "messages WHERE account_id=$1", [moverIdle])).toBeGreaterThan(0);

    // Sealed after the backup: the server's copy is erased, and the ciphertext never reached this backup, so the body is gone here.
    expect(await readable(r.admin, sealer, sealedThread)).toBe("");
    expect((await r.admin.withSystem(t => t.one<any>("SELECT blob_enc, sealed_blob FROM message_contents WHERE message_id=$1", [sealedMsg])))).toEqual({ blob_enc: null, sealed_blob: null });
    expect(await count(r.admin, "message_search WHERE message_id=$1", [sealedMsg])).toBe(0);
    expect(await count(r.admin, "attachments WHERE message_id=$1 AND blob_enc IS NOT NULL", [sealedMsg])).toBe(0);
    expect(await readable(r.admin, sealer, otherThread)).toContain("BodySentinel unsealed");
    // Sealed before the backup: already in it, and the replay must not destroy the only copy of the ciphertext.
    expect((await r.admin.withSystem(t => t.one<{ sealed_blob: Buffer }>("SELECT sealed_blob FROM message_contents WHERE message_id=$1", [earlySealed])))!.sealed_blob).toEqual(earlyBlob);

    // The other erasures.
    await expect(readable(r.admin, retained, oldThread)).rejects.toBeTruthy();
    expect(await readable(r.admin, retained, freshThread)).toContain("BodySentinel fresh");
    await expect(readable(r.admin, { tenantId: providerGone.tenantId, userId: await providerOwner(r.admin) }, providerGone.thread)).rejects.toBeTruthy();
    expect(await count(r.admin, "message_search WHERE tenant_id=$1", [searcher.tenantId])).toBe(0);
    expect((await r.admin.withSystem(t => t.one<any>("SELECT prefs FROM user_preferences WHERE user_id=$1", [searcher.userId])))!.prefs.serverSearchEnabled).toBe(false);
    expect(await readable(r.admin, searcher, searcherThread)).toContain("BodySentinel searcher");
    expect(await count(r.admin, "mail_accounts WHERE id=$1", [leaverMailbox])).toBe(0);

    // A second, untouched tenant's mail is intact, and so are its keys, search words and session.
    expect(await readable(r.admin, survivor, survivorThread)).toContain("BodySentinel survivor");
    expect((await listThreads(platformOn(r.admin), survivor, { view: "inbox", q: "bodysentinel", limit: 10 })).items).toHaveLength(1);
    expect((await resolveSession(platformOn(r.admin), survivor.token))?.email).toBe("survivor@fernhill.example");

    // A dump of what was re-applied holds none of it, and the survivor's words still.
    const after = join(dir, "after.dump");
    await run("pg_dump", ["-Fc", "-f", after, r.url]);
    const { stdout } = await run("pg_restore", ["--data-only", "-f", "-", after], { maxBuffer: 512 * 1024 * 1024 });
    expect(stdout).not.toContain("'gone'");
    expect(stdout).not.toContain("'moverg'");
    expect(stdout).toContain("'survivor'");

    // Reapply doesn't log itself: a restore mustn't grow the log, or it would be replaying its own replays.
    expect(await count(r.admin, "deletion_outbox WHERE erased_at > now() - interval '1 second' AND shipped_at IS NULL")).toBe(0);
  }, 120_000);
  const providerOwner = async (db: Db) => (await db.withSystem(t => t.one<{ owner_user_id: string }>("SELECT owner_user_id FROM mail_accounts WHERE id=$1", [providerGone.accountId])))!.owner_user_id;

  it("the backup file itself isn't touched: restored again, the deleted data is still readable until it expires", async () => {
    const r = await restore("again");
    expect(await readable(r.admin, gone, goneThread)).toContain("BodySentinel gone");
  }, 60_000);

  it("a replay run twice changes nothing the second time", async () => {
    const r = await restore("twice");
    const first = await reapplyDeletions(r.op, logPath);
    const before = await everything(r.admin);
    const second = await reapplyDeletions(r.op, logPath);
    expect(Object.values(first.applied).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(Object.values(second.applied).every(n => n === 0)).toBe(true);
    expect(await everything(r.admin)).toEqual(before);
    expect(await readable(r.admin, survivor, survivorThread)).toContain("BodySentinel survivor");
  }, 60_000);

  it("the operator's login can't read a password hash, can't become a request context, and can't read mail outside a tenant context", async () => {
    const r = await restore("role");
    await expect(r.op.withSystem(t => t.query("SELECT password_hash FROM users"))).rejects.toThrow(/permission denied/);
    await expect(r.op.withSystem(t => t.query("SELECT totp_secret_enc FROM users"))).rejects.toThrow(/permission denied/);
    await expect(r.op.withUser(survivor, t => t.query("SELECT 1"))).rejects.toThrow(/permission denied to set role/);
    for (const table of ["messages", "message_contents", "message_search", "credential_envelopes", "tenant_keys"]) await expect(r.op.withSystem(t => t.query(`SELECT * FROM ${table}`)), table).rejects.toThrow(/permission denied/);
    await expect(r.op.withWorker(survivor.tenantId, t => t.query("SELECT 1 FROM tenant_keys WHERE tenant_id=$1", [gone.tenantId]))).resolves.toEqual([]);
  }, 60_000);

  const refused = async (r: { op: Db; admin: Db }, path: string, code: string, opts = {}) => {
    const before = await everything(r.admin);
    const err = await reapplyDeletions(r.op, path, opts).catch(e => e);
    expect(err).toBeInstanceOf(DeletionLogBrokenError);
    expect(err.problems.map((x: any) => x.code)).toContain(code);
    expect(err.message).toMatch(/Nothing was applied/);
    expect(err.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    // Not partly applied: the deleted account and its mail are still exactly as restored.
    expect(await everything(r.admin)).toEqual(before);
    expect(await readable(r.admin, gone, goneThread)).toContain("BodySentinel gone");
  };

  it("a tampered line stops it before anything is applied", async () => {
    const r = await restore("tamper");
    const target = logLines().findIndex(l => l.kind === "mailbox");
    await refused(r, copyLog("tampered", lines => {
      const l = JSON.parse(lines[target]!);
      l.tenantId = survivor.tenantId; // Pointing a deletion at someone else.
      lines[target] = JSON.stringify(l);
      return `${lines.join("\n")}\n`;
    }), "hash_mismatch");
    // Rehashing the line isn't enough either: the next line no longer follows from it.
    await refused(r, copyLog("rehashed", lines => {
      const l = JSON.parse(lines[0]!);
      l.hash = "a".repeat(64);
      lines[0] = JSON.stringify(l);
      return `${lines.join("\n")}\n`;
    }), "hash_mismatch");
    await refused(r, copyLog("extra", lines => {
      const l = JSON.parse(lines[0]!);
      l.email = "someone@fernhill.example";
      lines[0] = JSON.stringify(l);
      return `${lines.join("\n")}\n`;
    }), "not_allowed");
  }, 60_000);

  it("the override applies the lines that hold together, and leaves out and reports the one that doesn't", async () => {
    const r = await restore("override");
    const target = logLines().findIndex(l => l.kind === "mailbox" && l.accountId === moverGone);
    const path = copyLog("override", lines => {
      const l = JSON.parse(lines[target]!);
      l.tenantId = survivor.tenantId;
      lines[target] = JSON.stringify(l);
      return `${lines.join("\n")}\n`;
    });
    const report = await reapplyDeletions(r.op, path, { allowBrokenChain: true });
    expect(report.chain.ok).toBe(false);
    expect(report.chain.problems).toContainEqual({ line: target + 1, code: "hash_mismatch" });
    expect(report.skippedLines).toBe(1);
    // The forged line did nothing to the survivor, and its real deletion wasn't applied, which is what the warning is for.
    expect(await readable(r.admin, survivor, survivorThread)).toContain("BodySentinel survivor");
    expect(await readable(r.admin, mover, moverGoneThread)).toContain("BodySentinel moverGone");
    await expect(readable(r.admin, gone, goneThread)).rejects.toBeTruthy();
  }, 60_000);

  it("a truncated log stops it: cut from the middle, from the start, or mid-line", async () => {
    const r = await restore("cut");
    const n = logLines().length;
    expect(n).toBeGreaterThan(4);
    await refused(r, copyLog("middle", lines => `${lines.filter((_, i) => i !== 3).join("\n")}\n`), "seq_gap");
    await refused(r, copyLog("start", lines => `${lines.slice(2).join("\n")}\n`), "seq_gap");
    await refused(r, copyLog("torn", lines => `${lines.join("\n")}\n`.slice(0, -40)), "torn_tail");
  }, 60_000);

  it("whole lines cut from the end: the database witness catches what it knew of, --expect-head catches the rest, and without either the head is reported", async () => {
    const r = await restore("tail");
    const shippedBeforeBackup = await count(r.admin, "deletion_outbox WHERE sink_seq IS NOT NULL");
    expect(shippedBeforeBackup).toBeGreaterThan(0);
    await refused(r, copyLog("below-witness", lines => `${lines.slice(0, shippedBeforeBackup - 1).join("\n")}${shippedBeforeBackup > 1 ? "\n" : ""}`), "witness_missing");
    await refused(r, copyLog("empty", () => ""), "witness_missing");

    const all = logLines();
    const realHead = { seq: all[all.length - 1]!.seq, hash: all[all.length - 1]!.hash };
    const cut = copyLog("tail-cut", lines => `${lines.slice(0, -2).join("\n")}\n`);
    await refused(r, cut, "head_mismatch", { expectHead: realHead });

    // No witness outside the file knows about those last lines. A hash chain can't show its own end was removed, so this is reported, not caught.
    const verified = await reapplyDeletions(r.op, cut, { verifyOnly: true });
    expect(verified.chain.ok).toBe(true);
    expect(verified.chain.head.seq).toBe(realHead.seq - 2);
    expect(await readable(r.admin, gone, goneThread)).toContain("BodySentinel gone");
    // Nor can a file show a chain rewritten from scratch by someone holding it. The witness can, for what it knew of.
    const forgedPath = join(dir, "forged.log");
    await new FileDeletionSink(forgedPath).append(all.map(({ v: _v, seq: _s, prev: _p, hash: _h, ...e }, i) => i === 0 ? { ...e, at: "2020-01-01T00:00:00.000Z" } : e));
    expect(verifyLogText(readFileSync(forgedPath, "utf8")).problems).toEqual([]);
    await refused(r, forgedPath, "witness_mismatch");
  }, 60_000);

  it("a run that dies part way through an account is finished by running it again, including the shred", async () => {
    const r = await restore("interrupted");
    const flaky = Object.create(r.op) as Db;
    flaky.withSystem = fn => r.op.withSystem(t => fn({ ...t, query: (sql: string, params?: unknown[]) => { if (sql.startsWith("UPDATE sessions")) throw new Error("connection lost"); return t.query(sql, params); } } as never));
    await expect(reapplyDeletions(flaky, logPath)).rejects.toThrow(/connection lost/);
    // The keys went before the memberships that lead to them, so the rerun can't lose track of the tenant.
    expect(await count(r.admin, "tenant_keys WHERE tenant_id=$1", [gone.tenantId])).toBe(0);
    expect(await count(r.admin, "users WHERE id=$1 AND deleted_at IS NULL", [gone.userId])).toBe(1);
    await reapplyDeletions(r.op, logPath);
    expect(await count(r.admin, "users WHERE id=$1 AND deleted_at IS NULL", [gone.userId])).toBe(0);
    expect(await count(r.admin, "memberships WHERE user_id=$1", [gone.userId])).toBe(0);
  }, 60_000);

  it("a suspended workspace's shred that never ran live stays queued, like the live one, instead of jumping the hold", async () => {
    const r = await restore("held");
    await r.admin.withSystem(t => t.query("INSERT INTO tenant_suspensions(tenant_id,reason) VALUES ($1,'investigation')", [gone.tenantId]));
    const noShred = join(dir, "no-shred.log");
    await new FileDeletionSink(noShred).append(logLines().filter(l => l.kind === "account").map(({ v: _v, seq: _s, prev: _p, hash: _h, ...e }) => e));
    const report = await reapplyDeletions(r.op, noShred, { allowBrokenChain: true });
    expect(report.shredsQueued).toBe(1);
    expect(await count(r.admin, "tenant_keys WHERE tenant_id=$1", [gone.tenantId])).toBeGreaterThan(0);
    expect(await count(r.admin, "jobs WHERE tenant_id=$1 AND kind='tenant.shred' AND state='queued'", [gone.tenantId])).toBeGreaterThan(0);
    // The mail and the account are still erased. Only the key destruction waits.
    expect(await count(r.admin, "messages WHERE tenant_id=$1", [gone.tenantId])).toBe(0);
    expect(await count(r.admin, "users WHERE id=$1 AND deleted_at IS NULL", [gone.userId])).toBe(0);
  }, 60_000);

  it("a log that isn't there isn't taken to mean no deletions", async () => {
    const r = await restore("missing");
    await expect(reapplyDeletions(r.op, join(dir, "nope.log"))).rejects.toThrow(/Nothing was applied/);
    expect(await readable(r.admin, gone, goneThread)).toContain("BodySentinel gone");
  }, 60_000);

  it("the real CLI: applies with counts and no content, and a broken chain exits 2 with a clear message", async () => {
    const r = await restore("cli");
    const repo = join(import.meta.dirname, "..", "..", "..", "..");
    const env = { ...process.env, DATABASE_URL_RESTORE: asLogin(r.url, "aegis_restore_login"), NODE_ENV: "test" };
    const cli = (...args: string[]) => run(join(repo, "node_modules", ".bin", "tsx"), [join(repo, "packages/platform/src/cli/restore-reapply.ts"), ...args], { env, cwd: repo });

    const bad = await cli(copyLog("cli-cut", lines => `${lines.filter((_, i) => i !== 1).join("\n")}\n`)).catch(e => e);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/failed verification/);
    expect(bad.stderr).toMatch(/line 2/);
    expect(bad.stderr).toMatch(/Nothing was applied/);
    expect(await readable(r.admin, gone, goneThread)).toContain("BodySentinel gone");

    const usage = await cli("--nonsense").catch(e => e);
    expect(usage.code).toBe(64);

    const verify = await cli(logPath, "--verify-only");
    expect(verify.stdout).toMatch(/chain intact/);
    expect(verify.stdout).toMatch(/nothing was applied/);
    expect(await readable(r.admin, gone, goneThread)).toContain("BodySentinel gone");

    const lines = logLines();
    const { stdout, stderr } = await cli(logPath, `--expect-head=${lines[lines.length - 1]!.seq}:${lines[lines.length - 1]!.hash}`);
    expect(stdout).toMatch(/account: 1 applied, 0 already erased/);
    expect(stdout).toMatch(/backup file itself is unchanged/);
    for (const needle of [...CONTENT, gone.userId, gone.tenantId, moverGone]) expect(stdout + stderr, needle).not.toContain(needle);
    await expect(readable(r.admin, gone, goneThread)).rejects.toBeTruthy();
    expect(await readable(r.admin, survivor, survivorThread)).toContain("BodySentinel survivor");
  }, 120_000);

  // These change what's in the log, so they come last.
  it("a crash between commit and ship: the row survives, the backup holds it, and the worker ships it exactly once", async () => {
    const w = await person("windowed");
    const box = await demoAccount(p, w, "windowed@fernhill.example");
    const thread = (await deliver(p, w, box, mail("windowed"))).thread_id;
    await disconnectAccount(p, w, box, { deleteData: true });
    const id = (await p.db.withSystem(t => t.one<{ id: string }>("SELECT id FROM deletion_outbox WHERE account_id=$1", [box])))!.id;
    // Committed, and the worker has done nothing: nothing has reached the log.
    expect(logLines().some(l => l.id === id)).toBe(false);
    expect((await p.db.withSystem(t => t.one<any>("SELECT shipped_at FROM deletion_outbox WHERE id=$1", [id])))!.shipped_at).toBeNull();

    // A backup taken right here holds the erasure and the unshipped row. So does the log, as it stood then, lack it.
    const windowDump = join(dir, "window.dump");
    await run("pg_dump", ["-Fc", "-f", windowDump, baseUrl.toString()]);
    const logThen = copyLog("at-window");

    // The worker dies holding the job.
    await p.db.withSystem(t => t.query("UPDATE jobs SET state='running', locked_at=now() - interval '1 hour' WHERE kind='deletion.ship' AND state='queued'"));
    await drainJobs(p);
    expect(logLines().some(l => l.id === id)).toBe(false);
    await reapStuckJobs(p);
    await drainJobs(p);
    expect(logLines().filter(l => l.id === id)).toHaveLength(1);

    // Restoring that backup replays its own unshipped row, though the log lacks it.
    const r = await restore("window", windowDump);
    const report = await reapplyDeletions(r.op, logThen);
    expect(report.chain.ok).toBe(true);
    expect(report.unshippedInBackup).toBe(1);
    await expect(readable(r.admin, w, thread)).rejects.toBeTruthy();
    expect(await count(r.admin, "mail_accounts WHERE id=$1", [box])).toBe(0);

    // Then a worker on the restored database ships that row against the log that already has it: nothing new is written.
    const shared = copyLog("shared");
    const before = logLines(shared).length;
    await shipDeletionLog(createPlatform({ db: r.admin, kms: p.kms, config: p.config, log: makeLogger(() => {}), env: {}, deletionSink: new FileDeletionSink(shared) }));
    expect(await count(r.admin, "deletion_outbox WHERE shipped_at IS NULL")).toBe(0);
    expect(logLines(shared)).toHaveLength(before);
    expect(verifyLogText(readFileSync(shared, "utf8")).problems).toEqual([]);
  }, 120_000);

  it("a job lost altogether: tick queues another, so a row can't be stranded", async () => {
    const w = await person("stranded");
    const box = await demoAccount(p, w, "stranded@fernhill.example");
    await disconnectAccount(p, w, box, { deleteData: true });
    await p.db.withSystem(t => t.query("DELETE FROM jobs WHERE kind='deletion.ship'"));
    await tick(p);
    expect(await count(p.db, "jobs WHERE kind='deletion.ship' AND state='queued'")).toBe(1);
    await drainJobs(p);
    expect(await count(p.db, "deletion_outbox WHERE shipped_at IS NULL")).toBe(0);
    expect(verifyLogText(readFileSync(logPath, "utf8")).problems).toEqual([]);
  }, 60_000);

  it("a crash after the sink synced but before the row was marked: the retry writes nothing new and marks it with the first receipt", async () => {
    const w = await person("twice-shipped");
    const box = await demoAccount(p, w, "twice-shipped@fernhill.example");
    await disconnectAccount(p, w, box, { deleteData: true });
    const inner = new FileDeletionSink(logPath);
    let crash = true;
    const sink = { kind: "crashing", head: () => inner.head(), append: async (e: DeletionEntry[]) => { const out = await inner.append(e); if (crash) { crash = false; throw new Error("power cut"); } return out; } };
    const crashing = createPlatform({ db: p.db, kms: p.kms, config: p.config, log: makeLogger(() => {}), env: {}, deletionSink: sink });
    const id = (await p.db.withSystem(t => t.one<{ id: string }>("SELECT id FROM deletion_outbox WHERE account_id=$1", [box])))!.id;

    await drainJobs(crashing);
    expect(logLines().filter(l => l.id === id)).toHaveLength(1);
    expect((await p.db.withSystem(t => t.one<any>("SELECT shipped_at FROM deletion_outbox WHERE id=$1", [id])))!.shipped_at).toBeNull();

    await p.db.withSystem(t => t.query("UPDATE jobs SET run_at=now() WHERE kind='deletion.ship' AND state='queued'"));
    await drainJobs(crashing);
    const row = await p.db.withSystem(t => t.one<any>("SELECT shipped_at, sink_seq, sink_hash FROM deletion_outbox WHERE id=$1", [id]));
    const line = logLines().filter(l => l.id === id);
    expect(line).toHaveLength(1);
    expect(row!.shipped_at).toBeTruthy();
    expect(row!.sink_seq).toBe(line[0]!.seq);
    expect(row!.sink_hash).toBe(line[0]!.hash);
    expect(verifyLogText(readFileSync(logPath, "utf8")).problems).toEqual([]);
  }, 60_000);
});
