import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configFromEnv, invite, signUp, type Platform } from "../index";
import { testPlatform } from "./harness";

const pw = "correct-horse-battery";
const join = (p: Platform, email: string) => signUp(p, { email, password: pw, name: "x", workspaceKind: "personal" });

describe("sign-up by invitation", () => {
  let p: Platform, drop: () => Promise<void>;
  beforeAll(async () => ({ p, drop } = await testPlatform({ config: { demoMode: true, appOrigin: "http://localhost:3000", webauthnRpId: "localhost", signup: "invite" } })));
  afterAll(async () => drop());

  it("lets the first account in, so an empty server can be set up", async () => {
    await expect(join(p, "admin@example.com")).resolves.toMatchObject({ userId: expect.any(String) });
  });
  it("refuses anyone else", async () => {
    await expect(join(p, "stranger@example.com")).rejects.toMatchObject({ code: "signup_closed", status: 403 });
  });
  it("lets an invited address in", async () => {
    const admin = await p.db.withSystem(t => t.one<{ id: string; tenant_id: string }>("SELECT u.id, m.tenant_id FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.email='admin@example.com'"));
    await p.db.withSystem(t => t.query("UPDATE organizations SET kind='organization' WHERE id=$1", [admin!.tenant_id]));
    await invite(p, { tenantId: admin!.tenant_id, userId: admin!.id }, { email: "Invited@Example.com", role: "member" });
    await expect(join(p, "invited@example.com")).resolves.toMatchObject({ userId: expect.any(String) });
  });
});

describe("sign-up mode from the environment", () => {
  it("is closed by default on a production server, and stays closed on a typo", () => {
    expect(configFromEnv({ NODE_ENV: "production" }).signup).toBe("invite");
    expect(configFromEnv({ NODE_ENV: "production", AEGIS_SIGNUP: "opne" }).signup).toBe("invite");
    expect(configFromEnv({ AEGIS_SIGNUP: "opne" }).signup).toBe("invite");
  });
  it("opens when asked, in demo mode, and in development", () => {
    expect(configFromEnv({ NODE_ENV: "production", AEGIS_SIGNUP: "open" }).signup).toBe("open");
    expect(configFromEnv({ NODE_ENV: "production", DEMO_MODE: "true" }).signup).toBe("open");
    expect(configFromEnv({ NODE_ENV: "development" }).signup).toBe("open");
    expect(configFromEnv({ DEMO_MODE: "true", AEGIS_SIGNUP: "invite" }).signup).toBe("invite");
  });
});
