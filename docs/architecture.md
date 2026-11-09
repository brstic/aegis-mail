# Architecture

Companion documents: [ADRs](adr/), [threat model](threat-model/README.md), [privacy modes](privacy-modes.md), [status](STATUS.md).

## Trust boundaries and processes

```
 Browser ─ session cookie ─▶ apps/web (Next.js: UI + /api/v1)         role: aegis_app
   │  sandboxed iframe                │  user-scoped RLS context      (no credential read)
   │  (sanitized HTML, no scripts)    ▼
   │                            PostgreSQL ◀── apps/worker            role: aegis_worker
   │                                │          jobs: sync, process,   (tenant-scoped, reads
   │                                │          send, renew, retention  credential envelopes)
   │                                ▼                │
   │                       ciphertext + metadata     ├─▶ Mail providers (Gmail, Graph, IMAP/SMTP)
   │                                                 ├─▶ clamd (optional)
   │                                                 └─▶ Hosted LLM (OFF unless configured AND user-enabled)
   Root of trust (LocalDevKms in dev; operator root key or AWS KMS in production)
```

The API and worker are separate processes on different sides of a trust boundary, each with its own database login (migration 003, ADR-0011). The web login can only become `aegis_app`; the worker login can only become `aegis_worker`; neither can read mail tables outside those contexts. **Only the worker can read credential envelopes**: the web process replaces them through a definer function and can't read them back. `process-boundary.test.ts` runs the whole product under these logins. Note that the web process can still reach the KMS, because it needs body keys, so the boundary protects against a request-path bug reading credentials, not against full compromise of that process. Worker sub-splits are deferred until workload or egress controls justify them (ADR-0001).

## Packages
| Package | Responsibility | Depends on |
|---|---|---|
| `domain` | Types, zod API contracts, event vocabulary, capability flags, brand constant | zod |
| `cryptography` | AEAD envelope encryption, KMS interface, blind index, crypto-shredding | node:crypto |
| `mail-parser` | Bounded MIME parse, HTML sanitization, URL extraction | mailparser, sanitize-html |
| `mail-adapters` | `MailAdapter` interface and Gmail, Graph, IMAP/SMTP, POP3, Demo adapters; SSRF guard; discovery | imapflow, nodemailer, oauth4webapi |
| `security-engine` | Detectors, evidence combination, policy engine, malware interface, eval harness | mail-parser |
| `ai-core` | Inference abstraction, the local heuristic provider, hosted providers (OpenAI, and Anthropic as the alternative) behind one set of prompts, injection defenses, draft checks | domain |
| `db` | SQL migrations, RLS contexts | pg |
| `platform` | Services: auth, ingestion, jobs, focus, send, quarantine, automations, org, privacy, operators | all above |
| `test-fixtures` | Synthetic MIME corpus with labels | — |

## Data classification
| Class | Examples | Stored as | Who can read |
|---|---|---|---|
| C4 secrets | OAuth refresh tokens, IMAP passwords | Envelope under `credential` key class | Worker role only |
| C3 content | Bodies, subject, participants, snippets, AI summaries, drafts | Envelope under `body` key class | Mailbox owner (via app), worker during processing |
| C3 index | FTS tsvector (lexemes of subject/body) | Plaintext tsvector, **disclosed** | Mailbox owner under RLS. Readable from a raw DB dump. Per-user opt-out |
| C3 vectors | Sentence embeddings of subject and opening text, when `AEGIS_EMBEDDINGS=local` | Envelope under `body` key class, AAD bound to the message. No plaintext vector, no pgvector | Mailbox owner and grantees (via app), worker. Per-user opt-out |
| C2 linkable | Sender hash, thread links, labels, timestamps, flags | HMAC or plaintext under RLS | Mailbox owner |
| C1 telemetry | Reason codes, counts, risk label, day bucket | Plaintext, aggregated, no identity of sender/subject | Security admin of tenant |

## Message lifecycle
`message.discovered → message.normalized → message.security_scanned → message.classified → focus.updated` with `message.quarantined` / `message.released` branches. **Security always runs before priority**; priority cannot override a threat policy (`stories.test.ts`).

## Database access contexts (`packages/db/src/index.ts`)
- `withUser({tenantId,userId}, fn)` — `SET LOCAL ROLE aegis_app`; RLS allows only mailboxes the user owns or was explicitly granted. Tenant admins get **no** additional rows on mail tables.
- `withWorker(tenantId, fn)` — `SET LOCAL ROLE aegis_worker`; constrained to one tenant.
- `withKeys(tenantId, fn)` — tenant key rows only, in whichever context this process holds.
- `withSystem(fn)` — the connection role itself: pre-auth tables for web, the job queue for worker. Grants make mail tables unreachable from it, and a static test in `tenant-isolation.test.ts` forbids them too.

## Semantic search
Off unless `AEGIS_EMBEDDINGS=local`. `EmbeddingProvider` (`packages/platform/src/embeddings.ts`) has one real implementation, a quantized `Xenova/all-MiniLM-L6-v2` at a pinned revision, 384 dimensions, on a one-thread `IsolatedPool` in each of web and worker. The library is only ever imported on that thread (`embedding-thread.ts`), which is started by path, so it stays out of the Next bundle.

**Writing.** `processMessage` queues `embed.message` in its own transaction, only where word search is on. The payload is `accountId` and `messageId`. The job reads the body itself, embeds outside any transaction, seals, and writes after re-checking under locks that the message can still be indexed and the owner hasn't opted out in the meantime. Ingest doesn't wait for it, so a stuck model costs a killed thread and a retry. `embed.backfill` walks a mailbox a page at a time, from the scheduler at most hourly and when someone turns the feature back on, and picks up whatever has no vector for the current model.

**Reading.** Postgres can't rank what it can't read. `listThreads` with `semantic: true` runs the word search as usual, embeds the query with an 8 second limit, then selects sealed vectors in the user's RLS context under the same conditions as word search: at most `SEMANTIC_CANDIDATE_LIMIT` (5,000), newest first. It opens them with `Envelope.openMany`, ranks by cosine, drops anything under `SEMANTIC_MIN_SIMILARITY` (0.25), keeps the best message per thread up to `SEMANTIC_TOP_K` (20), and merges with the word results by reciprocal rank fusion. Later pages are words only. If the model fails or isn't ready, word results still come back, and `semantic.status` says what happened. Measured cost: `docs/bench.md`.

## Job system
Postgres-backed queue with `FOR UPDATE SKIP LOCKED`: at-least-once, dedupe keys, exponential backoff with jitter, dead-letter state, trace IDs, cancellation, delayed scheduling (ADR-0003). Payloads contain IDs only, never content (test).

## Send path
`POST /drafts/:id/send` validates identity against displayed account → records `send_approvals` → enqueues `send.execute` with durable idempotency key → adapter send → on timeout, state `unknown`, reconcile by Message-ID lookup before any retry. AI cannot reach this path (test).

## Rendering
Server sanitizes with allowlist, removes remote content by default, rewrites links to a click-through interstitial. Client renders in `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc>` with a restrictive CSP meta tag, so links can only open the click-through interstitial in a new tab. No `allow-scripts`, no `allow-same-origin`.

## Deployment
Self-hosting with Docker Compose: [`docs/self-hosting.md`](self-hosting.md) and `compose.yaml`. Other platforms: [`docs/runbooks/deploy.md`](runbooks/deploy.md), and `infra/terraform/reference` for AWS. What has been run, and what hasn't, is in STATUS.md.
