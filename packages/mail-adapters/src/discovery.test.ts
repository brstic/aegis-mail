import { describe, expect, it, vi } from "vitest";
import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";
import { suggestSettings } from "./index";

describe("suggestSettings", () => {
  it.each(["icloud.com", "me.com", "mac.com"])("gives the iCloud preset for %s", (domain) => {
    const s = suggestSettings(`jane@${domain}`);
    expect(s).toMatchObject({
      provider: "icloud", confirmed: true, requiresUserConfirmation: true,
      imap: { host: "imap.mail.me.com", port: 993, security: "tls" },
      smtp: { host: "smtp.mail.me.com", port: 587, security: "starttls" },
      usernames: ["jane", `jane@${domain}`],
    });
    expect(s.guidance).toMatch(/app-specific password/);
  });

  it.each([
    ["yahoo.com", "imap.mail.yahoo.com", "smtp.mail.yahoo.com"],
    ["fastmail.com", "imap.fastmail.com", "smtp.fastmail.com"],
    ["zoho.com", "imap.zoho.com", "smtp.zoho.com"],
  ])("gives a preset for %s", (domain, imap, smtp) => {
    const s = suggestSettings(`jane@${domain}`);
    expect(s.imap?.host).toBe(imap);
    expect(s.smtp?.host).toBe(smtp);
    expect(s.confirmed).toBe(true);
    expect(s.guidance).toMatch(/app password/);
  });

  it.each([["gmail.com", "gmail"], ["googlemail.com", "gmail"], ["outlook.com", "microsoft"], ["hotmail.com", "microsoft"], ["live.com", "microsoft"]])(
    "sends %s to OAuth, with no servers to mistype a password into", (domain, useOAuth) => {
      const s = suggestSettings(`jane@${domain}`);
      expect(s.useOAuth).toBe(useOAuth);
      expect(s.imap).toBeUndefined();
      expect(s.smtp).toBeUndefined();
      expect(s.requiresUserConfirmation).toBe(true);
    },
  );

  it("guesses for an unknown domain and flags it unconfirmed", () => {
    const s = suggestSettings("jane@Example.ORG");
    expect(s).toMatchObject({
      confirmed: false, requiresUserConfirmation: true,
      imap: { host: "imap.example.org", port: 993, security: "tls" },
      smtp: { host: "smtp.example.org", port: 587, security: "starttls" },
    });
    expect(s.guidance).toMatch(/guess/);
    expect(s.guidance).toMatch(/app password/);
  });

  it.each(["no-at-sign", "a@", "a@localhost", "a@[127.0.0.1]", "a@127.0.0.1", "a@evil.com/../x", "a@evil.com:993", "a@-bad.com", "a@evil.com\r\nX", "@", "", "a@__proto__", "a@constructor"])(
    "suggests no server for the malformed address %j", (email) => {
      const s = suggestSettings(email);
      expect(s.imap).toBeUndefined();
      expect(s.smtp).toBeUndefined();
      expect(s.confirmed).toBe(false);
      expect(s.requiresUserConfirmation).toBe(true);
    },
  );

  it("every result requires confirmation and carries guidance", () => {
    for (const email of ["a@icloud.com", "a@gmail.com", "a@example.org", "nope"]) {
      const s = suggestSettings(email);
      expect(s.requiresUserConfirmation).toBe(true);
      expect(s.guidance.length).toBeGreaterThan(0);
    }
  });

  it("never touches the network", () => {
    const spies = [
      vi.spyOn(globalThis, "fetch"), vi.spyOn(dns, "lookup"), vi.spyOn(dns.promises, "lookup"), vi.spyOn(dns.promises, "resolve"),
      vi.spyOn(net, "connect"), vi.spyOn(net.Socket.prototype, "connect"), vi.spyOn(tls, "connect"),
    ];
    for (const email of ["a@icloud.com", "a@gmail.com", "a@unknown-hostile.example", "bad"]) suggestSettings(email);
    for (const spy of spies) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); }
  });

  it("is synchronous, so it can't be awaiting anything", () => {
    expect(suggestSettings("a@example.org")).not.toBeInstanceOf(Promise);
  });
});
