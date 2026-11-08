# Status: what exists, honestly

Last updated 2026-11-08. If this file and any other document disagree, this one wins, and the other is a bug.

**2026-11-08: open source.** The project is published under the AGPL-3.0 for people to run themselves, and billing, plans and Stripe were removed. The test counts below are from 2026-11-07, before that removal, and haven't been re-run since. A self-hosting stack was added (`compose.yaml`, `docs/self-hosting.md`): its configuration passes `docker compose config`, and it hasn't been run.

**Summary.** A working product you can run locally today against synthetic mail, with all the real code paths. It has never connected to a real mailbox, because that needs accounts and credentials that weren't available. Before it holds real mail, its AWS KMS provider needs a run against a real key, and no external review has happened.

## Test results
Run on 2026-11-07 on one Mac with local PostgreSQL 17, on the final code:
| Suite | Result | Command |
|---|---|---|
| Unit, integration, contract, security, including semantic search against the real model | **1684 passed, 103 skipped** in 60 files, re-run after gateway mode was dropped (it was 1881 passed with the gateway suites) | `pnpm test` |
| Browser against a production build, with the real worker | **185 passed, 1 skipped**, before gateway mode was dropped: that run included the 5 tests of the deleted `gateway.spec.ts`, and it hasn't been re-run since. Covers flows, hostile HTML, real passkey ceremony via virtual authenticator, axe on every screen, mobile, visual baselines, another time zone and locale | `pnpm test:e2e` |
| Typecheck | Clean across all packages | `pnpm typecheck` |
| Detection evaluation | `docs/eval-report.md`. Read the `holdout_test` line | `pnpm eval` |
| Priority evaluation | 15/15 on a small synthetic set, `docs/eval-priority.md` | `pnpm eval:priority` |
| Performance | `docs/bench.md`, one laptop | `pnpm bench` |

Skipped tests are the live-server suites below, which need their environment variables, and one browser test that needs semantic search switched on. `e2e/semantic-forward.spec.ts` was run separately with it on.

## Live local tests
Real software, on one Mac, on 2026-11-07. They're skipped unless their environment variables are set, so `pnpm test` doesn't run them, and neither does CI. Start the servers with `infra/local/live-servers.sh`, which prints the variables.
| Suite | Real software | Result |
|---|---|---|
| `clamd.live.test.ts` | clamd 1.5.4 with real freshclam signatures | **10 passed** |
| `imap.live.test.ts` | Dovecot 2.4.1 on Linux | **44 passed** |
| `pop3.live.test.ts` | Dovecot 2.4.1 on Linux | **15 passed** |
| `smtp.live.test.ts` | Postfix 3.10, with SASL by Dovecot, delivering by LMTP into a real mailbox | **13 passed** |
| `dovecot.live.test.ts` | All of the above with real Postgres, through `connectAccount` and `syncAccount` | **15 passed** |

These are test servers configured by us, so they say little about what Gmail, iCloud or Yahoo do. No test here touches a live provider, a real KMS, or a hosted model.

Other things run for real, once, on that date:
- **Docker:** `infra/docker` built on arm64 under Colima, and `compose.yml` ran from an empty database to health 200, migrations, seed, demo sign-in as the web login, and simulated mail reaching Focus through the worker. amd64 wasn't built.
- **CI:** `.github/workflows/ci.yml` ran under `act` on a clean copy of the working tree, on Node 24 and Postgres 17 in Linux containers on arm64. **`test` passes** (frozen install, typecheck, 1880 passed and 104 skipped, `eval`, web build) and **`e2e` passes** (185 passed, 1 skipped). `supply-chain`: audit and gitleaks pass; the SBOM action's upload fails against `act`'s artifact server, so that step is unproven. Never run on GitHub's hosted runners.
- **Secrets and dependencies:** gitleaks over the working tree finds nothing after two allowlisted non-secrets (`.gitleaks.toml`). `pnpm audit --prod --audit-level high` passes, with `joi` overridden and one moderate left in OpenTelemetry. `docs/sbom.spdx.json` is generated from the lockfile.
- **Staging:** a demo-mode site with synthetic mail ran from `infra/docker/compose.staging.yml` on an amd64 Linux server, behind a reverse proxy and a password gate. `apps/web/scripts/staging-smoke.mjs` drives such a site in a browser. It wasn't a production deployment: no real mailbox, KMS, relay or AI key.
- **Production mode:** `infra/local/production-boot.sh` ran the real web and worker with `NODE_ENV=production`, demo mode off, separate database logins and `AwsKmsProvider` on a local server speaking the KMS protocol (moto, an emulator). See the results below. No TLS, real KMS, real relay or real mailbox was involved.
- **OpenTofu:** `infra/terraform` passes `validate`, `fmt -check` and `tofu test` with a mocked provider. Includes an encrypted EFS volume for the deletion log. **Never planned against AWS, never applied.**

