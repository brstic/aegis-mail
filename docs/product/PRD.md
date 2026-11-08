# Product Requirements — Aegis Mail (codename)

> **Name.** "Aegis Mail" is a working name held in one constant (`PRODUCT_NAME` in `packages/domain/src/brand.ts`). A 2026-11-06 search found **AegisAI**, an active API-based email-security company for Microsoft 365 / Google Workspace, plus MailAegis (G2-listed), a historic AegisMail (2001), and USPTO EGISMAIL filings, so the name may change.

Aegis Mail is open source (AGPL-3.0) and self-hosted: there is no hosted service and no paid plan.

Implementation truth lives in [`docs/STATUS.md`](../STATUS.md). This document states intent; STATUS states what exists.

## Vision
The most capable, trustworthy multi-provider email workspace: Gmail-level familiarity, AI-native attention management, layered phishing defense, secure team workflows, and an architecture whose privacy limits are explicit and testable.

## Audiences
People and small organizations without security teams who can run a server, or have someone who can: finance, legal, ops, recruitment, support, agencies, consultants, founders; and larger organizations that want a secure cross-provider client they operate themselves.

## North-star metric
**Verified high-value communications handled safely per user per week**, supported by time-to-action, false-positive rate, detection effectiveness and trust metrics. Email opens and AI usage are never optimized for their own sake. The software collects no product analytics: these are measured in evaluations and pilots.

## The five promises and how each is made checkable
| Promise | Checkable as |
|---|---|
| One place for all email | Account identity is visible on every row and in every composer; cross-account send test |
| Important first | Focus ranks after security classification; each row answers "why am I seeing this?" from stored features |
| Security in every interaction | Pipeline runs before Focus; reasons are shown; quarantine is reversible and audited |
| Useful AI, not noise | Each AI capability is a discrete function with tests; AI can be turned off and Inbox stays chronological |
| Privacy people can inspect | Privacy Center reads actual config; admin-cannot-read is enforced by database roles and tests |

## Priorities

### P0 — core foundation
Responsive multi-account web app with three-column layout and keyboard navigation · product auth independent of mail authorization (passwords via Argon2id, passkeys, TOTP) · Gmail and Microsoft OAuth connection · IMAP + SMTP with TLS, app passwords, diagnostics · iCloud guided setup (never via Sign in with Apple) · provider sync engines with idempotent events, retries, reconciliation, status · unified thread/message model · Focus, Inbox, per-account, Search, Sent, Drafts, Archive, Spam, Trash, Quarantine · secure rendering and attachment handling · multi-stage phishing/spam detection with explanations and reversible quarantine · AI importance, summaries, suggested actions, human-approved drafts · preferences and feedback · tenant isolation, encryption, audit, no-admin-content policy, mode limits · accurate delivery semantics (quarantine happens after the provider receives a message) · E2E tests for connect → receive → classify → render → reply → disconnect.

### P1 — business competitiveness
Orgs/teams/roles, SSO where available, policies, security dashboards · advanced BEC, impersonation, reply-chain spoofing, QR phishing, payment-change flags, conversation anomalies · shared/delegated mailboxes with explicit permission · triage rules and automation with approvals · semantic search and cross-account context · follow-up prediction, reminders, tone profiles · export, migration, retention, incident review, policy audit · onboarding, tenant provisioning, a content-blind operator console.

### P2 — competitive expansion
Cross-account analytics · approved agent workflows to tasks/CRM/calendar · browser extension · native/mobile · region-pinned deployments · attested confidential inference and BYOK/HYOK · custom model endpoints, on-device inference.

## Explicit non-claims
Never claim: "zero knowledge" or "zero access" in managed processing; "end-to-end encrypted email" for ordinary mail; "100% phishing protection"; "unhackable"; "military-grade"; certifications not earned; pre-delivery protection in connector mode; "instant" for polling IMAP; Sign in with Apple granting iCloud Mail access; absolute detection rates without evaluated evidence.

## User stories
Twelve user stories from the original product brief are tracked with their tests in [`docs/acceptance-matrix.md`](../acceptance-matrix.md).

## Success measures
First Focus success, actions saved, reported false positives, detection precision and recall on representative datasets, time to safe quarantine, sync lag, model cost, queue failures and reconnection rate, measured by whoever runs an instance through its own metrics and logs. Nothing reports usage back to the project, and nothing ever captures email bodies.
