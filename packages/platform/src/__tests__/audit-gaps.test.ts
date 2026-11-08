import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveSend, computePriority, enqueue, createAutomation, type Ctx, deleteAccount, drainJobs, listNotifications, listThreads, parseSearch, type Platform, resolveConflicts, RuleAction, saveDraft, updatePolicy, updatePrefs } from "../index";
import { deliver, demoAccount, markVerified, testPlatform, user } from "./harness";

const act = (x: unknown) => RuleAction.parse(x);

describe("when several rules match one message", () => {
  it("holding beats anything that would hide the message", () => {
    const hold = act({ type: "hold" }), archive = act({ type: "archive" }), read = act({ type: "mark_read" }), star = act({ type: "star" });
    const dropped = resolveConflicts([archive, read, hold, star]);
    expect(dropped.has(archive)).toBe(true);
    expect(dropped.has(read)).toBe(true);
    expect(dropped.has(hold)).toBe(false);
    expect(dropped.has(star)).toBe(false);
  });
  it("the most prominent section wins, whichever rule came first", () => {
    const low = act({ type: "set_section", section: "low_priority" }), high = act({ type: "set_section", section: "needs_attention" });
    expect([...resolveConflicts([low, high])]).toEqual([low]);
    expect([...resolveConflicts([high, low])]).toEqual([low]);
  });
  it("a raised section cancels a digest, but a low one doesn't", () => {
    const digest = act({ type: "add_to_digest" });
    expect(resolveConflicts([act({ type: "set_section", section: "important_people" }), digest]).has(digest)).toBe(true);
    expect(resolveConflicts([act({ type: "set_section", section: "low_priority" }), digest]).has(digest)).toBe(false);
  });
  it("nothing is dropped when nothing disagrees", () => expect(resolveConflicts([act({ type: "star" }), act({ type: "archive" })]).size).toBe(0));
});

describe("rules, end to end", () => {
  let p: Platform, drop: () => Promise<void>, ctx: Ctx, acct: string;
  beforeAll(async () => { ({ p, drop } = await testPlatform()); ctx = await user(p, "rules@fernhill.example"); acct = await demoAccount(p, ctx, "rules@fernhill.example"); await p.db.withUser(ctx, t => t.query("INSERT INTO user_preferences(user_id,prefs) VALUES ($1,'{\"automationLevel\":\"limited\"}') ON CONFLICT (user_id) DO UPDATE SET prefs=EXCLUDED.prefs", [ctx.userId])); });
  afterAll(() => drop());
  const when = { trigger: "message.classified", match: "any", conditions: [{ type: "from_domain", domains: ["vendor.test"] }] };

  it("a rule that asks to notify does, once, without the message's content", async () => {
    await createAutomation(p, ctx, { name: "Tell me", enabled: true, definition: { ...when, actions: [{ type: "star" }], notify: "each" } });
    await deliver(p, ctx, acct, { from: `"Vee" <vee@vendor.test>`, subject: "SECRETSUBJECT renewal", text: "hello" });
    await drainJobs(p);
    const n = await listNotifications(p, ctx);
    const matching = n.items.filter((i: any) => i.kind === "rule_matched");
    expect(matching).toHaveLength(1);
    expect(JSON.stringify(matching)).not.toContain("SECRETSUBJECT");
  });
  it("conflicting rules really do resolve when mail arrives: archive loses to hold", async () => {
    const hide = { trigger: "message.classified", match: "any", conditions: [{ type: "from_domain", domains: ["both.test"] }] };
    await createAutomation(p, ctx, { name: "Archive these", enabled: true, definition: { ...hide, actions: [{ type: "archive" }] } });
    await createAutomation(p, ctx, { name: "Hold these", enabled: true, definition: { ...hide, actions: [{ type: "hold" }] } });
    const m = await deliver(p, ctx, acct, { from: "a@both.test", subject: "Both rules", text: "hello" });
    await drainJobs(p);
    const runs = await p.db.withWorker(ctx.tenantId, t => t.query<{ actions: string[] }>("SELECT actions FROM automation_runs WHERE message_id=$1 AND NOT dry_run", [m.id]));
    expect(runs.flatMap(r => r.actions).sort()).toEqual(["conflict:archive", "hold"]);
  });
});