## What works
| Area | State | Evidence level |
|---|---|---|
| Product auth: password (Argon2id), TOTP with one-time recovery codes, passkeys, sessions, rate limits | Works | Real, tested. Passkey sign-up and sign-in run through a virtual authenticator in Chromium |
| Multi-tenant model, roles, RLS, per-process database logins | Works | Real Postgres under real non-superuser logins |
| Envelope encryption, tenant keys, blind indexes, crypto-shredding | Works | Real crypto. Runs on the dev KMS locally. The production AWS provider has only been tested against a local KMS-protocol server |
| Bounded MIME parsing, HTML sanitizing, sandboxed rendering, click-through links | Works | Real browser test with hostile HTML |
| Security engine: auth, lookalikes, links, QR, attachments, BEC and fraud language, injection, policy, reversible quarantine | Works | Synthetic corpus only: see limits below |
| Deep file inspection (`files.ts`): PDF streams and object streams decoded, hex-escaped names, JavaScript, auto-run actions, Launch, embedded programs, links; Office macros, remote templates, Follina-style links, DDE; RTF Equation Editor objects; HTML and SVG sign-in forms, smuggling, scripts; what scripts download and run | Works | Crafted inert samples only (`files.test.ts`, 14 tests, plus a 3 s bound on hostile input). No real malware corpus yet. Links found inside files go through the URL checks |
| AI attachment review: the hosted model sees each inspected file's signal codes and embedded code (never document text) and can add up to +4 per file, never lower risk | Built | Unit-tested with a fake client. Not yet run against the live model. Needs hosted-model consent, like the rest of the semantic step |
| Focus, priority, explanations, tasks, open loops, digests | Works | Synthetic only |
| Search with Gmail-style operators | Works | PostgreSQL FTS; plaintext lexemes, disclosed, with opt-out |
| Semantic search, off unless `AEGIS_EMBEDDINGS=local` | Works | Real model in real test and browser runs, on synthetic mail only. A local model, sealed vectors, no pgvector. See below for how well it finds things |
| Forwarding the original's attachments | Works | Tested through the route and a real browser, against the demo adapter. Refused for flagged messages and files |
| Drafts, identity-checked send, idempotency, in-doubt reconciliation, scheduling | Works | Real logic; provider side faked |
| Local AI: summaries, tasks, template drafts, assistant | Works | Deterministic and extractive. Visibly less capable than a model |
| Automations with deterministic rules, dry run, approval queue, budgets | Works | Tested |
| Org: members, roles, policies, domains, audit, Security Center, incident sharing, delegation | Works | Tested |
| Address verification, password reset, invitation email | Works | Tested through the real worker queue, with real SMTP to a local server. Demo mode shows mail at `/dev/outbox`. Production with no relay refuses honestly |
| In-app notifications, working and quiet hours, optional digest and browser alerts | Works | Tested, including time zones and daylight saving |
| Privacy Center, export, delete, retention, crypto-shred | Works | Tested |
| All major screens, light and dark, mobile, keyboard | Works | Playwright, axe |
| Marketing site, docs, draft legal pages | Works | Shown only with `AEGIS_MARKETING_SITE=true`; otherwise `/` goes to sign-in. Legal pages are marked drafts |
| Interactive 3D home page: a scroll-driven film following one letter, in 12 chapters | Works | `apps/web/e2e/film.spec.ts`, real browser, with a plain page for reduced motion, no WebGL and no JavaScript. Evidence in it comes from the real engine, and `film-evidence.test.ts` fails if they differ. Frame times measured only on Apple M5, with a throttled CPU for lower tiers: no real phone or weak GPU. The film's QA tools are in `apps/web/scripts/` (`film-shot.mjs`, `film-sheet.mjs`, `film-perf.mjs`, `film-stills.mjs`) |
| 3D scenes on other pages, the report, Privacy Center, Security Center, Insights, onboarding and the operator console | Works | Lazily loaded, and only where they appear: a test confirms the inbox and the plain page never download the 3D engine. The data is also in the DOM beside each one |
| Visual design: white, near-black and one blue, system fonts, a one-line mail list in a rounded panel, details collapsed behind one click | Works | e2e and axe pass in light and dark, and visual baselines were reviewed by eye. Taste was judged only by the person who asked for it |
| Explain mode and per-screen tours (Shift E) | Works | `apps/web/e2e/explain.spec.ts` fails if a page under /app or /admin has no entry. Member and operator screens are checked for pointing at what they describe. Screens that need a condition, such as SSO or a shared mailbox, have entries, but what they point at isn't checked |
| Client-sealed storage (Mode B) | Experimental | Per message, and not zero-access: see `docs/privacy-modes.md` |

