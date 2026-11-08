import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkAccountLimit, checkSeatLimit, computeLimits, configFromEnv, connectAccount, type Ctx, getLimits, limitsFor, limitsFromEnv, type Platform, UNLIMITED } from "../index";
import { testPlatform, user } from "./harness";

const NOW = new Date("2026-11-08T12:00:00Z");

describe("limits, worked out", () => {
  it("are all unlimited by default, as null", () => {
    expect(computeLimits(undefined, [], NOW)).toEqual({ ...UNLIMITED, overridden: [] });
    expect(computeLimits({}, [], NOW)).toEqual({ accounts: null, aiActionsPerMonth: null, automations: null, seats: null, indexBytes: null, overridden: [] });
  });
  it("take the instance default where one is set, and only there", () => {
    expect(computeLimits({ accounts: 3, seats: 10 }, [], NOW)).toMatchObject({ accounts: 3, seats: 10, automations: null, aiActionsPerMonth: null, overridden: [] });
  });
  it("take an operator's setting over the instance default, including no limit at all", () => {
    const l = computeLimits({ accounts: 3, seats: 10 }, [{ key: "accounts", value: 40, expiresAt: null }, { key: "seats", value: null, expiresAt: null }, { key: "automations", value: 0, expiresAt: null }], NOW);
    expect(l).toMatchObject({ accounts: 40, seats: null, automations: 0 });
    expect(l.overridden.sort()).toEqual(["accounts", "automations", "seats"]);
  });
  it("ignore an expired setting, a value that isn't a limit, and a key that isn't one", () => {
    const l = computeLimits({ accounts: 3 }, [
      { key: "accounts", value: 40, expiresAt: new Date(NOW.getTime() - 1) },
      { key: "seats", value: -1, expiresAt: null },
      { key: "automations", value: true, expiresAt: null },
      { key: "securityWarnings", value: 0, expiresAt: null },
      { key: "sso", value: false, expiresAt: null },
    ], NOW);
    expect(l).toEqual({ ...UNLIMITED, accounts: 3, overridden: [] });
  });
});

describe("instance defaults from the environment", () => {
  it("unset or empty is no limit", () => {
    expect(limitsFromEnv({})).toEqual({});
    expect(limitsFromEnv({ AEGIS_LIMIT_ACCOUNTS: "", AEGIS_LIMIT_SEATS: "  " })).toEqual({});
    expect(configFromEnv({}).limits).toEqual({});
  });
  it("reads each variable", () => {
    expect(limitsFromEnv({ AEGIS_LIMIT_ACCOUNTS: "5", AEGIS_LIMIT_AI_ACTIONS_PER_MONTH: "1000", AEGIS_LIMIT_AUTOMATIONS: "0", AEGIS_LIMIT_SEATS: "25", AEGIS_LIMIT_INDEX_BYTES: "10737418240" }))
      .toEqual({ accounts: 5, aiActionsPerMonth: 1000, automations: 0, seats: 25, indexBytes: 10737418240 });
  });
  it("refuses to start on a value that isn't a whole number of zero or more, instead of quietly ignoring it", () => {
    for (const v of ["-1", "1.5", "ten", "unlimited", "1e3"]) expect(() => limitsFromEnv({ AEGIS_LIMIT_ACCOUNTS: v }), v).toThrow(/AEGIS_LIMIT_ACCOUNTS/);
  });
});

describe("limits, applied", () => {
  let p: Platform, drop: () => Promise<void>, owner: Ctx;
  beforeAll(async () => {
    ({ p, drop } = await testPlatform());
    owner = await user(p, "owner@limits.example", { kind: "organization" });
  });
  afterAll(async () => { p.config.limits = {}; await drop(); });
  const connect = (n: number) => connectAccount(p, owner, { kind: "demo", email: `box${n}@limits.example`, displayName: `Box ${n}`, credential: { kind: "demo" } });

  it("with nothing set, nothing is refused and the person is told there's no limit", async () => {
    for (let i = 0; i < 4; i++) { await checkAccountLimit(p, owner); await connect(i); }
    await checkSeatLimit(p, owner);
    const r = await getLimits(p, owner);
    expect(r.limits).toEqual(UNLIMITED);
    expect(r.usage).toMatchObject({ accounts: 4, seats: 1 });
  });

  it("an instance default applies to every workspace, with a calm message", async () => {
    p.config.limits = { accounts: 4 };
    await expect(checkAccountLimit(p, owner)).rejects.toMatchObject({ status: 403, code: "limit_reached", message: "This workspace's limit is 4 connected accounts. The server admin can raise it." });
    const other = await user(p, "other@limits.example");
    await expect(checkAccountLimit(p, other)).resolves.toBeUndefined();
    expect((await getLimits(p, owner)).limits.accounts).toBe(4);
  });

  it("an operator's setting for one workspace wins over the default, in both directions", async () => {
    await p.db.withSystem(t => t.query("INSERT INTO tenant_limit_overrides(tenant_id,key,value,reason) VALUES ($1,'accounts','10','test')", [owner.tenantId]));
    await expect(checkAccountLimit(p, owner)).resolves.toBeUndefined();
    expect((await limitsFor(p, owner.tenantId)).accounts).toBe(10);
    await p.db.withSystem(t => t.query("UPDATE tenant_limit_overrides SET value='null' WHERE tenant_id=$1 AND key='accounts'", [owner.tenantId]));
    expect((await limitsFor(p, owner.tenantId)).accounts).toBeNull();
    await p.db.withSystem(t => t.query("UPDATE tenant_limit_overrides SET value='2' WHERE tenant_id=$1 AND key='accounts'", [owner.tenantId]));
    await expect(checkAccountLimit(p, owner)).rejects.toMatchObject({ code: "limit_reached" });
    await p.db.withSystem(t => t.query("DELETE FROM tenant_limit_overrides WHERE tenant_id=$1", [owner.tenantId]));
  });

  it("a member limit counts pending invitations, and says one member properly", async () => {
    p.config.limits = { seats: 1 };
    await expect(checkSeatLimit(p, owner)).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/^This workspace's limit is 1 member, and every place is taken\. The server admin can raise it\./) });
    p.config.limits = { seats: 2 };
    await checkSeatLimit(p, owner);
    await p.db.withUser(owner, t => t.query("INSERT INTO invitations(tenant_id,email,role,token_hash,invited_by,expires_at) VALUES ($1,'held@limits.example','member','lim1',$2, now() + interval '1 day')", [owner.tenantId, owner.userId]));
    await expect(checkSeatLimit(p, owner)).rejects.toMatchObject({ code: "limit_reached" });
  });
});
