import { z } from "zod";
import { audit } from "./audit";
import { badRequest, type Ctx, notFound, type Platform } from "./context";
import { recordErasure } from "./deletion-log";
import { eraseSealedPlaintext } from "./erasure";
import { requireOwner } from "./send";

/**
 * Mode B, experimental. The browser encrypts a message body with a key it derived locally and uploads ciphertext, then the
 * server erases its own copy of that body and its search words. The server stores what it can't open.
 * Not zero-access: see docs/privacy-modes.md. The server still holds provider tokens and serves the page's JavaScript.
 */
export const SealBody = z.object({
  ciphertext: z.string().max(70_000_000),
  meta: z.object({ alg: z.literal("AES-GCM"), kdf: z.literal("PBKDF2-SHA256"), iterations: z.number().int().min(600_000), salt: z.string().max(64), iv: z.string().max(64), v: z.literal(1) }),
});

export async function sealMessage(p: Platform, ctx: Ctx, messageId: string, input: z.infer<typeof SealBody>) {
  const bytes = Buffer.from(input.ciphertext, "base64");
  if (bytes.length < 28) throw badRequest("seal_invalid", "That doesn't look like encrypted data.");
  await p.db.withUser(ctx, async t => {
    const m = await t.one<{ account_id: string; thread_id: string | null }>("SELECT account_id, thread_id FROM messages WHERE id=$1", [messageId]);
    if (!m) throw notFound();
    await requireOwner(t, m.account_id);
    // Sealing twice would destroy the only copy of what the first seal protected.
    const r = await t.query("UPDATE message_contents SET sealed_blob=$2, sealed_meta=$3 WHERE message_id=$1 AND sealed_blob IS NULL RETURNING message_id", [messageId, bytes, JSON.stringify(input.meta)]);
    if (!r.length) throw badRequest("already_sealed", "This message is already sealed.");
    await eraseSealedPlaintext(t, messageId, m.thread_id);
    await audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: "data.deleted", targetType: "message", targetId: messageId, meta: { kind: "sealed" } });
    await recordErasure(t, { kind: "message_sealed", tenantId: ctx.tenantId, accountId: m.account_id, messageId });
  });
}