## Operators
| Area | State | Evidence level |
|---|---|---|
| Operator console at `/admin`: content-blind, MFA outside demo, 404 for everyone else, suspend, queue retry, health, audit | Works | `aegis_operator` has no table grants: `operator-roles.test.ts` under real logins, `operator-web.test.ts` through the real routes with a canary scan |

## Not proven against real providers
Don't assume these work until `docs/runbooks/live-provider-smoke-test.md` has been run.

| Item | Tested against | Known unknowns |
|---|---|---|
| Gmail OAuth, sync, push, send, revoke | Real `oauth4webapi`, fake Google endpoints | Whether Gmail preserves our Message-ID; real history shapes |
| Microsoft Graph OAuth, delta, subscriptions, send | Fake Graph | Message-ID and Bcc on MIME send; `syncStateNotFound` shape; subscription matching; lifecycle events |
| IMAP | Real Dovecot, and real `imapflow` to a local fake server | Any server other than Dovecot, including iCloud, Yahoo and Fastmail. IDLE isn't used. A move by another client is only followed when its delete and arrival land in one sync page; otherwise it's re-analyzed as new mail. Messages older than the sync window in a folder whose UIDVALIDITY changed drop out of the app |
| SMTP | Real Postfix, and a local server | Any other server, and real relays. A partly refused send is recorded on the approval (`recipients_refused`) and in audit, but the UI doesn't show it yet |
| POP3 | Real Dovecot, and our own fake server | Any server other than Dovecot |
| Pub/Sub JWT and Graph webhook routes | **Not tested end to end** | Written from docs |
| Hosted Claude provider | Fake client | **Never called live.** Prompt quality, refusals and cost are unmeasured |
| Transactional SMTP relay | Real `nodemailer` to a local server, with STARTTLS and certificate checks | Any real relay's limits, bounces and reputation. Failed delivery after retries is recorded but not shown to anyone |
| OIDC SSO | Real `oauth4webapi` against an in-process provider with real signed JWTs, and in a real browser | **Never run against Okta, Entra ID or Google Workspace.** Entra doesn't send `email_verified` by default, so it may refuse everyone until configured |
| SAML SSO | Real `@node-saml/node-saml` and real XML signatures from `xml-crypto` | **Never run against a real provider.** Whether each one will send the required `email_verified` attribute as written |
| Continue with Google, Microsoft | Fake provider standing in for both. Their real endpoints are written from docs | **Never run.** Microsoft needs the `xms_edov` optional claim configured, and its claim format here is from docs |
| SCIM 2.0 | Real HTTP from a browser test client | **Never run against Okta or Entra.** No PUT, so Okta may need PATCH mode. No `Schemas` endpoint, groups or bulk |
| Dockerfile, compose | Run under Colima on arm64 in demo mode, and on amd64 Linux as a demo site (`compose.staging.yml`). Non-demo boot was run outside containers: `infra/local/production-boot.sh`. The self-hosting `compose.yaml` passes `docker compose config`, and its login-creation SQL was run against local Postgres 17 | **The self-hosting stack has never been started**, so a non-demo boot in containers, the volume handover and AWS KMS from a container are unproven. A registry, any orchestrator. The web image is 4.4 GB: it keeps dev dependencies and isn't slimmed |
| CI workflow | Run under `act` on arm64: `test` and `e2e` pass, SBOM upload unproven. Since then the secret scan uses the gitleaks CLI instead of its action, which needs a license on organization accounts | Hosted runners, `GITHUB_TOKEN`, caching, artifact upload. The new secret-scan step hasn't run |


