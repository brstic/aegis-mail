# Provider integration matrix

Verified against official documentation on **2026-11-06**. Re-verify before relying on it; provider policy moves.

| Provider | Connection | Sync | Latency budget | Send | Go-live gate |
|---|---|---|---|---|---|
| Gmail / Workspace | OAuth code + PKCE | `users.watch` + Pub/Sub → `history.list`; 404 → full sync | ~1 min with push; reconcile every 6 h | `messages.send` | **Restricted-scope verification + annual CASA assessment** |
| Outlook.com / M365 | OAuth code + PKCE, delegated, `/common` | Graph subscriptions + per-folder delta | <1 min avg, 3 min max (Graph-published for messages) | `sendMail`, `createReply` | Publisher verification recommended; tenant consent behaviour varies |
| iCloud Mail | IMAP/SMTP + **app-specific password** | IMAP IDLE/poll | Poll: 2 min | SMTP submission | None; user creates password. Never via Sign in with Apple |
| Yahoo | IMAP/SMTP + app password | IMAP IDLE/poll | Poll: 2 min | SMTP | None |
| Fastmail | IMAP/SMTP + app password | IMAP IDLE/poll | Poll: 2 min | SMTP | Plan-dependent (third-party sources say Basic lacks IMAP; verify) |
| Zoho, cPanel, Plesk, self-hosted | IMAP/SMTP | IMAP IDLE/poll | Poll: 5 min | SMTP | None |
| POP3 | TLS POP3 | Fetch/import only | Poll: 15 min | None via POP3 (optional SMTP) | P1, limited |
| Proton | Only via user-run Proton Mail Bridge exposing local IMAP/SMTP; the server can't reach a user's own machine, and the host guard refuses loopback and private addresses | Not supported | — | — | Stated as unsupported; no workaround |

## Gmail facts used
- Scopes (official classification): `gmail.readonly`, `gmail.modify`, `gmail.compose`, `gmail.metadata` are **restricted**; `gmail.send` is **sensitive**; `gmail.labels` is non-sensitive. `https://mail.google.com/` is restricted and only for permanent delete bypassing trash.
- **We request:** read-only mode → `gmail.readonly`. Full mode → `gmail.modify` (read, label, draft, send; cannot permanently delete). Never `mail.google.com`.
- "If you store restricted scope data on servers (or transmit), then you must go through a security assessment." Assessors are Google-approved third parties using App Defense Alliance CASA; reassess at least every 12 months; review can take several weeks. Google's page doesn't state cost.
- Exemptions: personal use, Testing status with listed test users (limited refresh-token lifetime and user cap), Internal-type Workspace apps. **Early access runs in Testing status.**
- Watch: call at least every 7 days, Google recommends daily. Grant publish on topic to `gmail-api-push@system.gserviceaccount.com`. Payload: base64url `{emailAddress, historyId}`. Max 1 notification/s per user, excess dropped; notifications may be delayed or dropped, so periodic `history.list` is required.
- History records "typically available for at least one week"; can be much shorter; 404 → full sync.
- Pub/Sub push authentication is not covered on the Gmail page; we verify the OIDC JWT Pub/Sub attaches to push requests (see ADR-0005) and treat the payload only as a sync hint.

## Microsoft Graph facts used
- Least-privilege delegated: `Mail.ReadWrite` + `Mail.Send` + `offline_access` + `User.Read`; read-only mode uses `Mail.Read`. Never application permissions for user login. Shared/delegated-folder subscriptions would need application permissions, so they aren't offered at user login.
- Subscription lifetime for Outlook messages: **10,080 minutes** max without resource data (1,440 with). We use no resource data, and renew at <24 h remaining. 1,000 active subscriptions per mailbox across apps.
- Basic notifications carry only IDs, so bodies never traverse the webhook. Validate `clientState` per subscription; lifecycle notifications trigger recovery.
- Delta is **per folder**; `@odata.nextLink`/`@odata.deltaLink` opaque; `@removed` for deletions; `$filter=receivedDateTime ge` limited to 5,000 results; `$search` unsupported in delta.
- Prefer object ID over UPN in resource paths; `AAD-UPN:` prefix for GUID-leading UPNs. With delegated auth we use `/me`.
- Basic auth for Outlook.com IMAP is being removed; Microsoft's Feb 2024 article commits to OAuth only. So Outlook hosts in IMAP setup are redirected to Microsoft OAuth.

## iCloud facts used (Apple HT102525)
IMAP `imap.mail.me.com:993` SSL/TLS, username usually local part; fall back to full address. SMTP `smtp.mail.me.com:587` STARTTLS, full address. App-specific password required for both. "iCloud Mail does not support POP."

## Yahoo / Fastmail
Yahoo `imap.mail.yahoo.com:993`, `smtp.mail.yahoo.com:465|587`, app password (from secondary sources; Yahoo's help page was not retrieved). Fastmail `imap.fastmail.com:993`, `smtp.fastmail.com`, app password (Fastmail help). Discovery presets are suggestions that a user must confirm.

## What can't be done without external action
See `docs/STATUS.md` → "Blocked on external action".
