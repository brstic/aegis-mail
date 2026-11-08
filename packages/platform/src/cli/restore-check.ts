import { Db } from "@aegis/db";
import { createPlatform, getThread, kmsFromEnv, listThreads } from "../index";

/**
 * After a restore: reads a known user's mail through the real platform code on the web login, so roles, grants, row level security and
 * the key chain are all exercised. Prints counts only. Usage: restore-check.ts <email>
 */
const email = process.argv[2];
if (!email) { console.error("usage: restore-check.ts <email>"); process.exit(1); }
const admin = new Db(process.env.DATABASE_URL!);
const u = await admin.withSystem(t => t.one<{ id: string; tenant_id: string }>("SELECT u.id, m.tenant_id FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.email=$1 LIMIT 1", [email]));
await admin.close();
if (!u) { console.error("That user isn't in this database."); process.exit(1); }
const p = createPlatform({ processRole: "web", kms: await kmsFromEnv() });
const ctx = { tenantId: u.tenant_id, userId: u.id };
const { items } = await listThreads(p, ctx, { view: "inbox", limit: 5 });
if (!items.length) { console.error("No mail visible to that user."); process.exit(1); }
const row = items[0] as unknown as { threadId?: string; thread_id?: string; id: string };
const thread = await getThread(p, ctx, row.threadId ?? row.thread_id ?? row.id);
const chars = thread.messages[0]?.text?.length ?? 0;
if (!chars) { console.error("A message opened with no readable body."); process.exit(1); }
console.log(`read-ok threads=${items.length} messages=${thread.messages.length} bodyChars=${chars}`);
process.exit(0);
