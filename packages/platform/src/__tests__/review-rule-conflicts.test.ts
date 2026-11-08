import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAutomation, type Ctx, type Platform, resolveConflicts } from "../index";
import { deliver, demoAccount, testPlatform, user } from "./harness";

/**
 * Independent review of resolveConflicts. Its comment says holding beats anything that would hide the message. Each test states that
 * behaviour, so a failure here is the bug.
 */
describe("review: rule conflicts", () => {
  const hold = { type: "hold" as const };

  it("a low-priority section loses to a hold", () => {
    const low = { type: "set_section" as const, section: "low_priority" as const };
    expect(resolveConflicts([hold, low]).has(low)).toBe(true);
  });

  it("the digest loses to a hold", () => {
    const digest = { type: "add_to_digest" as const };
    expect(resolveConflicts([hold, digest]).has(digest)).toBe(true);
  });

  describe("end to end", () => {
    let p: Platform, drop: () => Promise<void>, ctx: Ctx, acct: string;
    beforeAll(async () => {
      ({ p, drop } = await testPlatform());
      ctx = await user(p, "rules@conflict.example");
      acct = await demoAccount(p, ctx, "rules@conflict.example");
    });
    afterAll(() => drop());

    it("a held message stays in security review when another rule files it under the digest", async () => {
      const cond = [{ type: "subject_contains", terms: ["wire details"] }];
      await createAutomation(p, ctx, { name: "hold it", enabled: true, definition: { trigger: "message.classified", conditions: cond, actions: [{ type: "hold" }] } });
      await createAutomation(p, ctx, { name: "digest it", enabled: true, definition: { trigger: "message.classified", conditions: cond, actions: [{ type: "add_to_digest" }] } });
      const m = await deliver(p, ctx, acct, { from: `"Pat" <pat@oak.example>`, subject: "wire details for Friday", text: "See you then." });
      expect(m.held).toBe(true);
      expect(m.priority_section).toBe("security_review");
    });
  });
});
