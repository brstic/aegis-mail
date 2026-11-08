# Architecture decision records

| # | Decision | Status |
|---|---|---|
| 0001 | Modular monolith + one worker; split only on a trust or scaling boundary | Accepted |
| 0002 | PostgreSQL with enforced RLS through dedicated non-login roles | Accepted |
| 0003 | Postgres-backed job queue, not Redis | Accepted |
| 0004 | Envelope encryption with a KMS interface; content encrypted including subject and participants | Accepted |
| 0005 | Provider webhooks are untrusted sync hints | Accepted |
| 0006 | Demo mode is the real pipeline over a synthetic adapter | Accepted |
| 0007 | SMTP gateway built as a separately labelled experimental mode; confidential computing still deferred | Gateway part superseded 2026-11-07 |
| 0008 | Detection is layered and explainable; LLM optional, untrusted, advisory only | Accepted |
| 0009 | Default AI is local heuristic; hosted LLM requires config and user consent | Accepted |
| 0010 | TypeScript pinned to 5.9 | Accepted |
| 0011 | Separate database logins per process | Accepted |

---

## 0001 — Modular monolith + one worker
**Context:** the prompt suggests five apps but warns to prove added complexity. **Decision:** `apps/web` hosts UI and `/api/v1`; `apps/worker` runs all background jobs. They are split because only the worker may read credentials. **Consequence:** connector, security and AI workloads share a process; separate egress policies per workload aren't possible until they split. Job handlers are already isolated by kind, so the split is mechanical.

## 0002 — RLS with dedicated roles
**Decision:** every mail table carries `tenant_id` and policies evaluated against `app.user_id` / `app.tenant_id`, entered with `SET LOCAL ROLE`. `FORCE ROW LEVEL SECURITY` is on. Application authorization still runs first. **Why:** "admin can't read" has to survive an application bug. **Consequence:** the connection user must be able to `SET ROLE`; `withSystem` is a reviewed exception restricted to pre-auth tables.

## 0003 — Postgres queue
**Decision:** `jobs` table with `SKIP LOCKED`. **Why:** enqueueing inside the same transaction as the state change eliminates a class of lost-event bugs, and one fewer data store holds identifiers. **Trade-off:** lower peak throughput than Redis; revisit past roughly 1k jobs/s. Redis is installed on the build machine but deliberately unused.

## 0004 — Envelope encryption
**Decision:** root (KMS) → tenant KEK per key class (`body`, `credential`, `index`, `metadata`) → per-record DEK; AES-256-GCM from Node's OpenSSL binding, random 96-bit nonces under fresh per-record DEKs, AAD binding tenant, class, table and record ID. Subject, participants and snippets are encrypted as well as bodies. Sender lookups use HMAC blind indexes. **Consequence:** server-side SQL can't filter on `from:` by substring, so search uses tsvector + blind index for exact match. `LocalDevKms` is refused in production boot. A real KMS provider must be implemented against the interface; none has been built, as no cloud account was available.

## 0005 — Webhooks are hints
**Decision:** Gmail Pub/Sub and Graph notifications only enqueue a sync; content always comes from an authenticated API fetch. Pub/Sub OIDC JWTs are verified; Graph `clientState` is compared in constant time. A forged notification can at worst cause a redundant sync, which is rate-limited by dedupe keys.

## 0006 — Demo mode is the real pipeline
**Decision:** `DemoAdapter` implements `MailAdapter` over synthetic RFC 5322 messages stored in the database. Parser, detectors, policy, priority, encryption and RLS are the real code. Demo accounts are visibly labelled and `kind=demo` can't be created when `DEMO_MODE=false`. **Why:** a parallel mock UI would be a deceptive placeholder and would rot.

## 0007 — Gateway experimental; confidential computing deferred
**Superseded: gateway mode dropped 2026-11-07.** The product only connects to existing mail services, and the gateway code was removed. Its tables and roles from migrations 006 and 013 remain in the schema, unused. The text below is kept as history; the Mode C part still stands.

**Originally:** no SMTP gateway ships, because the prompt rules out a thin script and it needs real domains and infrastructure to test. **Amended 2026-11-06:** a real gateway now exists as a separately labelled **experimental** mode: its own process and database login, durable encrypted spool, verdict before delivery, hold and release, signed loop protection, per-domain fail mode, retries, bounces, health, and setup that only reports protection active after routing validates and a message round-trips. **What hasn't changed:** it has only run on one machine over localhost. No real MX, public internet or third-party MTA has touched it, so it stays labelled experimental everywhere, and connector mode remains the product. **Consequences:** it's a new process that holds plaintext in memory, sits in the path of customers' mail if deployed, and adds a public listener to defend. It holds no mailbox credentials and has no grant on mail tables; the web and worker processes have none on its spool. Mode C still needs TEE hardware and an independent verifier, so it stays "not available" in the UI with no fake toggles.

## 0008 — Layered explainable detection
**Decision:** deterministic detectors emit weighted evidence with reason codes; evidence is combined in log-odds; a deterministic policy maps outputs to actions. The LLM can add evidence but can't lower risk or choose an action. **Limit:** weights are hand-set and tuned on a synthetic corpus, so "calibrated" means *measured on that corpus*; field calibration needs real data.

## 0009 — Local heuristic AI by default
**Decision:** default provider is deterministic and offline, with extractive summaries, rules-based task extraction and template drafts, labelled "On-device rules" in UI. Hosted LLM runs only when `ANTHROPIC_API_KEY` is set **and** the user has opted in. **Why:** the product must work and be honest with no content leaving the boundary. **Cost:** heuristic output is visibly less capable than a model.

## 0010 — TypeScript 5.9
TypeScript 7 (native) is current, but Next.js type-checking relies on the compiler API. Pinned to 5.9 for toolchain compatibility; revisit when Next supports 7.

## 0011 — Separate database logins per process
**Context:** the first design used `SET LOCAL ROLE` from one connection. A test showed `SET LOCAL ROLE aegis_worker` succeeded inside a request context, because role membership is checked against the login, which was a superuser. The claim "only the worker can read credentials" was false. **Decision:** web and worker log in as different roles, members of `aegis_web_conn` and `aegis_worker_conn`, which can `SET ROLE` only to their own context (`WITH INHERIT FALSE, SET TRUE`, PostgreSQL 16+). Connection roles get explicit grants on pre-auth tables or the queue, nothing on mail. Production refuses to start without per-process URLs. **Consequence:** provider revocation moved to a worker job, since web can't read credentials; disconnect is asynchronous. Most test suites still use an owner connection for convenience; `process-boundary.test.ts` proves the boundary and that the product works inside it.
