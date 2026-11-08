import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptInvite, type Ctx, deliverableNow, drainJobs, grantMailbox, inHourWindow, invite, listNotifications, localClock, markAllNotificationsRead, markNotificationRead, MAX_DEFER_HOURS, nextDeliveryAt, type Platform, renderDigest, scanNotifications, setTaskReminder, tick, updatePrefs, createTask, removeMember, enqueue, signUp } from "../index";
import { deliver, demoAccount, markVerified, testPlatform, user } from "./harness";

const at = (iso: string) => new Date(iso);

describe("quiet hours across time zones", () => {
  const tokyoQuiet = { timeZone: "Asia/Tokyo", quietHours: { start: 22, end: 7 } };
  it("reads the clock in the user's zone", () => {
    expect(localClock(at("2026-06-15T12:30:00Z"), "Asia/Tokyo")).toMatchObject({ hour: 21, minute: 30, date: "2026-06-15" });
    expect(localClock(at("2026-06-15T15:30:00Z"), "Asia/Tokyo")).toMatchObject({ hour: 0, minute: 30, date: "2026-06-16" });
    expect(localClock(at("2026-06-15T12:30:00Z"), "America/New_York")).toMatchObject({ hour: 8, minute: 30 });
    expect(localClock(at("2026-06-15T12:30:00Z"), "Asia/Kolkata")).toMatchObject({ hour: 18, minute: 0 });
    expect(localClock(at("2026-06-15T12:30:00Z"), "Asia/Kathmandu")).toMatchObject({ hour: 18, minute: 15 });
  });
  it("midnight reads as hour zero, not 24", () => {
    expect(localClock(at("2026-06-15T00:00:00Z"), "UTC").hour).toBe(0);
  });
  it("an unknown zone reads as UTC, so nothing is lost", () => {
    expect(localClock(at("2026-06-15T12:30:00Z"), "Mars/Olympus").hour).toBe(12);
    expect(deliverableNow({ timeZone: "Not/AZone", quietHours: { start: 22, end: 7 } }, "normal", at("2026-06-15T12:30:00Z"))).toBe(true);
  });
  it("windows wrap past midnight, and exclude the end", () => {
    expect(inHourWindow(23, 22, 7)).toBe(true);
    expect(inHourWindow(3, 22, 7)).toBe(true);
    expect(inHourWindow(7, 22, 7)).toBe(false);
    expect(inHourWindow(22, 22, 7)).toBe(true);
    expect(inHourWindow(12, 22, 7)).toBe(false);
    expect(inHourWindow(9, 9, 17)).toBe(true);
    expect(inHourWindow(17, 9, 17)).toBe(false);
    expect(inHourWindow(10, 8, 8)).toBe(false);
    expect(inHourWindow(23, 9, 24)).toBe(true);
  });
  it("the same instant is quiet in Tokyo and not in New York", () => {
    const now = at("2026-06-15T14:00:00Z"); // 23:00 in Tokyo, 10:00 in New York
    expect(deliverableNow(tokyoQuiet, "normal", now)).toBe(false);
    expect(deliverableNow({ timeZone: "America/New_York", quietHours: { start: 22, end: 7 } }, "normal", now)).toBe(true);
  });
  it("defers to the end of quiet hours, in the user's zone", () => {
    expect(nextDeliveryAt(tokyoQuiet, "normal", at("2026-06-15T14:00:00Z")).toISOString()).toBe("2026-06-15T22:00:00.000Z"); // 07:00 in Tokyo
  });
  it("lands on the right instant in a half-hour zone", () => {
    const p = { timeZone: "Asia/Kolkata", quietHours: { start: 22, end: 7 } };
    expect(nextDeliveryAt(p, "normal", at("2026-06-15T18:00:00Z")).toISOString()).toBe("2026-06-16T01:30:00.000Z"); // 07:00 in Kolkata
  });
  it("and in a 45-minute zone", () => {
    const p = { timeZone: "Asia/Kathmandu", quietHours: { start: 22, end: 7 } };
    expect(nextDeliveryAt(p, "normal", at("2026-06-15T18:00:00Z")).toISOString()).toBe("2026-06-16T01:15:00.000Z");
  });
  it("across the spring daylight saving change", () => {
    // 2026-03-08 in New York: 02:00 jumps to 03:00. Quiet until 07:00 local, now EDT (UTC-4).
    const p = { timeZone: "America/New_York", quietHours: { start: 22, end: 7 } };
    expect(nextDeliveryAt(p, "normal", at("2026-03-08T05:00:00Z")).toISOString()).toBe("2026-03-08T11:00:00.000Z");
  });
  it("across the autumn change, where an hour repeats", () => {
    // 2026-11-01 in New York: 02:00 falls back to 01:00. Quiet until 07:00 local, now EST (UTC-5).
    const p = { timeZone: "America/New_York", quietHours: { start: 22, end: 7 } };
    expect(nextDeliveryAt(p, "normal", at("2026-11-01T04:00:00Z")).toISOString()).toBe("2026-11-01T12:00:00.000Z");
  });
  it("a window that starts in the skipped hour still ends properly", () => {
    const p = { timeZone: "America/New_York", quietHours: { start: 2, end: 3 } };
    expect(deliverableNow(p, "normal", at("2026-03-08T07:00:00Z"))).toBe(true); // 03:00 EDT; 02:00 never happened.
  });
  it("across the southern hemisphere's change", () => {
    const p = { timeZone: "Australia/Sydney", quietHours: { start: 22, end: 7 } };
    // 2026-04-05 03:00 AEDT falls back to 02:00 AEST. 07:00 AEST is 21:00Z on the 4th.
    expect(nextDeliveryAt(p, "normal", at("2026-04-04T14:00:00Z")).toISOString()).toBe("2026-04-04T21:00:00.000Z");
  });
  it("working hours hold back the non-critical, and let it through inside them", () => {
    const p = { workingHours: { start: 9, end: 17, tz: "Europe/Berlin" } };
    expect(deliverableNow(p, "normal", at("2026-06-15T08:00:00Z"))).toBe(true); // 10:00 Berlin
    expect(deliverableNow(p, "normal", at("2026-06-15T18:00:00Z"))).toBe(false); // 20:00 Berlin
    expect(nextDeliveryAt(p, "normal", at("2026-06-15T18:00:00Z")).toISOString()).toBe("2026-06-16T07:00:00.000Z");
  });
  it("critical alerts ignore working hours, and bypass quiet hours only if the user enabled that", () => {
    const now = at("2026-06-15T14:00:00Z"); // 23:00 Tokyo
    const base = { timeZone: "Asia/Tokyo", quietHours: { start: 22, end: 7 }, workingHours: { start: 9, end: 17, tz: "Asia/Tokyo" } };
    expect(deliverableNow(base, "critical", now)).toBe(false);
    expect(nextDeliveryAt(base, "critical", now).toISOString()).toBe("2026-06-15T22:00:00.000Z");
    expect(deliverableNow({ ...base, criticalBypassQuiet: true }, "critical", now)).toBe(true);
    expect(deliverableNow({ ...base, criticalBypassQuiet: true }, "normal", now)).toBe(false);
    // Outside working hours but not in quiet hours, critical still goes.
    expect(deliverableNow(base, "critical", at("2026-06-15T10:00:00Z"))).toBe(true); // 19:00 Tokyo
    expect(deliverableNow(base, "normal", at("2026-06-15T10:00:00Z"))).toBe(false);
  });
  it("a critical alert deferred by quiet hours isn't then held to working hours", () => {
    const p = { timeZone: "UTC", quietHours: { start: 22, end: 6 }, workingHours: { start: 9, end: 17, tz: "UTC" } };
    expect(nextDeliveryAt(p, "critical", at("2026-06-15T23:00:00Z")).toISOString()).toBe("2026-06-16T06:00:00.000Z");
    expect(nextDeliveryAt(p, "normal", at("2026-06-15T23:00:00Z")).toISOString()).toBe("2026-06-16T09:00:00.000Z");
  });
  it("settings that leave no hour open still deliver eventually", () => {
    const now = at("2026-06-15T12:00:00Z");
    const p = { timeZone: "UTC", quietHours: { start: 0, end: 24 }, workingHours: { start: 9, end: 17, tz: "UTC" } };
    expect(nextDeliveryAt(p, "normal", now).getTime()).toBe(now.getTime() + MAX_DEFER_HOURS * 3600_000);
  });
  it("no settings, no deferral", () => {
    const now = at("2026-06-15T03:00:00Z");
    expect(nextDeliveryAt({}, "normal", now)).toBe(now);
  });
  it("working hours that make no sense don't swallow anything", () => {
    expect(deliverableNow({ workingHours: { start: 17, end: 9, tz: "UTC" } }, "normal", at("2026-06-15T03:00:00Z"))).toBe(true);
  });
  it("quiet hours fall back to the working hours' zone when no zone is set", () => {
    expect(deliverableNow({ workingHours: { start: 0, end: 24, tz: "Asia/Tokyo" }, quietHours: { start: 22, end: 7 } }, "normal", at("2026-06-15T14:00:00Z"))).toBe(false);
  });
});

