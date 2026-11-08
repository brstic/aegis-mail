# Roadmap

Current state of each item: [`STATUS.md`](STATUS.md). The phases below are the order the project was built in, kept for history; the open items at the end are what's next.

| Phase | Scope | Exit gate |
|---|---|---|
| 0 | Integration matrix, threat model, ADRs, privacy modes | Docs reviewed against code |
| 1 | Design system, product site, all major screens over demo state | Every visible control works or says why it's unavailable |
| 2 | Real Gmail slice: login, OAuth, sync, render, labels, draft, send, disconnect | Mock-server E2E green; **live test with Testing-status app** |
| 3 | Security engine, reversible quarantine, eval corpus | Eval published; Gmail quarantine semantics proven live |
| 4 | Focus, summaries, tasks, assistant, drafts, injection tests | Injection corpus green with hosted model on |
| 5 | Graph, IMAP/SMTP, iCloud, POP3 import | Per-provider regression suite; live smoke test per provider |
| 6 | Org controls, audit, retention, monitoring, onboarding | Tenant-isolation suite green |
| 7 | Attested processing (design only, `docs/mode-c-design.md`), user-held keys | Separate design reviews |

| 8 | Open source release: AGPL-3.0, billing removed, self-hosting stack and guide | `compose.yaml` started from empty and its result recorded in STATUS |

## Next actions (each needs a person with an external account)
1. Start the self-hosting stack from empty with a generated root key (and once with a real AWS KMS key), and record the result.
2. Create a Google Cloud project in **Testing** status; add test users; run `docs/runbooks/live-provider-smoke-test.md`.
3. Register an Entra app; repeat for Microsoft.
4. Create an AWS KMS key, run `AwsKmsProvider` against it (only tested against a local server so far), then remove the dev key from every environment.
5. Stand up clamd; set `CLAMD_HOST`.
6. Acquire a consented or licensed phishing corpus; rerun eval; retune weights.
7. An external pen test and cryptographic review.
8. Settle the name.
