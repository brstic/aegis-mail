# Acceptance matrix

Each user story and acceptance criterion from the original product brief, and what proves it. "Fake" means the provider side is a protocol fake we wrote from the docs; nothing here has run against a live provider account.

## User stories
| # | Story | Status | Proof |
|---|---|---|---|
| 1 | Two Gmail + one iCloud, separate colored lists, unified Focus, origin always clear | **Works in demo** (three simulated accounts). Real accounts blocked on credentials | `mail.spec.ts`; account chip on every row; `sync-send.test.ts` identity tests |
| 2 | Forged supplier invoice highlighted and quarantined before clicking in the app | **Works** | `engine.test.ts`, `stories.test.ts`, `mail.spec.ts` |
| 3 | Report as legitimate, inspect, release, restore provider location | **Works** (demo and Gmail fake) | `stories.test.ts`, `gmail-slice.test.ts`, `mail.spec.ts` |
| 4 | Manager sees trends, can't open a member's content | **Works**, enforced at the database | `admin-cannot-read.test.ts`, `process-boundary.test.ts`, `mail.spec.ts` |
| 5 | Client request above newsletters, explanation, correction | **Works** | `stories.test.ts`, `mail.spec.ts`, `docs/eval-priority.md` |
| 6 | Assistant draft stays editable; nothing sends without approval | **Works** | `stories.test.ts`, `mail.spec.ts` |
| 7 | Read mode, vendor policy, key custody; disable hosted model | **Works** | `admin-cannot-read.test.ts` (Privacy Center), `wiring.test.ts`, `/app/privacy` |
| 8 | IT admin sets up gateway, verifies pre-delivery quarantine | **Dropped.** Gateway mode was removed from the product on 2026-11-07: it only connects to existing mail services. Quarantine happens after the provider receives a message | None |
| 9 | Revoke grant: sync stops, reconnect shown, documented deletion | **Works** with fakes | `sync-send.test.ts`, `gmail-slice.test.ts`, `at-rest.test.ts` |
| 10 | Injection in a PDF: AI doesn't obey or act | **Works.** Text-based PDFs are also flagged; compressed streams aren't decoded, but attachment content never reaches a model | `wiring.test.ts`, `prompt-injection.test.ts` |
| 11 | Rotate a mail-app password; updated securely, not logged or readable | **Works** via reconnect | `at-rest.test.ts`, `app.replace_credential`, `process-boundary.test.ts` |
| 12 | Matrix of privacy claims per mode | **Works** | `docs/privacy-modes.md`, `/privacy-architecture`, `/app/privacy` |

## Quality gates
| Gate | Status | Proof |
|---|---|---|
| Each adapter has contract tests and live smoke-test docs | Done; live run outstanding | `packages/mail-adapters/src/*.test.ts`, `docs/runbooks/live-provider-smoke-test.md` |
| Replay notification three times: no duplicates, no triple sends | Done | `sync-send.test.ts`, `gmail-slice.test.ts` |
| Send succeeds, API times out: no duplicate on retry | Done | `sync-send.test.ts` (timeout, crash after delivery) |
| Missing or deleted provider message: no indefinite resurrection | Done | `sync-send.test.ts`, `at-rest.test.ts` |
| Wrong mailbox: can't send from another identity than displayed | Done | `sync-send.test.ts` |
| Malicious HTML/JS: no execution, no secret extraction | Done | `parser.test.ts`, `mail.spec.ts` (real browser, sandbox, no external requests) |
| Decompression bomb: bounded memory and CPU | Done for ZIP: central directory is read, never inflated. Other formats reported as uninspectable | `engine.test.ts` |
| Cross-tenant or IDOR: hard deny, non-sensitive audit record | Deny done. `access.denied` audit is written for identity mismatches and blocked drafts, not for every 404 | `tenant-isolation.test.ts` |
| Quarantine false positive: recovery and provider state sync | Done | `stories.test.ts`, `gmail-slice.test.ts` |
| OAuth revoked: stop, notify, no repeated silent failures | Done | `sync-send.test.ts`, `gmail-slice.test.ts` |
| Offline/reload: preserve drafts, no silent mis-send | Done: send disabled offline, draft kept on device | `mail.spec.ts` |
| Prompt injection can't send/forward/delete | Done, including a model that fully obeys | `prompt-injection.test.ts` |
| Client-key mode: operator API can't decrypt; compromised deploy documented | Done as experimental: sealed bodies are unreadable server-side. A malicious deploy could capture the passphrase, and this is stated | `at-rest.test.ts`, `docs/privacy-modes.md` |
| Tenant admin can't fetch content via UI, API, DB or management endpoint | Done | `admin-cannot-read.test.ts` |
| Disconnect and delete: grants revoked if possible, retention as documented | Done | `at-rest.test.ts`, `gmail-slice.test.ts`, `process-boundary.test.ts` |

## Performance targets
`docs/bench.md` holds local numbers. Long lists are paginated rather than virtualized. No load test, no production SLOs yet: they need a real deployment.