describe("the notification center", () => {
  let p: Platform, drop: () => Promise<void>, ctx: Ctx, acct: string;
  let clock = new Date();
  const SECRET = "NOTIFY-SENTINEL-55";
  beforeAll(async () => {
    ({ p, drop } = await testPlatform({ now: () => clock }));
    ctx = await user(p, "owner@notify.example", { kind: "organization" });
    acct = await demoAccount(p, ctx, "owner@notify.example");
  });
  afterAll(() => drop());
  const scan = () => scanNotifications(p, ctx.tenantId);
  const phish = (subject: string) => deliver(p, ctx, acct, { from: `"PayPal" <x@paypa1.test>`, auth: "fail", subject, text: `Verify your password https://paypa1.test/login ${SECRET}` });

  it("a held message becomes a notification with no content in it", async () => {
    const m = await phish(`Verify ${SECRET}`);
    expect(m.held).toBe(true);
    await scan();
    const feed = await listNotifications(p, ctx);
    const held = feed.items.find(i => i.kind === "held_message")!;
    expect(held).toMatchObject({ title: "A message was blocked", href: "/app/org/blocked", read: false });
    expect(JSON.stringify(feed)).not.toContain(SECRET);
    expect(JSON.stringify(feed)).not.toContain("paypa1");
    const rows = await p.db.withSystem(t => t.query<any>("SELECT * FROM notifications"));
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(Object.keys(rows[0]).sort()).toEqual(["created_at", "dedupe_key", "deliver_at", "digested_at", "id", "kind", "read_at", "ref_id", "severity", "tenant_id", "user_id"]);
  });
  it("scanning twice doesn't duplicate", async () => {
    const before = (await listNotifications(p, ctx)).items.length;
    await scan(); await scan();
    expect((await listNotifications(p, ctx)).items.length).toBe(before);
  });
  it("marking read, one and all", async () => {
    const f = await listNotifications(p, ctx);
    expect(f.unread).toBeGreaterThan(0);
    await markNotificationRead(p, ctx, f.items[0]!.id);
    expect((await listNotifications(p, ctx)).items.find(i => i.id === f.items[0]!.id)!.read).toBe(true);
    await markAllNotificationsRead(p, ctx);
    expect((await listNotifications(p, ctx)).unread).toBe(0);
  });
  it("a mailbox that needs reconnecting, named for its owner, clears when fixed", async () => {
    await p.db.withWorker(ctx.tenantId, t => t.query("UPDATE mail_accounts SET status='reconnect_required' WHERE id=$1", [acct]));
    await scan();
    const n = (await listNotifications(p, ctx)).items.find(i => i.kind === "account_reconnect")!;
    expect(n.title).toBe("Test needs reconnecting");
    expect(n.href).toBe("/app/settings/accounts");
    await p.db.withWorker(ctx.tenantId, t => t.query("UPDATE mail_accounts SET status='active' WHERE id=$1", [acct]));
    await scan();
    expect((await listNotifications(p, ctx)).items.find(i => i.kind === "account_reconnect")).toBeUndefined();
  });
  it("a failed send", async () => {
    const d = await p.db.withWorker(ctx.tenantId, t => t.one<any>("INSERT INTO drafts(tenant_id,account_id,user_id,blob_enc) VALUES ($1,$2,$3,'\\x00') RETURNING id", [ctx.tenantId, acct, ctx.userId]));
    await p.db.withWorker(ctx.tenantId, t => t.query("INSERT INTO send_approvals(tenant_id,account_id,draft_id,approved_by,idempotency_key,rfc_message_id,expected_from,state) VALUES ($1,$2,$3,$4,'k-fail','<x@y>','a@b','failed')", [ctx.tenantId, acct, d.id, ctx.userId]));
    await scan();
    expect((await listNotifications(p, ctx)).items.find(i => i.kind === "send_failed")).toMatchObject({ href: "/app/drafts", title: "A message may not have been sent" });
  });
  it("a reminder comes due, and goes away if the task is done first", async () => {
    const t1 = await createTask(p, ctx, { text: `Task ${SECRET}`, accountId: acct });
    await setTaskReminder(p, ctx, t1.id, new Date(clock.getTime() + 3600_000));
    await scan();
    expect((await listNotifications(p, ctx)).items.find(i => i.kind === "reminder_due")).toBeUndefined();
    await setTaskReminder(p, ctx, t1.id, new Date(clock.getTime() - 60_000));
    await scan();
    const n = (await listNotifications(p, ctx)).items.find(i => i.kind === "reminder_due")!;
    expect(n.href).toBe("/app/tasks");
    expect(n.title).not.toContain(SECRET);
    await p.db.withUser(ctx, t => t.query("UPDATE tasks SET status='done' WHERE id=$1", [t1.id]));
    await scan();
    expect((await listNotifications(p, ctx)).items.find(i => i.kind === "reminder_due")).toBeUndefined();
  });
  it("only the task's owner can set its reminder", async () => {
    const t1 = await createTask(p, ctx, { text: "Mine", accountId: acct });
    const stranger = await user(p, "stranger@notify.example");
    await expect(setTaskReminder(p, stranger, t1.id, new Date())).rejects.toMatchObject({ status: 404 });
  });
  it("a follow-up comes due after three days of silence, and goes when they reply", async () => {
    const sent = await deliver(p, ctx, acct, { from: `"Owner" <owner@notify.example>`, to: "bob@oak.test", subject: "Proposal", text: "Here it is." }, { folder: "sent", hoursAgo: 96 });
    await scan();
    const n = (await listNotifications(p, ctx)).items.find(i => i.kind === "followup_due")!;
    expect(n).toMatchObject({ href: "/app/awaiting", title: "A conversation may need a follow-up" });
    await p.db.withWorker(ctx.tenantId, t => t.query("UPDATE threads SET last_from_me=false WHERE id=$1", [sent.thread_id]));
    await scan();
    expect((await listNotifications(p, ctx)).items.find(i => i.kind === "followup_due")).toBeUndefined();
  });

  describe("quiet hours really defer", () => {
    let c: Ctx, a: string;
    beforeAll(async () => {
      c = await user(p, "quiet@notify.example", { kind: "organization" });
      a = await demoAccount(p, c, "quiet@notify.example");
    });
    it("a non-critical notification waits, is counted as waiting, then appears", async () => {
      clock = at("2026-06-15T14:00:00Z"); // 23:00 Tokyo
      await updatePrefs(p, c, { timeZone: "Asia/Tokyo", quietHours: { start: 22, end: 7 } });
      const t1 = await createTask(p, c, { text: "Later", accountId: a });
      await setTaskReminder(p, c, t1.id, new Date(clock.getTime() - 60_000));
      await scanNotifications(p, c.tenantId);
      const during = await listNotifications(p, c);
      expect(during.items.find(i => i.kind === "reminder_due")).toBeUndefined();
      expect(during.waiting).toBe(1);
      clock = at("2026-06-15T22:00:00Z"); // 07:00 Tokyo
      const after = await listNotifications(p, c);
      expect(after.items.find(i => i.kind === "reminder_due")).toBeDefined();
      expect(after.waiting).toBe(0);
    });
    it("a changed setting applies to what's already waiting", async () => {
      clock = at("2026-06-16T14:00:00Z");
      const t2 = await createTask(p, c, { text: "Later 2", accountId: a });
      await setTaskReminder(p, c, t2.id, new Date(clock.getTime() - 60_000));
      await scanNotifications(p, c.tenantId);
      expect((await listNotifications(p, c)).waiting).toBe(1);
      await updatePrefs(p, c, { quietHours: null });
      await scanNotifications(p, c.tenantId);
      expect((await listNotifications(p, c)).waiting).toBe(0);
    });
    it("a critical alert waits in quiet hours by default, and comes through if enabled", async () => {
      clock = at("2026-06-16T14:00:00Z");
      await updatePrefs(p, c, { timeZone: "Asia/Tokyo", quietHours: { start: 22, end: 7 } });
      await p.db.withWorker(c.tenantId, t => t.query("INSERT INTO messages(tenant_id,account_id,provider_message_id,internal_date,risk_label,held) VALUES ($1,$2,'evil-1',now(),'malicious',true)", [c.tenantId, a]));
      const m = await p.db.withWorker(c.tenantId, t => t.one<any>("SELECT id FROM messages WHERE provider_message_id='evil-1'"));
      await p.db.withWorker(c.tenantId, t => t.query("INSERT INTO quarantine_items(message_id,tenant_id,account_id,state,original_folder_role,created_at) VALUES ($1,$2,$3,'held','inbox',$4)", [m.id, c.tenantId, a, clock]));
      await scanNotifications(p, c.tenantId);
      expect((await listNotifications(p, c)).items.find(i => i.severity === "critical")).toBeUndefined();
      await updatePrefs(p, c, { criticalBypassQuiet: true });
      await scanNotifications(p, c.tenantId);
      expect((await listNotifications(p, c)).items.find(i => i.severity === "critical")).toMatchObject({ kind: "held_message" });
    });
  });

  describe("who can see them", () => {
    it("blocked mail is told to the workspace's admins, never to the member it was sent to, and each sees only their own", async () => {
      clock = new Date();
      const owner = await user(p, "o2@notify.example", { kind: "organization" });
      const empEmail = "emp@notify.example", secEmail = "sec@notify.example";
      const { acceptUrl: u1 } = await invite(p, owner, { email: empEmail, role: "member" });
      const { acceptUrl: u2 } = await invite(p, owner, { email: secEmail, role: "security_admin" });
      const e = await signUp(p, { email: empEmail, password: "correct-horse-battery", name: "E", workspaceKind: "personal" });
      const s = await signUp(p, { email: secEmail, password: "correct-horse-battery", name: "S", workspaceKind: "personal" });
      await markVerified(p, e.userId); await markVerified(p, s.userId);
      await acceptInvite(p, e.userId, empEmail, u1!.split("/").pop()!);
      await acceptInvite(p, s.userId, secEmail, u2!.split("/").pop()!);
      const emp = { tenantId: owner.tenantId, userId: e.userId }, sec = { tenantId: owner.tenantId, userId: s.userId };
      const a = await demoAccount(p, emp, empEmail);
      await grantMailbox(p, emp, a, s.userId);
      await deliver(p, emp, a, { from: `"PayPal" <x@paypa1.test>`, auth: "fail", subject: "Verify", text: "Verify your password https://paypa1.test/login" });
      await scanNotifications(p, owner.tenantId);
      expect((await listNotifications(p, emp)).items.some(i => i.kind === "held_message")).toBe(false);
      expect((await listNotifications(p, sec)).items.some(i => i.kind === "held_message")).toBe(true);
      expect((await listNotifications(p, owner)).items.some(i => i.kind === "held_message")).toBe(true);
      // Row security, not just the query: each admin sees only their own rows.
      const secRows = await p.db.withUser(sec, t => t.query<any>("SELECT user_id FROM notifications"));
      expect(secRows.length).toBeGreaterThan(0);
      expect(secRows.every(r => r.user_id === s.userId)).toBe(true);
      const ownersOwn = await p.db.withWorker(owner.tenantId, t => t.one<any>("SELECT id FROM notifications WHERE user_id=$1 LIMIT 1", [owner.userId]));
      await markNotificationRead(p, sec, ownersOwn.id);
      expect((await p.db.withWorker(owner.tenantId, t => t.one<any>("SELECT read_at FROM notifications WHERE id=$1", [ownersOwn.id]))).read_at).toBeNull();
      await expect(p.db.withUser(emp, t => t.query("INSERT INTO notifications(tenant_id,user_id,kind,dedupe_key,deliver_at) VALUES ($1,$2,'held_message','x',now())", [owner.tenantId, e.userId]))).rejects.toThrow(/permission denied/);
      await removeMember(p, owner, s.userId);
      await drainJobs(p);
      expect(await p.db.withWorker(owner.tenantId, t => t.query("SELECT 1 FROM notifications WHERE user_id=$1", [s.userId]))).toEqual([]);
    });
    it("another tenant sees nothing", async () => {
      const other = await user(p, "z@notify.example");
      expect((await listNotifications(p, other)).items).toEqual([]);
    });
  });

  it("runs from the scheduler as a job", async () => {
    clock = new Date();
    await tick(p);
    const jobs = await p.db.withSystem(t => t.query<any>("SELECT payload, dedupe_key FROM jobs WHERE kind='notifications.scan' AND tenant_id=$1", [ctx.tenantId]));
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs[0].payload).toEqual({});
    await tick(p);
    expect((await p.db.withSystem(t => t.query<any>("SELECT 1 FROM jobs WHERE kind='notifications.scan' AND tenant_id=$1 AND state='queued'", [ctx.tenantId]))).length).toBe(1);
    await drainJobs(p);
  });
});

