import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDraftAttachment, approveSend, automationRuns, createAutomation, createLabel, type Ctx, deleteLabel, drainJobs, getFocus, getThread, grantMailbox, listDrafts, listLabels, type Platform, recentRefusals, removeDraftAttachment, saveDraft, threadAction, updateAccount, updateAutomation } from "../index";
import { deliver, demoAccount, testPlatform, user } from "./harness";

const send = (p: Platform, ctx: Ctx, id: string, from: string, key: string) => approveSend(p, ctx, id, { expectedFrom: from, idempotencyKey: key.padEnd(16, "0"), acknowledgedRisk: false });

describe("support for the frontend's labels, aliases, attachments and refusals", () => {
  let p: Platform, drop: () => Promise<void>, owner: Ctx & { token: string }, acct: string, other: string;
  beforeAll(async () => {
    ({ p, drop } = await testPlatform());
    owner = await user(p, "owner@fe.test");
    acct = await demoAccount(p, owner, "owner@fe.test");
    other = await demoAccount(p, owner, "second@fe.test");
  });
  afterAll(() => drop());

  it("deleting a label removes it from messages, and only its owner can", async () => {
    const m = await deliver(p, owner, acct, { from: "a@x.test", subject: "Label me", text: "hello" });
    const l = await createLabel(p, owner, acct, "Keep", "#123456");
    await threadAction(p, owner, m.thread_id, { action: "label", labelId: l.id });
    expect((await getThread(p, owner, m.thread_id)).labels.map(x => x.name)).toEqual(["Keep"]);
    await deleteLabel(p, owner, l.id);
    expect((await getThread(p, owner, m.thread_id)).labels).toEqual([]);
    expect((await listLabels(p, owner)).some((x: any) => x.id === l.id)).toBe(false);
    await expect(deleteLabel(p, owner, l.id)).rejects.toMatchObject({ status: 404 });
  });

  it("a colleague with read access can't delete a label, and a stranger can't see one", async () => {
    const org = await user(p, "org-owner@fe.test", { kind: "organization" });
    const mate = await user(p, "mate@fe.test");
    await p.db.withSystem(t => t.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES ($1,$2,'member')", [org.tenantId, mate.userId]));
    const mailbox = await demoAccount(p, org, "org-owner@fe.test");
    const l = await createLabel(p, org, mailbox, "Private");
    const asMate: Ctx = { tenantId: org.tenantId, userId: mate.userId };
    await expect(deleteLabel(p, asMate, l.id)).rejects.toMatchObject({ status: 404 });
    await grantMailbox(p, org, mailbox, mate.userId);
    await expect(deleteLabel(p, asMate, l.id)).rejects.toMatchObject({ status: 403 });
    await expect(deleteLabel(p, mate, l.id)).rejects.toMatchObject({ status: 404 });
  });

  it("a label from another mailbox is refused", async () => {
    const m = await deliver(p, owner, acct, { from: "b@x.test", subject: "Wrong label", text: "hello" });
    const l = await createLabel(p, owner, other, "Other mailbox");
    await expect(threadAction(p, owner, m.thread_id, { action: "label", labelId: l.id })).rejects.toMatchObject({ code: "wrong_account" });
  });

  it("sends from a listed alias, refuses anything else, and rechecks when it goes out", async () => {
    await updateAccount(p, owner, acct, { aliases: [{ address: "Sales@fe.test", name: "Sales" }] });
    const d = await saveDraft(p, owner, { accountId: acct, to: ["x@y.test"], cc: [], bcc: [], subject: "Alias", text: "hi", aiGenerated: false, fromAlias: "sales@fe.test" });
    await expect(send(p, owner, d.id, "ceo@elsewhere.test", "alias-refused")).rejects.toMatchObject({ code: "identity_mismatch" });
    await send(p, owner, d.id, "sales@fe.test", "alias-ok");
    await drainJobs(p);
    const raw = await p.db.withWorker(owner.tenantId, t => t.one<any>("SELECT raw FROM demo_mailbox WHERE account_id=$1 AND folder_role='sent' ORDER BY internal_date DESC LIMIT 1", [acct]));
    expect(raw.raw.toString()).toMatch(/From: .*sales@fe\.test/i);
    const sentMail = await p.db.withWorker(owner.tenantId, t => t.one<any>("SELECT from_me FROM messages WHERE account_id=$1 AND folder_role='sent' ORDER BY internal_date DESC LIMIT 1", [acct]));
    expect(sentMail?.from_me ?? true).toBe(true);

    const later = await saveDraft(p, owner, { accountId: acct, to: ["x@y.test"], cc: [], bcc: [], subject: "Later", text: "hi", aiGenerated: false });
    await approveSend(p, owner, later.id, { expectedFrom: "sales@fe.test", idempotencyKey: "alias-removed-0000", acknowledgedRisk: false, scheduledFor: new Date(Date.now() + 3600e3).toISOString() });
    await updateAccount(p, owner, acct, { aliases: [] });
    await p.db.withSystem(t => t.query("UPDATE jobs SET run_at=now(), max_attempts=1 WHERE kind='send.execute' AND state='queued'"));
    await drainJobs(p);
    const dead = await p.db.withSystem(t => t.one<any>("SELECT last_error_code FROM jobs WHERE kind='send.execute' AND state='dead' ORDER BY created_at DESC LIMIT 1"));
    expect(dead?.last_error_code).toBe("identity_mismatch");
    const before = (await p.db.withWorker(owner.tenantId, t => t.query("SELECT 1 FROM demo_mailbox WHERE account_id=$1 AND folder_role='sent'", [acct]))).length;
    expect(before).toBe(1);
  });

  it("attachments survive autosave, stay out of the draft list, reach the provider and are capped", async () => {
    const d = await saveDraft(p, owner, { accountId: other, to: ["x@y.test"], cc: [], bcc: [], subject: "With a file", text: "see file", aiGenerated: false });
    const added = await addDraftAttachment(p, owner, d.id, { filename: "../notes\r\n.txt", contentType: "text/plain", dataBase64: Buffer.from("file body here").toString("base64") });
    expect(added.attachments[0]).toMatchObject({ filename: ".._notes_.txt", size: 14 });
    expect(added.attachments[0]).not.toHaveProperty("data");
    await saveDraft(p, owner, { id: d.id, accountId: other, to: ["x@y.test"], cc: [], bcc: [], subject: "With a file", text: "edited", aiGenerated: false });
    const listed = (await listDrafts(p, owner)).find(x => x.id === d.id)!;
    expect(listed.text).toBe("edited");
    expect(listed.attachments).toHaveLength(1);
    expect(listed.attachments[0]).not.toHaveProperty("data");
    const big = Buffer.alloc(3 * 1024 * 1024).toString("base64");
    await expect(addDraftAttachment(p, owner, d.id, { filename: "big.bin", dataBase64: big })).rejects.toMatchObject({ code: "attachments_too_large" });
    const stay = await addDraftAttachment(p, owner, d.id, { filename: "drop.txt", dataBase64: Buffer.from("x").toString("base64") });
    const left = await removeDraftAttachment(p, owner, d.id, stay.attachments[1]!.id);
    expect(left.attachments).toHaveLength(1);
    await send(p, owner, d.id, "second@fe.test", "attach-send");
    await drainJobs(p);
    const raw = await p.db.withWorker(owner.tenantId, t => t.one<any>("SELECT raw FROM demo_mailbox WHERE account_id=$1 AND folder_role='sent' ORDER BY internal_date DESC LIMIT 1", [other]));
    expect(raw.raw.toString()).toContain("filename=");
    expect(raw.raw.toString()).toContain(Buffer.from("file body here").toString("base64"));
    await expect(addDraftAttachment(p, owner, d.id, { filename: "late.txt", dataBase64: "eA==" })).rejects.toMatchObject({ code: "draft_locked" });
  });

  it("a provider refusal is rolled back, labels included, and only the requester is told", async () => {
    const since = new Date(Date.now() - 1000);
    const m = await deliver(p, owner, acct, { from: "c@x.test", subject: "Refuse me", text: "hello" });
    const l = await createLabel(p, owner, acct, "Refused");
    await drainJobs(p);
    const [row] = await p.db.withSystem(t => t.query<any>("INSERT INTO jobs(tenant_id,kind,payload,state,max_attempts) VALUES ($1,'provider.change',$2,'queued',1) RETURNING id", [owner.tenantId, JSON.stringify({ accountId: acct, messageId: m.id, change: { addLabels: ["Refused"] }, rollback: { label_id: l.id, label_applied: false }, userId: owner.userId })]));
    await p.db.withWorker(owner.tenantId, t => t.query("INSERT INTO message_labels(message_id,label_id,tenant_id,account_id) VALUES ($1,$2,$3,$4)", [m.id, l.id, owner.tenantId, acct]));
    const { DemoAdapter } = await import("../demo-adapter");
    const original = DemoAdapter.prototype.applyChange;
    DemoAdapter.prototype.applyChange = async () => { throw new Error("provider said no"); };
    try { await drainJobs(p); } finally { DemoAdapter.prototype.applyChange = original; }
    expect(row).toBeTruthy();
    expect((await getThread(p, owner, m.thread_id)).labels).toEqual([]);
    const seen = await recentRefusals(p, owner, since);
    expect(seen.map(r => r.messageId)).toContain(m.id);
    expect(seen.find(r => r.messageId === m.id)!.threadId).toBe(m.thread_id);
    const someoneElse = await user(p, "someone@fe.test");
    expect(await recentRefusals(p, someoneElse, since)).toEqual([]);
  });

  it("security review can't be hidden, whatever is stored", async () => {
    const focus = await getFocus(p, owner, { hidden: ["security_review", "low_priority"] });
    const keys = focus.sections.map(s => s.key);
    expect(keys).toContain("security_review");
    expect(keys).not.toContain("low_priority");
  });

  it("a rule can be edited, is revalidated, and reports runs without content", async () => {
    const definition = { trigger: "message.classified", match: "all", conditions: [{ type: "from_domain", domains: ["example.com"] }], actions: [{ type: "star" }] };
    const { id } = await createAutomation(p, owner, { name: "Star", definition, enabled: true });
    await expect(updateAutomation(p, owner, id, { definition: { ...definition, actions: [{ type: "send_mail" }] } })).rejects.toMatchObject({ code: "invalid_rule" });
    await updateAutomation(p, owner, id, { name: "Archive", definition: { ...definition, actions: [{ type: "archive" }] } });
    const row = await p.db.withUser(owner, t => t.one<any>("SELECT name, risk_class, definition FROM automations WHERE id=$1", [id]));
    expect(row).toMatchObject({ name: "Archive", risk_class: "medium" });
    expect(await automationRuns(p, owner, id)).toEqual([]);
    const stranger = await user(p, "stranger@fe.test");
    await expect(updateAutomation(p, stranger, id, { name: "Stolen" })).rejects.toMatchObject({ status: 404 });
  });
});
