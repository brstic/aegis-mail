# Live provider smoke test

**Status: never run.** Everything so far runs against fakes or local protocol servers. These steps close that gap and need accounts we don't have. Use dedicated test mailboxes, never real ones.

## Google (Testing status needs no verification)
1. Cloud project → enable Gmail API → OAuth consent, External, **Testing**, add the test user. Testing means a warning screen, a user cap and a limited refresh-token lifetime.
2. Web client with redirect `https://<origin>/api/v1/oauth/gmail/callback`. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
3. Optional push: Pub/Sub topic; grant publish to `gmail-api-push@system.gserviceaccount.com`; push subscription to `/api/v1/webhooks/gmail` with OIDC auth; set `GOOGLE_PUBSUB_TOPIC`, `GOOGLE_PUBSUB_AUDIENCE`.
4. Check, recording each: connect shows `gmail.modify` only · recent mail syncs · message from outside arrives within budget · a phish-shaped test message is held and its Gmail copy moves to Spam · release restores it · reply threads in Gmail and **keeps our Message-ID** (unverified) · revoke access at myaccount.google.com, then sync stops with a reconnect prompt · disconnect revokes.
5. Verify the fake against reality: compare `history.list` responses with `gmail-slice.test.ts`'s `FakeGoogle`, and fix whichever is wrong.

## Microsoft
Entra app, multitenant + personal accounts, delegated `Mail.ReadWrite Mail.Send offline_access User.Read`, redirect `/api/v1/oauth/microsoft/callback`. Set `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_WEBHOOK_URL`. Same checklist, plus these unverified points: Message-ID preservation on MIME send; `Bcc` in MIME send; the real `syncStateNotFound` response shape; subscription matching by `notificationUrl`; lifecycle notifications.

## iCloud, Yahoo, Fastmail
App-specific password per provider. Check connect, folder mapping, flag and move sync, UIDVALIDITY handling, send, and whether SMTP files a Sent copy, since IMAP send reconciliation depends on it.

## Record results in `docs/STATUS.md`.

## Identity and mail

None of this has been run against a real service. Fix whatever the fakes got wrong, then update `docs/STATUS.md`.

**SMTP relay.** Set `TRANSACTIONAL_SMTP_URL` and `TRANSACTIONAL_FROM` for both web and worker, with `DEMO_MODE=false`. Sign up and check the verification mail arrives and its link works. Check SPF and DKIM pass for the from domain. Point it at a relay with a bad certificate and confirm nothing is sent.

**OpenID Connect, each of Okta, Entra ID, Google Workspace.** Verify a domain, register the redirect URI, save, and use "Test sign-in now". Check:
- The ID token carries `email` and `email_verified: true`. Entra probably won't send the second by default. If it can't be configured, the linking rule needs a decision, not a workaround.
- Both client authentication methods the provider advertises work.
- A key rotation at the provider doesn't break sign-in.

**SAML, each of Okta and Entra ID.** Give the provider the ACS URL and entity ID from the SSO page. Add the `email_verified` attribute with the value `true`. Sign the assertion. Check:
- The signed-in cookie survives the cross-site POST in Safari and Firefox, which handle SameSite=None differently from Chrome.
- A response replayed from the browser's history is refused.

**Continue with Google and Microsoft.** Use dedicated clients with `SIGNIN_*`, not the mailbox clients. For Microsoft, add the `xms_edov` optional claim and check it arrives. Without it, nobody can create an account.

**SCIM, each of Okta and Entra ID.** Generate a token and connect. Check creating, deactivating, reactivating and deleting a user, and that deactivating disconnects their mailboxes. Okta may need PATCH mode, since there's no PUT.