describe("the email digest", () => {
  // Digests wait for the working day, so the time has to be fixed or this only passes in the afternoon.
  const onePm = new Date(); onePm.setUTCHours(13, 0, 0, 0);
  let p: Platform, drop: () => Promise<void>, clock = onePm;
  const mailed: { to: string; subject: string; text: string }[] = [];
  const digests = () => mailed.filter(m => /digest/.test(m.subject));
  const SECRET = "DIGEST-SENTINEL-99";
  let c: Ctx & { token: string }, a: string;
  beforeAll(async () => {
    ({ p, drop } = await testPlatform({ mailer: { kind: "smtp", async send(m) { mailed.push(m); } }, now: () => clock }));
    // Blocked mail is told to admins, so this is an organization owner.
    c = await user(p, "digest@notify.example", { kind: "organization" });
    a = await demoAccount(p, c, "digest@notify.example");
    await deliver(p, c, a, { from: `"Priya Sharma" <priya@paypa1.test>`, auth: "fail", subject: `Verify ${SECRET}`, text: `Verify your password https://paypa1.test/login ${SECRET}` });
  });
  afterAll(() => drop());
  it("is off by default", async () => {
    await scanNotifications(p, c.tenantId);
    await drainJobs(p);
    expect(digests()).toHaveLength(0);
  });
  it("won't go to an unverified address", async () => {
    await updatePrefs(p, c, { emailDigest: true });
    await scanNotifications(p, c.tenantId);
    await drainJobs(p);
    expect(digests()).toHaveLength(0);
  });
  it("contains counts and no message content", async () => {
    await markVerified(p, c.userId);
    await scanNotifications(p, c.tenantId);
    await drainJobs(p);
    expect(digests()).toHaveLength(1);
    const m = digests()[0]!;
    expect(m.to).toBe("digest@notify.example");
    expect(m.text).toMatch(/1 message blocked/);
    const all = `${m.subject}\n${m.text}`;
    for (const leak of [SECRET, "Priya", "paypa1", "Verify your"]) expect(all).not.toContain(leak);
  });
  it("goes once a day, and is marked so", async () => {
    await scanNotifications(p, c.tenantId);
    await drainJobs(p);
    expect(digests()).toHaveLength(1);
  });
  it("respects quiet hours", async () => {
    clock = new Date(clock.getTime() + 86_400_000 * 2);
    const hour = new Date(clock).getUTCHours();
    await updatePrefs(p, c, { timeZone: "UTC", quietHours: { start: hour, end: (hour + 2) % 24 } });
    await deliver(p, c, a, { from: `"X" <x@paypa1.test>`, auth: "fail", subject: "Verify again", text: "Verify your password https://paypa1.test/login" }, { remoteId: "second" });
    await scanNotifications(p, c.tenantId);
    await drainJobs(p);
    expect(digests()).toHaveLength(1);
  });
  it("renders every kind without inventing content", () => {
    const text = renderDigest(p, "a@b.example", [{ kind: "held_message", count: 2 }, { kind: "account_reconnect", count: 1 }, { kind: "send_failed", count: 1 }, { kind: "reminder_due", count: 3 }, { kind: "followup_due", count: 1 }]).text;
    expect(text).toContain("2 messages blocked");
    expect(text).toContain("1 mailbox needs reconnecting");
    expect(text).toContain("3 task reminders due");
    expect(text).toContain("never includes message content");
  });
});
void enqueue;
