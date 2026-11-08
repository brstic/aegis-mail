import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptInvite, addDomain, authenticateScim, type Ctx, drainJobs, type Platform, resolveSession, revokeScimToken, rotateScimToken, type ScimAuth, ScimError, scimCreateUser, scimDeleteUser, scimGetUser, scimListUsers, scimPatchUser, scimServiceProviderConfig, signIn, signUp, verifyDomain, invite } from "../index";
import { deliver, demoAccount, markVerified, testPlatform, user } from "./harness";

const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const off = { schemas: [PATCH], Operations: [{ op: "replace", path: "active", value: false }] };
const SECRET = "SCIM-MAIL-SENTINEL-77";

describe("SCIM provisioning", () => {
  let p: Platform, drop: () => Promise<void>, a: Ctx, b: Ctx, tokenA: string, tokenB: string, authA: ScimAuth, authB: ScimAuth;
  const verified = async (ctx: Ctx, domain: string) => { const d = await addDomain(p, ctx, domain); await verifyDomain(p, ctx, domain, async () => [[d!.token]]); };
  beforeAll(async () => {
    ({ p, drop } = await testPlatform());
    a = await user(p, "owner@a-admin.example", { kind: "organization" });
    b = await user(p, "owner@b-admin.example", { kind: "organization" });
    await verified(a, "a.example"); await verified(b, "b.example");
    tokenA = (await rotateScimToken(p, a)).token; tokenB = (await rotateScimToken(p, b)).token;
    authA = await authenticateScim(p, `Bearer ${tokenA}`); authB = await authenticateScim(p, `Bearer ${tokenB}`);
  });
  afterAll(() => drop());
  const create = (auth: ScimAuth, userName: string, extra = {}) => scimCreateUser(p, auth, { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName, displayName: "Person", ...extra });

  describe("tokens", () => {
    it("are stored hashed", async () => {
      const rows = await p.db.withSystem(t => t.query<any>("SELECT token_hash FROM scim_tokens"));
      expect(JSON.stringify(rows)).not.toContain(tokenA);
      expect(rows.every(r => /^[0-9a-f]{64}$/.test(r.token_hash))).toBe(true);
    });
    it("a missing, malformed or made-up token is refused", async () => {
      for (const h of [null, "", "Bearer", "Basic abc", "Bearer not-a-real-token", `bearer ${tokenA} extra`]) await expect(authenticateScim(p, h)).rejects.toMatchObject({ status: 401 });
    });
    it("a session cookie's token isn't a SCIM token", async () => {
      const s = await user(p, "cookie@a-admin.example");
      await expect(authenticateScim(p, `Bearer ${s.token}`)).rejects.toMatchObject({ status: 401 });
    });
    it("rotation ends the old token right away", async () => {
      const c = await user(p, "rot@c-admin.example", { kind: "organization" });
      const first = (await rotateScimToken(p, c)).token;
      await authenticateScim(p, `Bearer ${first}`);
      const second = (await rotateScimToken(p, c)).token;
      await expect(authenticateScim(p, `Bearer ${first}`)).rejects.toMatchObject({ status: 401 });
      await expect(authenticateScim(p, `Bearer ${second}`)).resolves.toMatchObject({ tenantId: c.tenantId });
      await revokeScimToken(p, c);
      await expect(authenticateScim(p, `Bearer ${second}`)).rejects.toMatchObject({ status: 401 });
    });
    it("a personal workspace can't have one", async () => {
      const u = await user(p, "solo@c-admin.example");
      await expect(rotateScimToken(p, u)).rejects.toMatchObject({ code: "organization_only" });
    });
    it("only an owner can make one", async () => {
      const { acceptUrl } = await invite(p, a, { email: "mgr@a.example", role: "workspace_manager" });
      const s = await signUp(p, { email: "mgr@a.example", password: "correct-horse-battery", name: "M", workspaceKind: "personal" });
      await markVerified(p, s.userId);
      await acceptInvite(p, s.userId, "mgr@a.example", acceptUrl!.split("/").pop()!);
      await expect(rotateScimToken(p, { tenantId: a.tenantId, userId: s.userId })).rejects.toMatchObject({ status: 403 });
    });
  });

  it("publishes a ServiceProviderConfig that's true", () => {
    const c = scimServiceProviderConfig(p);
    expect(c).toMatchObject({ patch: { supported: true }, bulk: { supported: false }, filter: { supported: true }, sort: { supported: false }, etag: { supported: false }, changePassword: { supported: false } });
    expect(c.authenticationSchemes[0]!.type).toBe("oauthbearertoken");
  });

  describe("users", () => {
    it("creates a verified person with a membership", async () => {
      const u = await create(authA, "Alice@A.example", { externalId: "okta-1", displayName: "Alice A" });
      expect(u).toMatchObject({ userName: "alice@a.example", active: true, externalId: "okta-1", displayName: "Alice A" });
      const row = await p.db.withSystem(t => t.one<any>("SELECT u.password_hash, u.email_verified_at, m.role FROM users u JOIN memberships m ON m.user_id=u.id AND m.tenant_id=$2 WHERE u.id=$1", [u.id, a.tenantId]));
      expect(row.password_hash).toBeNull();
      expect(row.email_verified_at).toBeTruthy();
      expect(row.role).toBe("member");
    });
    it("filters by userName eq, and pages", async () => {
      const r = await scimListUsers(p, authA, { filter: 'userName eq "alice@a.example"' });
      expect(r.totalResults).toBe(1);
      expect(r.Resources[0]!.userName).toBe("alice@a.example");
      expect((await scimListUsers(p, authA, { filter: 'username EQ "ALICE@a.example"' })).totalResults).toBe(1);
      expect((await scimListUsers(p, authA, { filter: 'userName eq "nobody@a.example"' })).totalResults).toBe(0);
      const all = await scimListUsers(p, authA, {});
      expect(all.totalResults).toBeGreaterThanOrEqual(2);
      const page = await scimListUsers(p, authA, { startIndex: 2, count: 1 });
      expect(page).toMatchObject({ startIndex: 2, itemsPerPage: 1 });
      expect(page.Resources[0]!.id).toBe(all.Resources[1]!.id);
    });
    it("refuses any other filter rather than ignoring it", async () => {
      for (const f of ['userName sw "a"', 'emails eq "a@a.example"', 'userName eq "a" or userName eq "b"', "active eq true", 'userName eq "x"; DROP TABLE users'])
        await expect(scimListUsers(p, authA, { filter: f })).rejects.toMatchObject({ status: 400, scimType: "invalidFilter" });
    });
    it("gets one by id", async () => {
      const u = await create(authA, "get@a.example");
      expect(await scimGetUser(p, authA, u.id)).toMatchObject({ userName: "get@a.example", active: true });
      await expect(scimGetUser(p, authA, "not-a-uuid")).rejects.toMatchObject({ status: 404 });
      await expect(scimGetUser(p, authA, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ status: 404 });
    });
    it("a second create for the same userName is a conflict", async () => {
      await create(authA, "dup@a.example");
      await expect(create(authA, "dup@a.example")).rejects.toMatchObject({ status: 409, scimType: "uniqueness" });
    });
    it("refuses an address that isn't an email", async () => {
      await expect(create(authA, "not-an-email")).rejects.toMatchObject({ status: 400 });
      await expect(scimCreateUser(p, authA, {})).rejects.toMatchObject({ status: 400 });
    });
    it("can't rename someone: that would point their account at another address", async () => {
      const u = await create(authA, "stay@a.example");
      await expect(scimPatchUser(p, authA, u.id, { schemas: [PATCH], Operations: [{ op: "replace", path: "userName", value: "evil@a.example" }] })).rejects.toMatchObject({ status: 400, scimType: "mutability" });
      await expect(scimPatchUser(p, authA, u.id, { schemas: [PATCH], Operations: [{ op: "replace", value: { emails: [{ value: "evil@a.example" }] } }] })).rejects.toMatchObject({ scimType: "mutability" });
    });
    it("rejects something that isn't a PatchOp", async () => {
      const u = await create(authA, "badpatch@a.example");
      await expect(scimPatchUser(p, authA, u.id, { active: false })).rejects.toMatchObject({ status: 400 });
      await expect(scimPatchUser(p, authA, u.id, { schemas: [PATCH], Operations: [{ op: "remove", path: "active" }] })).rejects.toMatchObject({ status: 400 });
    });
    it("understands Azure's capitalized ops and string booleans, and updates a managed person's name", async () => {
      const u = await create(authA, "azure@a.example");
      const r = await scimPatchUser(p, authA, u.id, { schemas: [PATCH], Operations: [{ op: "Replace", path: "active", value: "False" }, { op: "Replace", path: "displayName", value: "Renamed" }] });
      expect(r).toMatchObject({ active: false, displayName: "Renamed" });
    });
  });

  describe("deprovisioning", () => {
    it("patch active=false removes the member, ends their sessions in the tenant, and disconnects their mailboxes", async () => {
      const email = "leaver@a.example";
      const s = await signUp(p, { email, password: "correct-horse-battery", name: "L", workspaceKind: "personal" });
      await markVerified(p, s.userId);
      const u = await create(authA, email);
      expect(u.id).toBe(s.userId);
      const ctx = { tenantId: a.tenantId, userId: s.userId };
      const acct = await demoAccount(p, ctx, email);
      await deliver(p, ctx, acct, { from: "x@y.test", subject: `Subject ${SECRET}`, text: `Body ${SECRET}` });
      const session = await p.db.withSystem(t => t.one<any>("INSERT INTO sessions(user_id,token_hash,active_tenant_id,expires_at) VALUES ($1,'tok-hash-leaver',$2, now() + interval '1 day') RETURNING id", [s.userId, a.tenantId]));
      const r = await scimPatchUser(p, authA, u.id, off);
      expect(r.active).toBe(false);
      expect(await p.db.withSystem(t => t.one("SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2", [a.tenantId, s.userId]))).toBeNull();
      expect((await p.db.withSystem(t => t.one<any>("SELECT revoked_at FROM sessions WHERE id=$1", [session.id]))).revoked_at).toBeTruthy();
      await drainJobs(p);
      expect((await p.db.withWorker(a.tenantId, t => t.one<any>("SELECT status FROM mail_accounts WHERE id=$1", [acct])))?.status ?? "disconnected").toBe("disconnected");
      // Still visible to the provider, as inactive.
      expect(await scimGetUser(p, authA, u.id)).toMatchObject({ active: false });
      // Their own workspace and password still work: this removed them from one organization, not from the product.
      await expect(signIn(p, { email, password: "correct-horse-battery" })).resolves.toBeDefined();
    });
    it("active=true brings them back as the default role", async () => {
      const u = await create(authA, "back@a.example");
      await scimPatchUser(p, authA, u.id, off);
      const r = await scimPatchUser(p, authA, u.id, { schemas: [PATCH], Operations: [{ op: "replace", value: { active: true } }] });
      expect(r.active).toBe(true);
      expect((await p.db.withSystem(t => t.one<any>("SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2", [a.tenantId, u.id]))).role).toBe("member");
    });
    it("delete ends the membership and the record, and keeps the account", async () => {
      const u = await create(authA, "del@a.example");
      await scimDeleteUser(p, authA, u.id);
      await expect(scimGetUser(p, authA, u.id)).rejects.toMatchObject({ status: 404 });
      await expect(scimDeleteUser(p, authA, u.id)).rejects.toMatchObject({ status: 404 });
      expect(await p.db.withSystem(t => t.one("SELECT 1 FROM users WHERE id=$1 AND deleted_at IS NULL", [u.id]))).toBeTruthy();
    });
    it("won't remove the organization's only owner", async () => {
      await expect(scimPatchUser(p, authA, a.userId, off)).rejects.toMatchObject({ status: 409 });
      await expect(scimDeleteUser(p, authA, a.userId)).rejects.toMatchObject({ status: 409 });
      expect((await resolveSession(p, (a as any).token))?.role).toBe("owner");
    });
    it("records it in the audit log with no address", async () => {
      const rows = await p.db.withSystem(t => t.query<any>("SELECT event, meta, target_type FROM audit_events WHERE tenant_id=$1 AND event LIKE 'scim.%'", [a.tenantId]));
      expect(rows.some(r => r.event === "scim.user_deprovisioned")).toBe(true);
      expect(JSON.stringify(rows)).not.toContain("@a.example");
    });
  });

  describe("across tenants", () => {
    it("B's token can't see, change or remove A's people", async () => {
      const victim = await create(authA, "victim@a.example");
      await expect(scimGetUser(p, authB, victim.id)).rejects.toMatchObject({ status: 404 });
      await expect(scimPatchUser(p, authB, victim.id, off)).rejects.toMatchObject({ status: 404 });
      await expect(scimDeleteUser(p, authB, victim.id)).rejects.toMatchObject({ status: 404 });
      expect((await scimListUsers(p, authB, { filter: 'userName eq "victim@a.example"' })).totalResults).toBe(0);
      expect(JSON.stringify(await scimListUsers(p, authB, {}))).not.toContain("a.example");
      expect(await scimGetUser(p, authA, victim.id)).toMatchObject({ active: true });
    });
    it("B can't create or adopt someone on A's domain, or any domain it hasn't verified", async () => {
      const before = await p.db.withSystem(t => t.one<any>("SELECT count(*)::int c FROM users"));
      await expect(create(authB, "newhire@a.example")).rejects.toMatchObject({ status: 403 });
      await expect(create(authB, "victim@a.example")).rejects.toMatchObject({ status: 403 });
      await expect(create(authB, "someone@gmail.com")).rejects.toMatchObject({ status: 403 });
      expect((await p.db.withSystem(t => t.one<any>("SELECT count(*)::int c FROM users")))!.c).toBe(before.c);
    });
    it("an unverified domain of its own isn't enough", async () => {
      await addDomain(p, a, "pending.example");
      await expect(create(authA, "x@pending.example")).rejects.toBeInstanceOf(ScimError);
    });
  });

  describe("linking", () => {
    it("adopts a verified account on the tenant's own domain and leaves its password alone", async () => {
      const s = await signUp(p, { email: "existing@a.example", password: "correct-horse-battery", name: "E", workspaceKind: "personal" });
      await markVerified(p, s.userId);
      const u = await create(authA, "existing@a.example");
      expect(u.id).toBe(s.userId);
      await expect(signIn(p, { email: "existing@a.example", password: "correct-horse-battery" })).resolves.toBeDefined();
    });
    it("pre-hijacking: a squatter's unproven account loses every way in", async () => {
      const s = await signUp(p, { email: "cfo@a.example", password: "squatter-password-123", name: "Squatter", workspaceKind: "personal" });
      const u = await create(authA, "cfo@a.example");
      expect(u.id).toBe(s.userId);
      await expect(signIn(p, { email: "cfo@a.example", password: "squatter-password-123" })).rejects.toMatchObject({ status: 401 });
      expect(await resolveSession(p, s.token)).toBeNull();
    });
  });

  it("never exposes mail: nothing in any response comes from a mailbox", async () => {
    const email = "mailbox@a.example";
    const u = await create(authA, email);
    const ctx = { tenantId: a.tenantId, userId: u.id };
    const acct = await demoAccount(p, ctx, email);
    await deliver(p, ctx, acct, { from: `"Priya" <priya@oak.test>`, subject: `Subject ${SECRET}`, text: `Body ${SECRET}` });
    const out = JSON.stringify([await scimGetUser(p, authA, u.id), await scimListUsers(p, authA, {}), await scimPatchUser(p, authA, u.id, { schemas: [PATCH], Operations: [{ op: "replace", path: "displayName", value: "X" }] })]);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("priya");
    expect(Object.keys(await scimGetUser(p, authA, u.id)).sort()).toEqual(["active", "displayName", "emails", "id", "meta", "name", "schemas", "userName"]);
  });
});
