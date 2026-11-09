import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Platform, verifyByConnectedMailbox, verifyEmailAsOperator } from "../index";
import { testPlatform, user } from "./harness";

/** An install with no mail relay can't send the verification link. These are the two other ways to the same fact. */
describe("verifying an address without the emailed link", () => {
  let p: Platform, drop: () => Promise<void>;
  const verified = async (userId: string) => (await p.db.withSystem(t => t.one<any>("SELECT email_verified_at FROM users WHERE id=$1", [userId])))?.email_verified_at != null;
  beforeAll(async () => { ({ p, drop } = await testPlatform()); });
  afterAll(async () => { await drop(); });

  it("a Gmail mailbox verifies only the address it is, whatever its case", async () => {
    const a = await user(p, "Herc@Example.org");
    expect(await verifyByConnectedMailbox(p, a, "gmail", "someone.else@example.org")).toBe(false);
    expect(await verified(a.userId)).toBe(false);
    expect(await verifyByConnectedMailbox(p, a, "gmail", "herc@example.org")).toBe(true);
    expect(await verified(a.userId)).toBe(true);
    // Already verified: nothing more to do, and no second audit event.
    expect(await verifyByConnectedMailbox(p, a, "gmail", "herc@example.org")).toBe(false);
  });

  it("a Microsoft mailbox doesn't: its reported address is whatever that tenant's administrator typed", async () => {
    const b = await user(p, "victim@corp.example");
    expect(await verifyByConnectedMailbox(p, b, "microsoft", "victim@corp.example")).toBe(false);
    expect(await verified(b.userId)).toBe(false);
  });

  it("the operator command verifies by address, and the emailed link stops working afterwards", async () => {
    const c = await user(p, "relayless@example.org");
    expect(await verifyEmailAsOperator(p, "nobody@example.org")).toBe("no_account");
    expect(await verifyEmailAsOperator(p, " Relayless@Example.org ")).toBe("verified");
    expect(await verified(c.userId)).toBe(true);
    expect(await verifyEmailAsOperator(p, "relayless@example.org")).toBe("already_verified");
    const open = await p.db.withSystem(t => t.query("SELECT 1 FROM email_tokens WHERE user_id=$1 AND purpose='verify_email' AND consumed_at IS NULL", [c.userId]));
    expect(open).toHaveLength(0);
  });
});
