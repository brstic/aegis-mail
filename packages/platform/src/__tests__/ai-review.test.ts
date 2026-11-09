import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FlagReview, SemanticClassifier } from "@aegis/security-engine";
import { connectAccount, decideQuarantine, drainJobs, enqueue, getThread, recordFeedback, type Ctx, type Platform } from "../index";
import { deliver, demoAccount, testPlatform, user } from "./harness";

/**
 * Detectors flag, the AI decides. A false positive is delivered and remembered as an exception for that sender; a
 * confirmed threat stays held; and mail an older engine held is looked at again.
 */
describe("AI review of detector flags", () => {
  let p: Platform, drop: () => Promise<void>, ctx: Ctx, acc: string;
  let answer: FlagReview | null = null;
  const asked: { fromDomain: string; findings: { code: string }[] }[] = [];
  const semantic: SemanticClassifier = { id: "fake", classify: async () => ({ evidence: [] }), review: async f => { asked.push(f); return answer; } };
  const fp = (exception: FlagReview["exception"]): FlagReview => ({ verdict: "false_positive", confidence: 0.95, rationale: "A colleague writing from a personal address.", exception });
  const contact = (hash: string) => p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT trusted_at, trusted_scope, trusted_by, received_count FROM contacts WHERE account_id=$1 AND sender_hash=$2", [acc, hash]));
  const row = (id: string) => p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT m.held, m.risk_label, m.policy_action, m.folder_role, m.sender_hash, q.state FROM messages m LEFT JOIN quarantine_items q ON q.message_id=m.id WHERE m.id=$1", [id]));

  // A known colleague's name arriving from a new domain, inside an existing conversation: two detector hits, held without a review.
  const thread = async (name: string, work: string) => {
    for (let i = 0; i < 2; i++) await deliver(p, ctx, acc, { from: `"${name}" <${work}>`, subject: `Notes ${name} ${i}`, text: "Notes attached below." });
    return deliver(p, ctx, acc, { from: `"${name}" <${work}>`, subject: `Hosting ${name}`, text: "Can you look at the hosting accounts?", messageId: `<root-${name.replace(/\s/g, "")}@work>` }, { thread: `t-${name}` });
  };
  const personal = (name: string, address: string, text = "Replying from my phone. The fix is live.") =>
    deliver(p, ctx, acc, { from: `"${name}" <${address}>`, subject: `Re: Hosting ${name}`, text, inReplyTo: `<root-${name.replace(/\s/g, "")}@work>`, references: `<root-${name.replace(/\s/g, "")}@work>` }, { thread: `t-${name}` });

  beforeAll(async () => {
    ({ p, drop } = await testPlatform({ semantic }));
    ctx = await user(p, "herc@fernhill.example");
    acc = await demoAccount(p, ctx);
  });
  afterAll(async () => { await drop(); });

  it("with no review available, the detectors' flag holds the message", async () => {
    await thread("Nikola Petrov", "nikola@oakfield.example");
    answer = null;
    const m = await personal("Nikola Petrov", "nikola.petrov@gmail.com");
    expect(m).toMatchObject({ held: true, policy_action: "quarantine" });
    expect(asked.at(-1)!.findings.map(f => f.code)).toEqual(expect.arrayContaining(["HDR_KNOWN_NAME_NEW_DOMAIN", "THREAD_NEW_DOMAIN"]));
  });

  it("a false positive is delivered, explained, and the sender gets an exception", async () => {
    await thread("Vasa Ilic", "vasa@oakfield.example");
    answer = fp("domain");
    const m = await personal("Vasa Ilic", "vasa.ilic@gmail.com");
    expect(m).toMatchObject({ held: false, risk_label: "safe", policy_action: "allow" });
    const r = await row(m.id);
    // gmail.com is free mail: a domain-wide exception would trust everyone there, so it's narrowed to the address.
    expect(await contact(r.sender_hash)).toMatchObject({ trusted_scope: "sender", trusted_by: "ai" });
    const detail = await getThread(p, ctx, m.thread_id);
    expect(JSON.stringify(detail)).toMatch(/colleague writing from a personal address/);
    const audit = await p.db.withSystem(t => t.query<any>("SELECT meta FROM audit_events WHERE tenant_id=$1 AND event='sender.exception_added'", [ctx.tenantId]));
    expect(audit.map(a => a.meta)).toContainEqual({ scope: "sender", by: "ai" });
  });

  it("the excepted sender's next message isn't flagged, and nobody is asked", async () => {
    const before = asked.length;
    answer = null;
    const m = await personal("Vasa Ilic", "vasa.ilic@gmail.com", "One more thing: staging is updated too.");
    expect(m).toMatchObject({ held: false, risk_label: "safe" });
    expect(asked.length).toBe(before);
  });

  it("the exception doesn't cover a forged copy of the same address", async () => {
    const m = await deliver(p, ctx, acc, { from: `"Vasa Ilic" <vasa.ilic@gmail.com>`, auth: "fail", subject: "Re: Hosting Vasa Ilic", text: "Please send the wire today.", inReplyTo: "<root-VasaIlic@work>" }, { thread: "t-Vasa Ilic" });
    expect(m.held).toBe(true);
  });

  it("a domain-wide exception covers other addresses at an organization's domain", async () => {
    await thread("Sanja Roy", "sanja@northwind.example");
    answer = fp("domain");
    const first = await deliver(p, ctx, acc, { from: `"Sanja Roy" <sanja@northwind-mail.example>`, subject: "Re: Hosting Sanja Roy", text: "From our new mail system.", inReplyTo: "<root-SanjaRoy@work>" }, { thread: "t-Sanja Roy" });
    expect(first.held).toBe(false);
    expect(await contact((await row(first.id)).sender_hash)).toMatchObject({ trusted_scope: "domain", trusted_by: "ai" });
    answer = null;
    const before = asked.length;
    const other = await deliver(p, ctx, acc, { from: `"Northwind Billing" <billing@northwind-mail.example>`, subject: "Statement", text: "Your statement is ready." });
    expect(other).toMatchObject({ held: false, risk_label: "safe" });
    expect(asked.length).toBe(before);
  });

  it("a confirmed threat stays held and gets no exception", async () => {
    await thread("Tom Avery", "tom@averyco.example");
    answer = { verdict: "threat", confidence: 0.9, rationale: "Impersonates a known contact.", exception: "sender" };
    const m = await personal("Tom Avery", "tom.avery.office@gmail.com");
    expect(m).toMatchObject({ held: true, policy_action: "quarantine" });
    expect(await contact((await row(m.id)).sender_hash)).toBeNull();
  });

  it("the owner releasing a message records an exception too, and reporting the sender takes it back", async () => {
    await thread("Lena Park", "lena@brightline.example");
    answer = null;
    const m = await personal("Lena Park", "lena.park@gmail.com");
    expect(m.held).toBe(true);
    await decideQuarantine(p, ctx, m.id, "release");
    await drainJobs(p);
    const hash = (await row(m.id)).sender_hash;
    expect(await contact(hash)).toMatchObject({ trusted_scope: "sender", trusted_by: "user" });
    const next = await personal("Lena Park", "lena.park@gmail.com", "Following up on the above.");
    expect(next.held).toBe(false);
    await recordFeedback(p, ctx, next.id, "report_phishing");
    await drainJobs(p);
    expect((await contact(hash)).trusted_at).toBeNull();
  });

  it("mail an older engine held is reviewed again, released to where it was, and the rest stays held", async () => {
    await thread("Dana White", "dana@whitfield.example");
    await thread("Omar Haddad", "omar@haddad.example");
    answer = null;
    const good = await personal("Dana White", "dana.white@gmail.com");
    const bad = await personal("Omar Haddad", "omar.haddad.pay@gmail.com");
    expect([good.held, bad.held]).toEqual([true, true]);
    // As if both verdicts came from the engine before this one.
    await p.db.withWorker(ctx.tenantId, t => t.query("UPDATE security_analyses SET engine_version='det-older' WHERE message_id = ANY($1)", [[good.id, bad.id]]));
    (semantic as { review: SemanticClassifier["review"] }).review = async f => { asked.push(f); return f.fromName === "Dana White" ? fp("sender") : { verdict: "threat", confidence: 0.9, rationale: "Asks for payment from a new address.", exception: "none" }; };
    await p.db.withSystem(t => enqueue(t, { tenantId: ctx.tenantId, kind: "quarantine.recheck", payload: { accountId: acc } }));
    await drainJobs(p);
    expect(await row(good.id)).toMatchObject({ held: false, state: "released", folder_role: "inbox", risk_label: "safe" });
    expect(await row(bad.id)).toMatchObject({ held: true, state: "held" });
    // Each is looked at once per engine version: a second run finds nothing to do.
    const before = asked.length;
    await p.db.withSystem(t => enqueue(t, { tenantId: ctx.tenantId, kind: "quarantine.recheck", payload: { accountId: acc } }));
    await drainJobs(p);
    expect(asked.length).toBe(before);
  });

  it("mail between the owner's own mailboxes isn't flagged as the owner being impersonated", async () => {
    await connectAccount(p, ctx, { kind: "demo", email: "herc.personal@gmail.com", displayName: "Personal", credential: { kind: "demo" } });
    await drainJobs(p);
    answer = null;
    const before = asked.length;
    const m = await deliver(p, ctx, acc, { from: `"herc" <herc.personal@gmail.com>`, subject: "Note to self", text: "Remember the hosting invoices." });
    expect(m).toMatchObject({ held: false, risk_label: "safe" });
    expect(asked.length).toBe(before);
  });
});
