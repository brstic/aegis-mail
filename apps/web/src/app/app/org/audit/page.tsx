"use client";
import { useState } from "react";
import { ScrollText } from "lucide-react";
import { fmtDateTime, Head, PageSkeleton, providerLabel, ROLE_LABEL, TableScroll, tdClass, thClass } from "@/components/settings/common";
import { Banner, Button, EmptyState, ErrorState, RISK } from "@/components/ui";
import { useApi } from "@/lib/client";

const EVENT: Record<string, string> = {
  "auth.login": "Signed in", "auth.login_failed": "Sign-in failed", "auth.mfa_enabled": "Authenticator app turned on", "auth.mfa_disabled": "Authenticator app turned off", "auth.passkey_added": "Passkey added", "auth.passkey_removed": "Passkey removed",
  "auth.email_verified": "Email address confirmed", "auth.password_reset": "Password reset", "auth.recovery_code_used": "Recovery code used", "auth.recovery_codes_replaced": "New recovery codes made", "auth.sso_refused": "Single sign-on refused", "session.revoked": "Session revoked",
  "account.connected": "Mailbox connected", "account.sync_requested": "Sync requested", "account.disconnected": "Mailbox disconnected", "token.revoked": "Provider access revoked", "provider.sync_failed": "Mailbox sync failed",
  "message.quarantined": "Message blocked", "message.released": "Message released", "automation.executed": "Rule ran", "draft.generated": "Draft suggested",
  "send.requested": "Send requested", "send.authorized": "Send approved", "send.completed": "Message sent", "send.failed": "Send failed",
  "policy.changed": "Settings changed", "member.invited": "Member invited", "member.joined": "Member joined", "member.role_changed": "Access changed", "domain.record_restored": "Domain record restored",
  "sso.configured": "Single sign-on set up", "sso.enforced": "Single sign-on requirement changed", "sso.removed": "Single sign-on removed",
  "scim.token_rotated": "Provisioning token replaced", "scim.token_revoked": "Provisioning token revoked", "scim.user_provisioned": "Person provisioned", "scim.user_deprovisioned": "Person deprovisioned",
  "incident.shared": "Report shared with analyst", "incident.revoked": "Shared report revoked",
  "operator.override_set": "Service operator changed a limit", "operator.override_cleared": "Service operator removed a limit change", "operator.tenant_suspended": "Service operator suspended this workspace", "operator.tenant_unsuspended": "Service operator lifted the suspension", "operator.owner_contact_viewed": "Service operator viewed the owner's contact details",
  "data.exported": "Data exported", "data.deleted": "Data deleted", "key.shredded": "Keys destroyed", "access.denied": "Access denied",
};

/** "auth.mfa_enabled" reads "Mfa enabled", "draft_blocked" reads "Draft blocked": never a raw code. */
const human = (s: string) => { const t = s.replace(/^[a-z]+\./, "").replace(/[_.]+/g, " ").trim(); return t ? t.charAt(0).toUpperCase() + t.slice(1) : s; };
const eventLabel = (e: string) => EVENT[e] ?? human(e);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const role = (r: unknown) => ROLE_LABEL[String(r)] ?? human(String(r));
const PROTOCOL: Record<string, string> = { oidc: "OpenID Connect", saml: "SAML" };
const LOGIN: Record<string, string> = { password: "With a password", mfa: "With a password and authenticator code", passkey: "With a passkey", signup: "New account", sso_mfa: "Through single sign-on, with an authenticator code" };
const DELETED: Record<string, string> = { account: "A whole account", mailbox: "A mailbox", sealed: "A sealed message" };

