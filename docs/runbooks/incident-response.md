# Incident response

Roles: incident lead, comms, scribe. Severity: **S1** cross-tenant exposure, key compromise, or confirmed plaintext exposure. **S2** token compromise or a malicious attachment escape. **S3** detection false negative with impact, or an outage.
Always: preserve logs (they're content-free by design), keep a timeline, assess notification duties with counsel (GDPR: 72 hours to the authority where applicable).

| Scenario | Contain | Eradicate and recover | Communicate |
|---|---|---|---|
| OAuth token or credential compromise | Set affected accounts `reconnect_required`; revoke at provider; rotate client secret if the app itself is compromised | Rotate the `credential` KEK class; re-encrypt; force reconnect | Affected users; provider if required |
| Sender impersonation false negative | Add indicators to the tenant blocklist; find matches by reason code, not by reading mail | Add a sample to the corpus, tune, rerun `pnpm eval`, and check for false positives | Affected tenant; never promise "won't recur" |
| Malicious attachment or sanitizer escape | Force plain text; block the attachment route; disable the affected parser path | Patch; add the vector to `parser.test.ts`; re-sanitize happens on render, so no stored output needs fixing | Users who opened it |
| Storage or backup exposure | Rotate credentials; restrict access | Assess: ciphertext, plus disclosed **plaintext search lexemes**. Rotate affected KEKs | Per legal advice. State exactly what the dump contains |
| Key compromise (KMS or tenant KEK) | Disable the KMS key version; stop workers | Rotate; re-seal all records; invalidate cached keys by restart | S1 |
| Cross-tenant access | Take the affected route offline; capture `access.denied` audit trail and queries | Fix; add a regression to `tenant-isolation.test.ts`; audit the blast radius from logs | S1 |
| Compromised deploy pipeline | Freeze deploys; roll back to the last known-good signed build | Rotate all secrets. In Mode A assume plaintext may have been exposed during the window | S1 |
| Malicious prompt-injection success | Disable hosted models via tenant policy | Add to `injection.ts` corpus; the worst-case test should already bound the damage, so find which assumption failed | Affected users |

After: blameless review within five working days, tracked actions, and update the threat model.