describe("the due: search filter", () => {
  let p: Platform, drop: () => Promise<void>, ctx: Ctx, acct: string;
  beforeAll(async () => { ({ p, drop } = await testPlatform()); ctx = await user(p, "due@fernhill.example"); acct = await demoAccount(p, ctx, "due@fernhill.example"); });
  afterAll(() => drop());
  const addTask = async (threadId: string, due: string | null, uncertain = false) => p.db.withWorker(ctx.tenantId, async t => {
    const id = crypto.randomUUID();
    const blob = Buffer.from("x");
    await t.query("INSERT INTO tasks(id,tenant_id,account_id,owner_user_id,thread_id,blob_enc,source,dedupe_key,due_at,due_uncertain) VALUES ($1,$2,$3,$4,$5,$6,'manual',$7,$8,$9)", [id, ctx.tenantId, acct, ctx.userId, threadId, blob, id, due, uncertain]);
  });
  it("is parsed as an operator", () => expect(parseSearch("due:today invoice").due).toBe("today"));
  it("finds firm dates only, and a made-up value filters nothing", async () => {
    const overdue = await deliver(p, ctx, acct, { from: "a@a.test", subject: "Overdue thing", text: "x" });
    const vague = await deliver(p, ctx, acct, { from: "b@b.test", subject: "Vague thing", text: "x" });
    const later = await deliver(p, ctx, acct, { from: "c@c.test", subject: "Far off thing", text: "x" });
    await addTask(overdue.thread_id, new Date(Date.now() - 86_400_000).toISOString());
    await addTask(vague.thread_id, new Date(Date.now() - 86_400_000).toISOString(), true);
    await addTask(later.thread_id, new Date(Date.now() + 40 * 86_400_000).toISOString());
    const subjects = async (q: string) => (await listThreads(p, ctx, { view: "inbox", q, limit: 50 })).items.map((x: any) => x.subject);
    expect(await subjects("due:overdue")).toEqual(["Overdue thing"]);
    expect(await subjects("due:week")).toEqual([]);
    expect((await subjects("due:any")).sort()).toEqual(["Far off thing", "Overdue thing"]);
    // Unknown values come from a fixed lookup, so they never reach the SQL. The filter is ignored and the table is intact.
    expect((await subjects("due:nonsense")).sort()).toEqual(["Far off thing", "Overdue thing", "Vague thing"]);
  });
});

describe("outbound block policy", () => {
  let p: Platform, drop: () => Promise<void>, ctx: Ctx, acct: string;
  beforeAll(async () => { ({ p, drop } = await testPlatform()); ctx = await user(p, "send@corp.example", { kind: "organization" }); acct = await demoAccount(p, ctx, "send@corp.example"); await updatePolicy(p, ctx, { outboundBlockDomains: ["blocked.test"] } as never); });
  afterAll(() => drop());
  const send = async (rcpt: { to?: string[]; cc?: string[]; bcc?: string[] }) => {
    const d = await saveDraft(p, ctx, { accountId: acct, to: rcpt.to ?? ["ok@fine.test"], cc: rcpt.cc ?? [], bcc: rcpt.bcc ?? [], subject: "s", text: "t", aiGenerated: false });
    return approveSend(p, ctx, d.id, { expectedFrom: "send@corp.example", idempotencyKey: crypto.randomUUID(), acknowledgedRisk: false });
  };
  it("blocks to, cc, bcc and subdomains, on the server", async () => {
    for (const r of [{ to: ["x@blocked.test"] }, { cc: ["x@blocked.test"] }, { bcc: ["x@BLOCKED.test"] }, { to: ["x@mail.blocked.test"] }]) await expect(send(r)).rejects.toMatchObject({ status: 403, code: "outbound_blocked" });
  });
  it("doesn't catch a domain that merely ends the same way", async () => expect(await send({ to: ["x@notblocked.test"] })).toBeTruthy());
});

describe("deleting an account with no password", () => {
  let p: Platform, drop: () => Promise<void>;
  beforeAll(async () => { ({ p, drop } = await testPlatform()); });
  afterAll(() => drop());
  const federated = async (email: string, ageMs: number) => {
    const ctx = await user(p, email);
    await markVerified(p, ctx.userId);
    const sid = crypto.randomUUID();
    await p.db.withSystem(async t => {
      await t.query("UPDATE users SET password_hash=NULL WHERE id=$1", [ctx.userId]);
      await t.query("INSERT INTO sessions(id,user_id,active_tenant_id,token_hash,expires_at,created_at) VALUES ($1,$2,$3,$4,now()+interval '1 day',now()-($5||' milliseconds')::interval)", [sid, ctx.userId, ctx.tenantId, sid, String(ageMs)]);
    });
    return { ...ctx, sessionId: sid, email };
  };
  it("a recent sign-in stands in for the password", async () => {
    const c = await federated("fed-new@fernhill.example", 60_000);
    await expect(deleteAccount(p, c, { confirmEmail: c.email, email: c.email, password: "" })).resolves.not.toThrow();
  });
  it("an old session doesn't", async () => {
    const c = await federated("fed-old@fernhill.example", 3_600_000);
    await expect(deleteAccount(p, c, { confirmEmail: c.email, email: c.email, password: "" })).rejects.toMatchObject({ status: 401, code: "reauth_required" });
  });
  it("an account with a password still needs it", async () => {
    const c = await user(p, "pw@fernhill.example");
    await expect(deleteAccount(p, c, { confirmEmail: "pw@fernhill.example", email: "pw@fernhill.example", password: "" })).rejects.toMatchObject({ status: 401, code: "invalid_credentials" });
  });
});