## Blocked on external action
| Blocker | Needs |
|---|---|
| Live Gmail | A Google Cloud project; Testing status is enough to start |
| Gmail beyond 100 test users | Each deployment's own Google project needs restricted-scope verification, which includes a security assessment (CASA) |
| Live Microsoft | An Entra app registration |
| Live iCloud, Yahoo, Fastmail | Test mailboxes and app passwords |
| Production keys | An AWS KMS key. `AwsKmsProvider` exists and passes against a local server speaking the KMS protocol (`aws-kms.live.test.ts`, moto), but has never touched AWS, so IAM, key policies and throttling are untested. **Boot refuses the dev KMS in production** |
| Malware scanning | Run clamd with `infra/docker/clamd.conf`; set `CLAMD_HOST`. Until then attachments say "baseline checks only". Proved against real clamd, but no real malware corpus has been through it, only EICAR |
| Hosted AI | `ANTHROPIC_API_KEY`, then evaluate on real content |
| Field-validated detection | A consented or licensed corpus |
| Security claims | External pen test and cryptographic review; none has happened |
| Certifications | SOC 2 and ISO audits; none exist and none are claimed |
| Legal | Whoever runs an instance for other people needs their own privacy policy and terms. The draft pages in `apps/web` aren't legal advice |
| Name | "Aegis Mail" is a working name. It's close to **AegisAI**, an active email-security company |

## Deliberately not built
| Item | Why |
|---|---|
| Gateway mode: an inline SMTP gateway with pre-delivery quarantine | Dropped on 2026-11-07. The product only connects to existing mail services: Gmail, Outlook, iCloud and IMAP. The experimental code was removed. Its tables and roles from migrations 006 and 013 are still in the schema, unused |
| Attested confidential processing (Mode C) | Needs TEE hardware and an independent verifier, and a software stand-in would be the checkbox the prompt forbids. The design, open problems and acceptance gates are in `docs/mode-c-design.md`, unreviewed |

## Not done (could be built, but wasn't)
| Item | Note |
|---|---|
| Linking Google or Microsoft to an existing account from settings | Refused at sign-in instead, by the linking rule |
| Semantic search over all of a long message or very old mail | One vector per message, from its subject and opening text. Each search compares the newest 5,000 indexed messages. There's no index over sealed vectors, by design |
| Surfacing transactional mail that failed to deliver | Recorded with an error code after retries. The inviter isn't told |
| Alerting and dashboards | OpenTelemetry spans and a content-free metrics endpoint exist. Nothing is wired to an alert, because there's no deployment to alert on |
| Native apps, CRM and calendar agents (P2) | Not started. The browser extension exists as a local-only link checker, `apps/extension` |
| Per-feature privacy toggles for classification and attachment analysis | Security analysis always runs. AI, personalization, hosted models, summaries, attachment retention and search can be turned off |
| Virtualized long lists | Paginated instead |
| Working hours affecting ranking | They decide when notifications arrive, and the setting says it doesn't change ranking |
| Screen-reader manual pass | Automated axe only. Needs a person with a screen reader |