/** One plain sentence for each event's details. Unknown fields fall back to readable words, never raw keys. */
function details(event: string, m: Record<string, unknown> | null): string {
  if (!m) return "";
  const s = (k: string) => (m[k] === null || m[k] === undefined ? undefined : String(m[k]));
  const n = (k: string) => Number(m[k] ?? 0);
  const r = s("reason");
  const reason = r === "restore_reapply" ? "Reapplied after a restore" : r ? human(r) : undefined;
  switch (event) {
    case "auth.login": { const o = s("outcome") ?? ""; return LOGIN[o] ?? (o.startsWith("sso_") ? `Through single sign-on (${PROTOCOL[o.slice(4)] ?? human(o.slice(4))})` : human(o)); }
    case "auth.recovery_code_used": return `${plural(n("count"), "code")} left`;
    case "auth.sso_refused": return [s("code") && human(s("code")!), s("provider") && (PROTOCOL[s("provider")!] ?? human(s("provider")!))].filter(Boolean).join(", ");
    case "message.quarantined": { const l = s("label"); return l ? `Rated ${(RISK[l]?.label ?? human(l)).toLowerCase()}` : ""; }
    case "account.connected": case "account.disconnected": return s("provider") ? providerLabel(s("provider")!) : "";
    case "token.revoked": return [s("provider") && providerLabel(s("provider")!), s("outcome") === "manual_revoke_needed" ? "Finish removing access at the provider" : undefined].filter(Boolean).join(". ");
    case "account.sync_requested": return s("outcome") === "demo_seed" ? "Sample mail added" : "";
    case "provider.sync_failed": return [s("provider") && providerLabel(s("provider")!), s("outcome") === "rolled_back" ? "Changes rolled back" : undefined].filter(Boolean).join(". ");
    case "automation.executed": return `Applied to ${plural(n("count"), "message")}`;
    case "draft.generated": return "";
    case "send.authorized": return [s("outcome") === "scheduled" ? "Scheduled for later" : "To send now", s("kind") === "delegate" ? "by someone with shared access" : undefined].filter(Boolean).join(", ");
    case "send.completed": return s("outcome") === "partial" ? `${plural(n("count"), "recipient")} refused` : "";
    case "send.requested": return s("kind") === "forward_attachments" ? `Forward with ${plural(n("count"), "attachment")}` : "";
    case "send.failed": return reason ?? "";
    case "access.denied": return [reason, s("kind") === "forward_attachments" ? "Forwarding attachments" : undefined].filter(Boolean).join(", ");
    case "member.invited": return s("role") ? `As ${role(s("role")).toLowerCase()}` : "";
    case "member.joined": return [s("role") && `As ${role(s("role")).toLowerCase()}`, s("outcome") === "invitation" ? "by invitation" : s("outcome") === "jit" ? "on first single sign-on" : undefined].filter(Boolean).join(", ");
    case "member.role_changed": { const o = s("outcome"); return o === "granted" ? "Mailbox shared" : o === "revoked" ? "Mailbox sharing ended" : o === "removed" ? "Removed from the workspace" : o === "role_retired" ? "Now member, because their previous role no longer exists" : s("role") ? `Now ${role(s("role")).toLowerCase()}` : ""; }
    case "policy.changed": {
      if (s("kind") === "key_rotation") return "Key rotation started";
      if (s("kind") === "key_reseal") return `Keys re-sealed for ${plural(n("count"), "item")}`;
      const f = Array.isArray(m.fields) ? m.fields.map(x => human(String(x)).toLowerCase()) : [];
      return f.length ? `Changed ${f.join(", ")}` : "";
    }
    case "sso.configured": return [s("kind") && (PROTOCOL[s("kind")!] ?? human(s("kind")!)), s("role") && `new people join as ${role(s("role")).toLowerCase()}`].filter(Boolean).join(", ");
    case "sso.enforced": return s("outcome") === "on" ? "Now required" : "No longer required";
    case "scim.user_provisioned": return s("outcome") === "reactivated" ? "Reactivated" : "";
    case "incident.shared": return [m.hours ? `For ${plural(n("hours"), "hour")}` : undefined, m.redacted ? "redacted report" : "full message"].filter(Boolean).join(", ");
    case "data.exported": return plural(n("count"), "conversation");
    case "data.deleted": return [DELETED[s("kind") ?? ""] ?? (s("kind") && human(s("kind")!)), reason].filter(Boolean).join(". ");
    case "key.shredded": return ["Workspace keys", reason].filter(Boolean).join(". ");
  }
  if (event.startsWith("operator.")) return r ? `Reason: ${r}` : "";
  // Anything else: the values in plain words, without internal field names.
  return Object.entries(m).filter(([k, v]) => v !== null && v !== undefined && typeof v !== "object" && !k.endsWith("_id")).map(([, v]) => typeof v === "boolean" ? "" : human(String(v))).filter(Boolean).join(", ");
}

export default function AuditPage() {
  const [before, setBefore] = useState<number | null>(null);
  const { data, isLoading, error, refetch } = useApi<{ rows: { id: number; event: string; targetType: string | null; meta: Record<string, unknown> | null; at: string; actor: string | null }[]; scope: "workspace" | "own" }>(["org", "audit", before], `/org/audit${before ? `?before=${before}` : ""}`, { retry: false });
  return (
    <>
      <Head title="Audit log" description="Everything that happened in this workspace, newest first. Entries never hold subjects, senders or message text." />
      {isLoading ? <PageSkeleton blocks={2} /> : error || !data ? <ErrorState error={error ?? { message: "Audit log isn't available." }} retry={() => refetch()} /> : (
        <div className="space-y-3">
          {data.scope === "own" && <Banner tone="neutral">Your role shows only your own activity. Owners and security admins see the whole workspace.</Banner>}
          {!data.rows.length ? <div className="rounded-xl bg-surface"><EmptyState icon={ScrollText} title="No events yet">Sign-ins, setting changes and other activity will be listed here.</EmptyState></div> : (
            <TableScroll label="Audit events">
              <table className="w-full min-w-[36rem] border-collapse bg-surface">
                <thead><tr><th scope="col" className={thClass}>When</th><th scope="col" className={thClass}>Event</th><th scope="col" className={thClass}>Who</th><th scope="col" className={thClass}>Details</th></tr></thead>
                <tbody>{data.rows.map(r => <tr key={r.id} data-testid="audit-row"><td className={`${tdClass} whitespace-nowrap`}>{fmtDateTime(r.at)}</td><td className={tdClass}>{eventLabel(r.event)}</td><td className={tdClass}>{r.actor ?? (r.event.startsWith("operator.") ? "Service operator" : "System")}</td><td className={`${tdClass} text-muted`}>{details(r.event, r.meta)}</td></tr>)}</tbody>
              </table>
            </TableScroll>
          )}
          {(before || data.rows.length === 100) && <div className="flex gap-2">
            {before && <Button size="sm" onClick={() => setBefore(null)}>Newest</Button>}
            {data.rows.length === 100 && <Button size="sm" onClick={() => setBefore(data.rows[data.rows.length - 1]!.id)}>Older</Button>}
          </div>}
        </div>
      )}
    </>
  );
}