describe("ranking a whole account", () => {
  let p: Platform, drop: () => Promise<void>, ctx: Ctx, a: string, b: string, c: string;
  beforeAll(async () => {
    ({ p, drop } = await testPlatform());
    ctx = await user(p, "rank@fernhill.example");
    a = await demoAccount(p, ctx, "rank-up@fernhill.example");
    b = await demoAccount(p, ctx, "rank-mid@fernhill.example");
    c = await demoAccount(p, ctx, "rank-down@fernhill.example");
    await updatePrefs(p, ctx, { accountRanking: { [a]: 0.5, [c]: -0.5 } });
  });
  afterAll(() => drop());
  const mail = { from: `"Dee" <dee@client.test>`, subject: "Contract question", text: "Can you review the contract and confirm the invoice by Friday?" };
  const score = async (acct: string) => (await deliver(p, ctx, acct, mail)).id as string;
  const read = (id: string) => p.db.withWorker(ctx.tenantId, t => t.one<{ priority_score: number }>("SELECT priority_score FROM messages WHERE id=$1", [id]));

  it("moves the same message up or down, and says why", async () => {
    const [up, mid, down] = await Promise.all([a, b, c].map(score));
    const [u, m, d] = await Promise.all([up, mid, down].map(x => read(x!)));
    expect(u!.priority_score).toBeGreaterThan(m!.priority_score);
    expect(d!.priority_score).toBeLessThan(m!.priority_score);
  });
  it("can't lift a scam out of security review", () => {
    const base = { subject: "Urgent: verify now", text: "Please confirm by Friday.", isBulk: false, autoGenerated: false, fromMe: false, received: 5, sentTo: 5, replied: 5, dismissed: 0, isVip: true, isIgnored: false, threadHasMyReply: false, personalizationEnabled: true, now: new Date("2026-11-07T10:00:00Z"), userBoost: 1 };
    for (const riskLabel of ["suspicious", "high_risk", "malicious", "unknown_unscannable"] as const) {
      const d = computePriority({ ...base, riskLabel });
      expect(d.score).toBe(0);
      expect(d.section).toBe("security_review");
    }
    expect(computePriority({ ...base, riskLabel: "safe" }).score).toBeGreaterThan(0);
  });
});

describe("small fixes", () => {
  let p: Platform, drop: () => Promise<void>, ctx: Ctx, acct: string;
  beforeAll(async () => { ({ p, drop } = await testPlatform()); ctx = await user(p, "misc@fernhill.example"); acct = await demoAccount(p, ctx, "misc@fernhill.example"); });
  afterAll(() => drop());
  it("a field filter holds even when its value is an English stopword", async () => {
    await deliver(p, ctx, acct, { from: `"Will Reed" <will@one.test>`, subject: "Invoice from one", text: "Invoice attached." });
    await deliver(p, ctx, acct, { from: `"Pat Lee" <pat@two.test>`, subject: "Invoice from two", text: "Invoice attached." });
    const subjects = async (q: string) => (await listThreads(p, ctx, { view: "inbox", q, limit: 50 })).items.map((x: any) => x.subject);
    expect(await subjects("from:will invoice")).toEqual(["Invoice from one"]);
    expect((await subjects("invoices")).sort()).toEqual(["Invoice from one", "Invoice from two"]);
  });
  it("a period-named job runs once in its period, even after it finishes", async () => {
    const add = () => p.db.withSystem(t => enqueue(t, { tenantId: ctx.tenantId, kind: "retention.sweep", dedupeKey: "retention:test:hour", oncePerKey: true }));
    expect(await add()).toBeTruthy();
    expect(await add()).toBeNull();
    await p.db.withSystem(t => t.query("UPDATE jobs SET state='done' WHERE dedupe_key='retention:test:hour'"));
    expect(await add()).toBeNull();
  });
  it("an ordinary key can be used again once its job has finished", async () => {
    const add = () => p.db.withSystem(t => enqueue(t, { tenantId: ctx.tenantId, kind: "retention.sweep", dedupeKey: "plain:key" }));
    expect(await add()).toBeTruthy();
    await p.db.withSystem(t => t.query("UPDATE jobs SET state='done' WHERE dedupe_key='plain:key'"));
    expect(await add()).toBeTruthy();
  });
});