## Semantic search, honestly
Measured with the real model on `packages/test-fixtures/src/semantic-set.ts`: 16 queries and 30 synthetic messages, written by one author to share few words. Printed by `semantic-search.real.test.ts`.

| Measure, with the 0.25 similarity floor | Result |
|---|---|
| A relevant message is the top result | 11 of 16 queries |
| A relevant message is in the top 5 | 15 of 16 queries |
| Mean reciprocal rank | 0.81 |
| Relevant messages found above the floor (recall) | 15 of 18 |
| Results above the floor that were relevant (precision) | 15 of 42 |
| Off-topic queries returning anything, out of 4 | 1, one wrong message |

So it finds most of what it should in a small set, along with about twice as many things it shouldn't, and it misses some paraphrases entirely: "someone asking to move our meeting" finds neither message about rescheduling. The floor was picked on this same set, so these numbers flatter it, and 30 short messages say little about a real mailbox. Nothing has been measured on real mail. That's why results are labelled and word matches stay in the list. See `docs/privacy-modes.md` for what it reads and stores.

## Detection, honestly
See `docs/eval-report.md`. **The number that matters: on a holdout set written by someone other than the rules' author, and never tuned on, the engine caught 55% of attacks at a 5% false-positive rate (91.7% precision, 40 messages).** It's synthetic, and it's small, so treat that as "catches about half of unfamiliar phrasing", not as a field result.

The hand-written `core` set scores 100%, but the same author wrote those messages and the rules, so it's a regression check. The other holdout half, `holdout_dev`, scores 90% because the rules were tuned on it. Only 2 of 8 adversarial paraphrases are caught. Expected calibration error is 0.158, so "threat estimate" is a score, not a calibrated probability.

A linear classifier was trained and **deliberately not shipped**: on the holdout it reached 40% recall at a 40% false-positive rate, worse than the rules. The optional hosted LLM step exists to narrow the paraphrase gap, and has never been measured against a live model.

## Adversarial review
Two independent reviews, each given the code rather than conclusions, and each using working proofs. Neither found a path for another tenant or an admin of another tenant to read mail, a route from tenant user to operator, a forged billing webhook (billing has since been removed), or a SAML signature wrap. **Neither is a substitute for an external pen test, which hasn't happened.**

**First review: 16 issues, fixed**, with tests in `review-regressions.test.ts`: one email stalling a mailbox (NUL bytes) · regex backtracking freezing the worker · sender headers disabling DMARC checks · lures only in the HTML part · quarantined mail teaching trust in lookalikes · grantees sending as the owner · a stolen session adding a passkey past MFA · removed members' mailboxes syncing on · members unable to report phishing · managers minting admin invites · a grantee's consent sending the owner's mail to a hosted model · retention, deletion and seal leaving derived data · links dodging the click-through page · flooding a protective rule off · account lockout by strangers · Pub/Sub tokens from any service account, and unbounded request bodies and rows.

**Second review, of billing (since removed), operators, identity, the then-experimental gateway and recent features: 10 issues, fixed**, with tests in `review-regressions-2.test.ts`, `review-outbound.test.ts` and `review-rule-conflicts.test.ts`. The gateway findings and their tests went with gateway mode on 2026-11-07:
- **High:** a security admin reading a domain's mail by moving the gateway downstream · a stolen session alone taking over an account by adding a factor · one tenant's slow downstream stopping gateway delivery for every tenant.
- **Medium:** an outsider blocking a tenant's inbound mail with held messages · the outbound block list only checked at approval, so scheduled sends and a racing autosave could get past it · the operator MFA gate checking the account rather than the session · plan and seat limits bypassed through SAML, JIT, SCIM and the gateway · a slow webhook undoing a cancellation for good.
- **Low:** stamp replay skipping the gateway scan · a hold being buried by another rule · authenticator codes reusable within their window · domain verification never expiring.

