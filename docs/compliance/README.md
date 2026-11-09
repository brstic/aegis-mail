# Compliance preparation

**Nothing here is a certification or legal advice. No audit has occurred.** Aegis Mail is software you run yourself, so whoever runs an instance for other people is the one with these obligations. This page maps what the code provides to common control frameworks, as a starting point for that work. Have qualified counsel review it before relying on it.

## Control mapping (preparation only)
| Control area | SOC 2 TSC | ISO 27001 Annex A | Implementation | Evidence | Gap |
|---|---|---|---|---|---|
| Logical access | CC6.1–6.3 | A.5.15–18, A.8.2–5 | Roles, RLS, process logins, MFA, passkeys | `process-boundary.test.ts`, `admin-cannot-read.test.ts` | Staff access process belongs to the deployer |
| Encryption | CC6.1, CC6.7 | A.8.24 | Envelope AES-256-GCM, TLS | `crypto.test.ts`, `at-rest.test.ts` | **No production KMS** |
| Change management | CC8.1 | A.8.32 | CI, lockfile | `.github/workflows/ci.yml` | Run only under `act`, never on hosted runners; no signed builds |
| Operator access | CC6.1, CC6.3 | A.5.15, A.8.2 | Separate `aegis_operator` role with no table grants, narrow definer functions, MFA, append-only audit | `operator-roles.test.ts`, `operator-web.test.ts` | Staff access reviews belong to the deployer |
| Monitoring | CC7.2 | A.8.15–16 | Content-free logs, audit table | `at-rest.test.ts` | OpenTelemetry spans and metrics exist; nothing is wired to an alert |
| Incident response | CC7.3–7.5 | A.5.24–28 | Runbook | `docs/runbooks/incident-response.md` | Not rehearsed |
| Availability | A1.2 | A.8.13–14 | Durable queue | Queue tests | Restore drilled on local Postgres only (`restore-drill.test.ts`), no production backups, no SLOs measured |
| Vendor management | CC9.2 | A.5.19–22 | Subprocessor list below | This file | No DPAs signed |
| Privacy | P1–P8 | A.5.34 | Privacy Center, export, delete | `privacy.ts`, tests | Policies are drafts |

## GDPR preparation
**Roles:** an organization running its own instance for its staff is usually the controller. Someone running an instance for other organizations is likely their processor. Get counsel's view for your setup. **Lawful basis:** depends on who runs the instance and for whom. Consent for hosted AI is recorded per user in `consent_records`. **Employee monitoring:** the admin-can't-read design helps, but aggregate security telemetry on employees may still need works-council or notice obligations in some countries.
**Transfers:** depend on where you host the instance, your KMS region, and the model provider's region if hosted AI is on. **DPIA:** likely necessary: large-scale processing of communications plus automated scoring. **Breach workflow:** see incident runbook.

## Record of processing (draft)
| Activity | Data | Purpose | Retention | Recipients |
|---|---|---|---|---|
| Mail sync and caching | Message content, metadata | Provide the mail client | Until disconnect or tenant retention | Mail provider (source) |
| Security analysis | Headers, content, attachments | Detect threats | Result retained with the message | clamd if configured |
| Priority and tasks | Derived features | Organize attention | With the message; user can reset | None |
| Hosted AI, when the instance has a key | Text of every incoming message, and what was found inside its attachments | Security review | Per model provider terms | Model provider |
| Hosted AI (opt-in per person) | Thread content | Summaries, drafts | Per model provider terms | Model provider |
| Telemetry | Label, category, action, day | Tenant security view | Until tenant deletion | Tenant security admins |
| Audit | Actor, event, target ID | Accountability | Per policy | Tenant admins |
| Operator audit | Operator, action, tenant ID, reason | Accountability for the people running the instance | Append-only; no retention job yet | Service operators |

## Subprocessors
Depends on the deployment. Candidates: the host or cloud provider, AWS KMS (which holds the root key and sees wrapped keys, never content), the SMTP relay (verification and invitation mail), and the model provider (OpenAI by default, or Anthropic), if hosted AI is configured: it then receives every incoming message for security review. Mail providers such as Google and Microsoft hold the mail already, and are sources rather than processors.

## Before offering an instance to other people
Google API Services User Data Policy, Limited Use and, beyond 100 test users, restricted-scope verification with a CASA assessment · Microsoft publisher verification · provider terms · a DPA and subprocessor list where you act as a processor · your own privacy policy and terms (the `/legal/*` pages in `apps/web` are drafts, not advice).
