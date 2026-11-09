"use client";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, Lock, Save } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { ConfirmModal, fmtDateTime, Head, PageSkeleton, textareaClass } from "@/components/settings/common";
import { Banner, Button, Card, ErrorState, Field, inputClass, Toggle } from "@/components/ui";
import { api, useAction, useApi, useMe } from "@/lib/client";

interface PolicyResp { policy: { quarantineThreshold: "suspicious" | "high_risk" | "malicious"; blockDomains: string[]; outboundBlockDomains?: string[]; allowDomains: string[]; protectedDomains: string[]; moveBulkToSpam: boolean; blockRemoteImages: boolean; releaseRequiresApprovalForMalicious: boolean; hostedModelsDisabled?: boolean }; retentionDays: number | null; updatedAt: string | null }

const toLines = (a: string[]) => a.join("\n");
const fromLines = (s: string) => [...new Set(s.split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(Boolean))];

function KeyRotation() {
  const { data: me } = useMe();
  const [confirm, setConfirm] = useState(false);
  const [done, setDone] = useState(false);
  const rotate = useAction<void>(() => api("/org/keys/rotate", { method: "POST" }), { refresh: false, success: "Keys rotated. Data is re-encrypting in the background.", onDone: () => { setConfirm(false); setDone(true); } });
  const owner = me?.role === "owner";
  return (
    <Card title="Encryption keys" description="Replaces this workspace's encryption keys with new ones. Rotate after a suspected exposure or on your own schedule." action={<KeyRound className="size-4 shrink-0 text-muted" aria-hidden />}>
      <div className="space-y-2" data-testid="key-rotation">
        <p className="text-[13px]">New mail uses the new keys right away. Everything already stored is re-encrypted in the background, and mail keeps working while it runs. Old keys stay until that finishes.</p>
        {done && <Banner tone="safe">Rotation started. Data is re-encrypting in the background, and nothing else is needed from you. It's recorded in the audit log.</Banner>}
        {owner ? <Button icon={KeyRound} onClick={() => setConfirm(true)}>Rotate keys</Button> : <p className="flex items-center gap-1.5 text-[13px] text-muted"><Lock className="size-3.5 shrink-0" aria-hidden />Only workspace owners can rotate keys.</p>}
      </div>
      {confirm && <ConfirmModal title="Rotate encryption keys?" confirmLabel="Rotate keys" busy={rotate.isPending} onConfirm={() => rotate.mutate()} onClose={() => setConfirm(false)}><p>This creates new keys for this workspace. Data re-encrypts in the background, which can take a while on a large workspace. Mail keeps working while it runs.</p><p className="text-muted">It's recorded in the audit log and can't be undone, though it's safe to run again.</p></ConfirmModal>}
    </Card>
  );
}

export default function PoliciesPage() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data, isLoading, error, refetch } = useApi<PolicyResp>(["org", "policy"], "/org/policy", { retry: false });
  const canEdit = !!me && ["owner", "security_admin"].includes(me.role);
  const [threshold, setThreshold] = useState<PolicyResp["policy"]["quarantineThreshold"]>("high_risk");
  const [block, setBlock] = useState("");
  const [outbound, setOutbound] = useState("");
  const [allow, setAllow] = useState("");
  const [prot, setProt] = useState("");
  const [bulk, setBulk] = useState(false);
  const [images, setImages] = useState(true);
  const [release, setRelease] = useState(true);
  const [hostedOff, setHostedOff] = useState(false);
  const [retention, setRetention] = useState("");
  const [retentionError, setRetentionError] = useState<string | undefined>();
  useEffect(() => {
    if (!data) return;
    const p = data.policy;
    setThreshold(p.quarantineThreshold); setBlock(toLines(p.blockDomains)); setOutbound(toLines(p.outboundBlockDomains ?? [])); setAllow(toLines(p.allowDomains)); setProt(toLines(p.protectedDomains));
    setBulk(p.moveBulkToSpam); setImages(p.blockRemoteImages); setRelease(p.releaseRequiresApprovalForMalicious); setHostedOff(p.hostedModelsDisabled === true);
    setRetention(data.retentionDays === null ? "" : String(data.retentionDays));
  }, [data]);
  const save = useAction<void>(() => api("/org/policy", { method: "PATCH", body: { quarantineThreshold: threshold, blockDomains: fromLines(block), outboundBlockDomains: fromLines(outbound), allowDomains: fromLines(allow), protectedDomains: fromLines(prot), moveBulkToSpam: bulk, blockRemoteImages: images, releaseRequiresApprovalForMalicious: release, hostedModelsDisabled: hostedOff, retentionDays: retention.trim() ? Number(retention) : null } }), { refresh: false, success: "Policy saved.", onDone: () => void qc.invalidateQueries({ queryKey: ["org", "policy"] }) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(retention);
    if (retention.trim() && (!Number.isInteger(n) || n < 1 || n > 3650)) { setRetentionError("Enter a whole number of days from 1 to 3650, or leave this empty."); return; }
    setRetentionError(undefined);
    save.mutate();
  };
  return (
    <>
      <Head title="Policies" description="Rules that apply to everyone's mail in this workspace. Changes are recorded in the audit log." />
      {isLoading ? <PageSkeleton blocks={3} /> : error || !data ? <ErrorState error={error ?? { message: "Policy isn't available." }} retry={() => refetch()} /> : (
        <form onSubmit={submit} noValidate className="space-y-4">
          {!canEdit && <Banner tone="neutral" icon={Lock}>You can read these policies. Only owners and security admins can change them.</Banner>}
          {data.updatedAt && <p className="text-xs text-muted">Last changed {fmtDateTime(data.updatedAt)}</p>}
          <fieldset disabled={!canEdit} className="min-w-0 space-y-4 disabled:opacity-80">
            <Card title="Blocked mail" description="Mail at or above this rating is kept out of inboxes here, for owners and security admins to review. Your mail provider still receives it.">
              <div className="space-y-3">
                <Field label="Block messages rated"><select className={inputClass} value={threshold} onChange={e => setThreshold(e.target.value as typeof threshold)}><option value="suspicious">Suspicious or worse</option><option value="high_risk">High risk or worse</option><option value="malicious">Malicious only</option></select></Field>
                <Toggle label="Require approval to release malicious mail" checked={release} disabled={!canEdit} onChange={setRelease} description="A person can ask, but an owner or security admin has to approve it." />
              </div>
            </Card>
            <Card title="Domains" description="One domain per line.">
              <div className="space-y-3">
                <Field label="Blocked domains" hint="Mail from these is treated as a threat."><textarea className={textareaClass} rows={3} spellCheck={false} value={block} onChange={e => setBlock(e.target.value)} /></Field>
                <Field label="Domains mail can't be sent to" hint="Sender policy. Applies to every mailbox in this workspace, including rules and delegated sends."><textarea className={textareaClass} rows={3} spellCheck={false} value={outbound} onChange={e => setOutbound(e.target.value)} /></Field>
                <Field label="Allowed domains" hint="Mail from these gets less scrutiny. Public mail domains are refused, because anyone can get an address there."><textarea className={textareaClass} rows={3} spellCheck={false} value={allow} onChange={e => setAllow(e.target.value)} /></Field>
                <Field label="Protected domains" hint="Addresses that look like these are flagged as lookalikes. Add your own domains and key partners."><textarea className={textareaClass} rows={3} spellCheck={false} value={prot} onChange={e => setProt(e.target.value)} /></Field>
              </div>
            </Card>
            <Card title="Mail handling">
              <div className="divide-y divide-line">
                <Toggle label="Move bulk mail to Spam" checked={bulk} disabled={!canEdit} onChange={setBulk} description="Newsletters and other bulk mail go to Spam instead of staying in the inbox." />
                <Toggle label="Block remote images" checked={images} disabled={!canEdit} onChange={setImages} description="Remote images can reveal when someone opens a message and their IP address. People can still load them one message at a time." />
              </div>
            </Card>
            <Card title="Data and AI">
              <div className="space-y-3">
                <Field label="Retention in days" hint="Cached mail older than this is deleted from this service. Leave empty to keep it while a mailbox is connected. This doesn't change your mail provider's copy." error={retentionError}><input type="number" min={1} max={3650} inputMode="numeric" className={inputClass} value={retention} onChange={e => setRetention(e.target.value)} /></Field>
                <Toggle label="Turn off hosted AI models" checked={hostedOff} disabled={!canEdit} onChange={setHostedOff} description="No one's mail text goes to a hosted model: not for security review, and not for summaries or drafts. Rules on this deployment still work." />
              </div>
            </Card>
          </fieldset>
          {save.error && <Banner tone="danger">{save.error.message}</Banner>}
          {canEdit && <Button type="submit" variant="primary" icon={Save} loading={save.isPending}>Save policy</Button>}
        </form>
      )}
      {data && <div className="mt-4"><KeyRotation /></div>}
    </>
  );
}