**Still open from the second review:**
1. Someone with both the password and a session can enroll a new authenticator and lock the owner out. Recovery codes help only if the owner already has them, and the owner is emailed.
2. A domain whose TXT record has been gone for 7 days stops being verified. The owner is warned by email.
3. An old identity provider keeps working for up to about 8 days after a domain changes hands.


**A dependency problem found along the way:** `onnxruntime-node`, used for semantic search, sends telemetry to Microsoft, and the library's off switch doesn't work from a worker thread. Early test runs on the build machine reached Microsoft, with synthetic data only in those runs. The provider now sets the variable on the main thread and refuses to start elsewhere, and a real-model test guards it. That's only been checked on macOS, so restrict outbound traffic in production too.

## Backups, honestly
A real `pg_dump` and `pg_restore` run in `restore-drill.test.ts`, and `infra/local/restore-new-cluster.sh` restores into a brand-new cluster and reads mail through the web login. None of this has touched a production database or a managed Postgres.

- **A leak it found, now fixed:** extracted tasks kept the first 40 characters of their text in the clear, in a de-duplication key. Migration 018 scrubs old rows, but copies of the old value can remain in older backups and write-ahead logs.
- **A false claim it found, now corrected:** a backup taken before an account was deleted stays fully readable with the root key until it expires. Nothing here can reach into an existing backup file.
- **Deletion log:** each durable erasure commits an outbox row with the erasure, and the worker ships it to an append-only hash-chained file. `pnpm restore:reapply` replays it after a restore, using the same erasure code as the live path, and really destroys restored keys for a shredded tenant. A production worker won't boot without a log configured.
- **Limits of that log:** a hash chain can't show its own last lines were cut, and anyone who can write to the file can rewrite it from some point onward, so compare `--expect-head` with a head recorded elsewhere. An entry is lost if the database dies between commit and shipping. It doesn't cover deleted drafts, rules, labels, revoked incident shares, or memberships and roles, so a removed member comes back after a restore until SCIM runs again or someone reviews them. Turning search back on, or reconnecting a mailbox, isn't logged, so a restore reverts those. There's no log rotation.
- **What sealing keeps:** the sealed body is gone from the server, but the encrypted envelope (subject and snippet) and security analyses stay.

## Known security limitations
1. Mode A: the operator can read mail while processing, and anyone with deploy rights could change that code. Stated in the Privacy Center.
2. Plaintext search words sit in the database unless turned off. Semantic search vectors are sealed, but the web process decrypts up to 5,000 of them per search, and that's where a compromise of that process would see them.
3. RLS doesn't stop arbitrary SQL execution, because a role can set its own context. All SQL is parameterized.
4. The web process can reach the KMS. The boundary keeps a request-path bug from reading credentials, not a full process compromise from reaching keys.
5. Graph `clientState` is stored in account settings, readable by the owner's context.
6. Lookalike checks use an approximate registrable domain, not the full Public Suffix List.
7. Connector mode can't stop someone opening a message in another client before analysis.
8. CSP allows inline styles, because email rendering and the UI framework use them. Scripts are nonce-locked.
9. Egress must be restricted at the network layer as well; `ssrf.ts` is one layer. On AWS, security groups and network ACLs don't apply to metadata addresses, so `ssrf.ts` is the only thing keeping a worker from the Fargate task metadata endpoint. See `infra/environments/production/README.md`.

## Before relying on it with real mail
1. Run the Google smoke test in Testing status. Fix whatever the fakes got wrong. Repeat for Microsoft and iCloud.
2. Create a real KMS key, run `AwsKmsProvider` against it, and run clamd.
3. Start the self-hosting stack in `compose.yaml` from empty, and record what happens here.
4. Evaluate hosted AI on consented mail.
5. Get a corpus; rerun evaluation; retune.
6. Get an external pen test and cryptographic review.
