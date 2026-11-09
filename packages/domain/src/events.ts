/** Canonical event vocabulary. Events carry IDs, never content. */
export const EVENT_TYPES = [
  "account.connected", "account.sync_requested", "account.disconnected",
  "message.discovered", "message.normalized", "message.security_scanned", "message.classified",
  "message.quarantined", "message.released", "sender.exception_added", "focus.updated", "draft.generated",
  "send.requested", "send.authorized", "send.completed", "send.failed",
  "provider.sync_failed", "token.revoked", "policy.changed", "automation.executed",
  "incident.shared", "incident.revoked", "member.invited", "member.role_changed", "session.revoked",
  "auth.login", "auth.login_failed", "auth.mfa_enabled", "auth.recovery_code_used", "auth.recovery_codes_replaced", "auth.mfa_disabled", "auth.passkey_added", "auth.passkey_removed",
  "data.exported", "data.deleted", "key.shredded", "access.denied",
  "auth.email_verified", "auth.password_reset", "auth.sso_refused", "sso.configured", "sso.removed", "sso.enforced",
  "domain.record_missing", "domain.record_restored", "domain.lapsed",
  "scim.token_rotated", "scim.token_revoked", "scim.user_provisioned", "scim.user_deprovisioned", "member.joined",
  "operator.override_set", "operator.override_cleared", "operator.tenant_suspended", "operator.tenant_unsuspended", "operator.owner_contact_viewed",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
