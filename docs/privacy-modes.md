# Privacy modes and claims matrix

**The conflict stated plainly:** a cloud service that fetches mail with OAuth or IMAP credentials and runs server-side analysis can technically access plaintext while processing. Encrypting the database doesn't change that. An operator with unrestricted deploy rights could ship code that captures plaintext. So no conventional managed deployment can truthfully say the operator is cryptographically incapable of reading mail.

| Claim | Mode A: managed (shipped) | Mode B: client-sealed (experimental) | Mode C: attested (not built) |
|---|---|---|---|
| TLS in transit | Yes | Yes | Yes |
| Encrypted at rest with per-tenant keys | Yes | Yes | Yes |
| No admin UI, API or DB role gives tenant admins mail content | **Yes, enforced by RLS and tests** | Yes | Yes |
| Plaintext absent from logs, jobs, telemetry | **Yes, tested** | Yes | Yes |
| Staff have no routine access | Policy + IAM; **deployment-dependent** | Same | Same |
| Server cannot decrypt cached bodies | **No** | **Yes for sealed bodies.** Subject, participants and the security result stay server-readable | Only inside measured workload |
| Operator cannot retrieve mail at all | **No** | **No**: server-held provider tokens can re-fetch from the provider unless disconnected | **No** unless key-release policy is independent of the operator |
| 24/7 proactive scanning | Yes | Before sealing only; sealed bodies aren't re-analysed | Yes, if scanners run inside the boundary |
| Server-side search | Yes, plaintext tsvector, disclosed | **Local only** in that browser | Inside boundary |
| Semantic search | **Off unless the deployment sets `AEGIS_EMBEDDINGS=local`.** A model on the server reads subject and opening text; vectors are sealed at rest and opened in memory per query | **Never for sealed bodies.** A `client_sealed` workspace is never indexed | Not built |
| Hosted LLM sees content | Only if the user enables it | Only by explicit per-message action | Disclosed if outside boundary |
| Marketing language allowed | "Content-blind administration with controlled server-side processing" | "Client-sealed cache, experimental" | None until reviewed |

**Always true:** Gmail, Outlook, iCloud and other origin providers keep their own access to the mail according to their architecture. End-to-end encryption of the mail itself depends on sender and recipient protocols and can't be retrofitted to ordinary SMTP mail.

## Mode A detail
TLS everywhere; envelope encryption with AES-256-GCM per record, tenant KEKs per key class, wrapped by the KMS root. Plaintext exists transiently in worker and API memory. The product has no staff or tenant-admin path to content: no view-email control, debug endpoint, impersonation mode, hidden export or raw prompt log. Tests in `packages/platform/src/__tests__/admin-cannot-read.test.ts`.

**What's not prevented:** a privileged operator who can change code or read process memory. Mitigations are organizational (separation of duties, signed builds, audited deploys) and must be evidenced by the deploying organization.

## Semantic search
Off by default. A deployment turns it on, and each mailbox owner can then turn it off. What happens when it's on:

