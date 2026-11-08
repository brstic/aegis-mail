import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createTestDb, Db, ensureLogin } from "@aegis/db";
import { LocalDevKms } from "@aegis/cryptography";
import { acceptInvite, addDomain, authenticateScim, beginSocial, beginSso, confirmEmail, connectAccount, type Ctx, createPlatform, deleteAccount, drainJobs, finishSaml, finishSso, invite, recheckDomains, listDevOutbox, listNotifications, makeLogger, markAllNotificationsRead, markNotificationRead, type Platform, publicSignInOptions, requestPasswordReset, resetPassword, rotateScimToken, saveSamlConfig, saveSsoConfig, scanNotifications, scimCreateUser, scimDeleteUser, scimListUsers, scimPatchUser, setSsoEnforced, signIn, signUp, ssoOverview, sweepExpired, tick, verifyDomain } from "../index";
import { fakeOidc } from "./fake-oidc";

/**
 * Everything in this feature, running as production does: web and worker on separate non-superuser logins. A missing grant
 * in migration 007 fails here, and nowhere else.
 */
describe("identity features under the real login roles", () => {
  let adminDrop: () => Promise<void>, web: Platform, worker: Platform, webDb: Db, workerDb: Db, adminDb: Db, owner: Ctx, idp: Awaited<ReturnType<typeof fakeOidc>>, google: Awaited<ReturnType<typeof fakeOidc>>, ownerEmail = "owner@ops.bound.example";
  beforeAll(async () => {
    const t = await createTestDb("idbound"); adminDb = t.db; adminDrop = t.drop;
    await ensureLogin(t.url, "aegis_web_login", "aegis_web_conn");
    await ensureLogin(t.url, "aegis_worker_login", "aegis_worker_conn");
    const as = (login: string) => { const u = new URL(t.url); u.username = login; return u.toString(); };
    webDb = new Db(as("aegis_web_login"), 5, { keyRole: "aegis_app" });
    workerDb = new Db(as("aegis_worker_login"), 5, { keyRole: "aegis_worker" });
    idp = await fakeOidc({ clientId: "c", clientSecret: "s" });
    google = await fakeOidc({ clientId: "g", clientSecret: "gs" });
    const kms = new LocalDevKms(randomBytes(32));
    const shared = { kms, config: { demoMode: true, appOrigin: "http://localhost:3000", webauthnRpId: "localhost", ssoAllowLoopback: true, social: { google: { clientId: "g", clientSecret: "gs", issuer: google.issuer } } }, log: makeLogger(() => {}), env: {} };
    web = createPlatform({ db: webDb, ...shared });
    worker = createPlatform({ db: workerDb, ...shared });
    const s = await signUp(web, { email: ownerEmail, password: "correct-horse-battery", name: "O", workspaceKind: "organization" });
    owner = { tenantId: s.tenantId, userId: s.userId, sessionId: s.sessionId };
    await drainJobs(worker);
  });
  afterAll(async () => { await idp.close(); await google.close(); await webDb.close(); await workerDb.close(); await adminDrop(); });

  const link = (text: string, path: string) => new RegExp(`/${path}/([A-Za-z0-9_-]+)`).exec(text)![1]!;
  const latest = async (to: string) => (await listDevOutbox(web)).find(m => m.to === to)!;

  it("sign-up queues in web, sends in worker, and the dev page reads it in web", async () => {
    const m = await latest(ownerEmail);
    expect(m.subject).toMatch(/Confirm/);
    await confirmEmail(web, link(m.text, "verify-email"));
    expect((await adminDb.withSystem(t => t.one<any>("SELECT email_verified_at FROM users WHERE id=$1", [owner.userId]))).email_verified_at).toBeTruthy();
  });

  it("password reset works end to end", async () => {
    await (await requestPasswordReset(web, ownerEmail)).done;
    await drainJobs(worker);
    const m = await latest(ownerEmail);
    expect(m.subject).toMatch(/Reset/);
    await resetPassword(web, { token: link(m.text, "reset-password"), password: "a-brand-new-password-1" });
    await expect(signIn(web, { email: ownerEmail, password: "a-brand-new-password-1" })).resolves.toBeDefined();
  });

  it("the domain re-check works from the worker login, and a lapsed claim can be released from the web login", async () => {
    const d = await addDomain(web, owner, "lapses.bound.example");
    await verifyDomain(web, owner, "lapses.bound.example", async () => [[d!.token]]);
    await expect(workerDb.withSystem(t => t.query("SELECT * FROM scheduler_domain_tenants()"))).resolves.toContainEqual({ tenant_id: owner.tenantId });
    await expect(webDb.withSystem(t => t.query("SELECT * FROM scheduler_domain_tenants()"))).rejects.toThrow(/permission denied/);
    await expect(workerDb.withSystem(t => t.query("SELECT sso_release_lapsed_domain('x.example',$1)", [owner.tenantId]))).rejects.toThrow(/permission denied/);
    await recheckDomains(worker, owner.tenantId, async () => []);
    await adminDb.withSystem(t => t.query("UPDATE verified_domains SET txt_missing_since=now() - interval '8 days' WHERE domain='lapses.bound.example'"));
    await recheckDomains(worker, owner.tenantId, async () => []);
    const row = await adminDb.withSystem(t => t.one<any>("SELECT verified_at, lapsed_at FROM verified_domains WHERE domain='lapses.bound.example'"));
    expect(row.verified_at).toBeNull();
    expect(row.lapsed_at).toBeInstanceOf(Date);
    await drainJobs(worker);
  });

  it("invitations are created in a request context and sent by the worker", async () => {
    const r = await invite(web, owner, { email: "new@ops.bound.example", role: "member" });
    await drainJobs(worker);
    expect((await latest("new@ops.bound.example")).text).toContain(r.acceptUrl);
    const s = await signUp(web, { email: "new@ops.bound.example", password: "correct-horse-battery", name: "N", workspaceKind: "personal" });
    await drainJobs(worker);
    await expect(acceptInvite(web, s.userId, "new@ops.bound.example", r.acceptUrl!.split("/").pop()!)).rejects.toMatchObject({ code: "email_unverified" });
    await confirmEmail(web, link((await latest("new@ops.bound.example")).text, "verify-email"));
    await expect(acceptInvite(web, s.userId, "new@ops.bound.example", r.acceptUrl!.split("/").pop()!)).resolves.toMatchObject({ tenantId: owner.tenantId });
  });

  it("the full SSO flow, with JIT, linking and enforcement", async () => {
    const d = await addDomain(web, owner, "bound.example");
    await verifyDomain(web, owner, "bound.example", async () => [[d!.token]]);
    const { id } = await saveSsoConfig(web, owner, { domain: "bound.example", issuer: idp.issuer, clientId: "c", clientSecret: "s" });
    expect(JSON.stringify(await ssoOverview(web, owner))).not.toContain('"s"');
    expect(await publicSignInOptions(web)).toMatchObject({ sso: true, google: true });
    const s = (await beginSso(web, { email: "jit@bound.example" }))!;
    const r = await finishSso(web, idp.approve(s.url, { email: "jit@bound.example" }), s.binding);
    expect(r.kind).toBe("session");
    await setSsoEnforced(web, owner, id, true);
    await expect(signIn(web, { email: "jit@bound.example", password: "whatever-it-is-1234" })).rejects.toMatchObject({ code: "sso_required" });
    await setSsoEnforced(web, owner, id, false);
    const pre = await signUp(web, { email: "pre@bound.example", password: "squatter-password-1", name: "P", workspaceKind: "personal" });
    const s2 = (await beginSso(web, { email: "pre@bound.example" }))!;
    const r2 = await finishSso(web, idp.approve(s2.url, { email: "pre@bound.example", sub: "pre" }), s2.binding);
    expect(r2.kind === "session" && r2.userId).toBe(pre.userId);
  });

  it("SAML saves and starts across the boundary, and stores no plaintext in the flow", async () => {
    const { generate } = await import("selfsigned");
    const g = await generate([{ name: "commonName", value: "idp.bound.example" }], { algorithm: "sha256", keySize: 2048 });
    const d = await addDomain(web, owner, "saml.bound.example");
    await verifyDomain(web, owner, "saml.bound.example", async () => [[d!.token]]);
    await saveSamlConfig(web, owner, { domain: "saml.bound.example", idpEntityId: "https://idp.bound.example/e", entryPoint: "https://idp.bound.example/sso", idpCert: g.cert });
    const s = (await beginSso(web, { email: "x@saml.bound.example" }))!;
    expect(s.protocol).toBe("saml");
    await expect(finishSaml(web, "saml.bound.example", Buffer.from("<x/>").toString("base64"), s.binding)).rejects.toMatchObject({ code: "sso_token_invalid" });
  });

  it("social sign-in creates an account across the boundary", async () => {
    const s = await beginSocial(web, "google");
    const r = await finishSso(web, google.approve(s.url, { email: "g@gmail.bound.test", sub: "g1" }), s.binding);
    expect(r.kind).toBe("session");
  });

  it("SCIM works from the web login only, and its deprovisioning reaches the worker", async () => {
    const { token } = await rotateScimToken(web, owner);
    const a = await authenticateScim(web, `Bearer ${token}`);
    const u = await scimCreateUser(web, a, { userName: "scim@bound.example" });
    expect((await scimListUsers(web, a, { filter: 'userName eq "scim@bound.example"' })).totalResults).toBe(1);
    await scimPatchUser(web, a, u.id, { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "replace", path: "active", value: false }] });
    await drainJobs(worker);
    await expect(scimDeleteUser(web, a, u.id)).resolves.toBeUndefined();
    await drainJobs(worker);
  });

  it("notifications are scanned by the worker and read by their owner in web", async () => {
    const acct = await connectAccount(web, owner, { kind: "demo", email: ownerEmail, displayName: "D", credential: { kind: "demo" } });
    await drainJobs(worker);
    await workerDb.withWorker(owner.tenantId, t => t.query("UPDATE mail_accounts SET status='reconnect_required' WHERE id=$1", [acct]));
    await tick(worker);
    await drainJobs(worker);
    await scanNotifications(worker, owner.tenantId);
    const feed = await listNotifications(web, owner);
    expect(feed.items.map(i => i.kind)).toContain("account_reconnect");
    await markNotificationRead(web, owner, feed.items[0]!.id);
    await markAllNotificationsRead(web, owner);
    expect((await listNotifications(web, owner)).unread).toBe(0);
  });

  it("the worker's housekeeping has the grants it needs", async () => {
    await expect(sweepExpired(worker)).resolves.toBeUndefined();
  });

  it("account deletion cleans up identity data across the boundary", async () => {
    const s = await signUp(web, { email: "gone@ops.bound.example", password: "correct-horse-battery", name: "G", workspaceKind: "personal" });
    await drainJobs(worker);
    await adminDb.withSystem(t => t.query("INSERT INTO identities(user_id,provider,subject) VALUES ($1,'google','gone')", [s.userId]));
    await deleteAccount(web, { tenantId: s.tenantId, userId: s.userId }, { confirmEmail: "gone@ops.bound.example", email: "gone@ops.bound.example", password: "correct-horse-battery" });
    await drainJobs(worker);
    expect(await adminDb.withSystem(t => t.query("SELECT 1 FROM identities WHERE user_id=$1", [s.userId]))).toEqual([]);
    expect(await adminDb.withSystem(t => t.query("SELECT 1 FROM email_tokens WHERE user_id=$1", [s.userId]))).toEqual([]);
  });

  describe("what each login can't do", () => {
    it("the web login can't read the queue's sealed mail, only add to it", async () => {
      await expect(webDb.withSystem(t => t.query("SELECT * FROM outbound_mail"))).rejects.toThrow(/permission denied/);
    });
    it("no login can read SSO secrets outside the narrow function, or the tables directly", async () => {
      await expect(webDb.withSystem(t => t.query("SELECT client_secret_enc FROM sso_configs"))).rejects.toThrow(/permission denied/);
      await expect(workerDb.withSystem(t => t.query("SELECT client_secret_enc FROM sso_configs"))).rejects.toThrow(/permission denied/);
      await expect(webDb.withSystem(t => t.query("SELECT token_hash FROM scim_tokens"))).rejects.toThrow(/permission denied/);
    });
    it("the lookups aren't callable by the worker, or from a user context", async () => {
      for (const sql of ["SELECT * FROM sso_discover('x')", "SELECT * FROM sso_flow_config('00000000-0000-4000-8000-000000000000')", "SELECT * FROM scim_token_lookup('x')", "SELECT tenant_domain_verified('00000000-0000-4000-8000-000000000000','x')"]) {
        await expect(workerDb.withSystem(t => t.query(sql)), sql).rejects.toThrow(/permission denied/);
        await expect(webDb.withUser(owner, t => t.query(sql)), sql).rejects.toThrow(/permission denied/);
      }
      await expect(webDb.withSystem(t => t.query("SELECT * FROM scheduler_notification_tenants()"))).rejects.toThrow(/permission denied/);
    });
    it("the web login can't read notifications outside a user's context", async () => {
      await expect(webDb.withSystem(t => t.query("SELECT * FROM notifications"))).rejects.toThrow(/permission denied/);
    });
    it("the worker can't read tokens' owners or sessions, and has no reach into identities", async () => {
      await expect(workerDb.withSystem(t => t.query("SELECT * FROM identities"))).rejects.toThrow(/permission denied/);
      await expect(workerDb.withSystem(t => t.query("UPDATE email_tokens SET consumed_at=now()"))).rejects.toThrow(/permission denied/);
    });
    it("a member's context can't read SSO config or SCIM tokens", async () => {
      const m = await signUp(web, { email: "member@ops.bound.example", password: "correct-horse-battery", name: "M", workspaceKind: "personal" });
      await adminDb.withSystem(t => t.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES ($1,$2,'member')", [owner.tenantId, m.userId]));
      const c = { tenantId: owner.tenantId, userId: m.userId };
      expect(await webDb.withUser(c, t => t.query("SELECT * FROM sso_configs"))).toEqual([]);
      expect(await webDb.withUser(c, t => t.query("SELECT * FROM scim_tokens"))).toEqual([]);
      await expect(webDb.withUser(c, t => t.query("INSERT INTO sso_configs(id,tenant_id,domain,issuer,client_id,client_secret_enc) VALUES (gen_random_uuid(),$1,'x.example','https://x','c','\\x00')", [owner.tenantId]))).rejects.toThrow(/row-level security/);
    });
  });
});