- **What the model reads:** the subject and the first 1,500 characters or so of the body, without quoted reply lines, in the worker when a message arrives, and the words of a query in the web process. It runs on the server's CPU through `@huggingface/transformers` and ONNX Runtime. Attachments aren't read.
- **What leaves the server:** no mail text and no query. Every remote read in that library goes through one function (`env.fetch`, used by `getFile` in its `utils/hub.js`), and `embedding-thread.ts` replaces it: it allows only requests for this model's own files, while loading, and refuses everything afterwards. With `AEGIS_EMBEDDINGS_MODEL_DIR` set it refuses everything from the start. ONNX Runtime has its own telemetry, separate from that function, which goes to `mobile.events.data.microsoft.com` unless `ORT_DISABLE_TELEMETRY` is in the process's real environment when it loads. The library sets that variable, but on a worker thread `process.env` is a copy native code can't see, so it had no effect there, and the telemetry did run and did reach Microsoft during development. `LocalEmbeddingProvider` now sets it on the main thread before starting its own thread, refuses to run anywhere else, and `semantic-search.real.test.ts` samples the process's threads on macOS to check that this SDK never starts. That check hasn't been run on Linux or Windows. An ONNX Runtime upgrade should re-run it, and production should also restrict egress at the network layer. Without a model directory, a process asks huggingface.co for the model's files when it first loads them and one small config file each time it starts. Those requests say which model and library version this is, and nothing about any mail. `semantic-search.real.test.ts` checks this against real runs, including one with no model on disk.
- **What's stored:** one vector per message in `message_embeddings`, sealed like a message body: its own data key, AES-256-GCM, AAD bound to the tenant, table and message. A vector can be partly reversed into the text it came from, so there's no plaintext copy and no pgvector. The model name is the only other readable column.
- **What the server can do:** decrypt vectors, because it has to. A search opens up to 5,000 of them in memory. This isn't zero-knowledge. It is better than the word index, whose lexemes are readable from a raw database dump.
- **Who can match:** whoever can open the mailbox, by the same RLS as everything else. Colleagues and tenant admins get no rows, and revoking a grant stops matches at once. Only the worker writes vectors. Only the owner can erase them.
- **Limits:** only the newest 5,000 indexed messages a person can see are compared per search, so older mail can only be found by words. Later parts of a long message aren't covered. It finds things close in meaning, which isn't the same as right, so results are labelled, and word matches are still there. Held mail stays out unless `is:flagged` or `risk:` is used, as with word search.

Turning off server search or semantic search deletes that owner's vectors immediately. Turning either back on rebuilds vectors from the stored body in the background, which word search can't do. Sealing a message erases its vector, and nothing will recreate it.

## Mode B detail
The browser derives a key from a user passphrase (PBKDF2-SHA256, 600k iterations; WebCrypto has no Argon2), seals a chosen message body with AES-GCM, and uploads ciphertext; the server erases its copy, search words, its semantic search vector, stored attachments, tasks and AI summaries for that message. Sealing is per message, and it discards the HTML version. Key loss means permanent loss of the sealed cache, though the original provider keeps the mail. There's no recovery key. Known weakness: the server still holds provider tokens and serves the JavaScript that handles the passphrase; a malicious deploy could capture it. So this defends against database and backup exposure, not a malicious operator.

A backup from before a seal still holds the server's readable copy, until it expires. Restoring that backup and re-applying the deletion log erases that copy again, but the ciphertext was never in that backup, so the message comes back with no body on the server. The original provider keeps the mail.

## Mode C detail
Requires confidential VMs, measured boot, an independent attestation verifier and a key-release policy that the operator can't rewrite unilaterally. See ADR-0007 in `docs/adr/README.md`. A TEE doesn't defend against an operator who controls both measurement policy and key release.

## Deletion semantics
What each mode's erasures mean for a restore, and which are logged, is in `docs/runbooks/backup-restore.md`. The log holds ids, a kind and a time, and no content. Opting out of search is logged too: a restore turns it off again and erases what came back, and someone who'd since turned it on has to do so again.

| Item | On disconnect + delete | On account deletion |
|---|---|---|
| Provider grant | Revoked where the provider supports it; otherwise instructions shown | Same |
| Credential envelope | Deleted immediately | Deleted |
| Bodies, envelopes, tsvector, embedding vectors, tasks, drafts, analyses | Deleted immediately | Deleted; tenant KEKs destroyed for personal workspace (crypto-shred) |
| Audit events | Retained per policy, contain no content | Retained with user ID pseudonymized |
| Aggregated telemetry | Retained; contains no message identity | Same |
| Backups | Expire per schedule (deployment-defined). Crypto-shredding removes the wrapped keys from the live database only. A backup taken earlier holds its own copy, and the root key still unwraps it, so its data stays recoverable until it expires. `restore-drill.test.ts` proves this | Same |
| Restoring a backup | Re-applied from the deletion log before the restored database is opened: `pnpm restore:reapply`. The backup file itself isn't changed, and stays readable until it expires. See `docs/runbooks/backup-restore.md` | Same, and the restored wrapped keys of a personal workspace are destroyed |
