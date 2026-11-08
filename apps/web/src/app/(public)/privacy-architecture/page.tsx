import { ScrollVault } from "@/film/mini/hosts";
import type { Metadata } from "next";
import { cardClass, ClosingCta, More, PageIntro, Point, ResponsiveTable, Section, type CellLike } from "@/components/marketing/primitives";
import { TrustDiagram } from "@/components/marketing/trust-diagram";

export const metadata: Metadata = { title: "Privacy architecture", description: "How your mail is sealed: per-workspace keys, a client-sealed option, trust boundaries, and what deletion does." };

const y = (text?: string): CellLike => ({ verdict: "yes", text });

const MATRIX: { label: string; cells: CellLike[] }[] = [
  { label: "TLS in transit", cells: [y(), y()] },
  { label: "Encrypted at rest with per-workspace keys", cells: [y(), y()] },
  { label: "No admin UI, API or database role gives admins mail content", cells: [y("Enforced by row-level security and tests."), y()] },
  { label: "Plaintext kept out of logs, jobs and telemetry", cells: [y("Tested."), y()] },
  { label: "Server can't decrypt cached bodies", cells: ["Keys are managed for you, so access can be restored.", y("For sealed bodies.")] },
  { label: "AI protection around the clock", cells: [y("Every message, as it arrives."), "Before sealing."] },
  { label: "Search", cells: ["On the server. Optional.", "In your browser."] },
  { label: "Hosted AI model sees content", cells: ["Only once you turn it on.", "Only by explicit action on one message."] },
];

export default function PrivacyArchitecturePage() {
  return (
    <>
      <PageIntro title="Sealed under your own keys." visual={<ScrollVault keyClasses={["Message bodies", "Metadata", "Search keys", "Credentials"]} rootLabel="Root key, in a KMS" />}>
        <p>Every workspace has its own keys. Mail is opened only to be protected, and stored sealed.</p>
      </PageIntro>

      <Section id="modes" title="Two ways to keep it.">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className={cardClass}>
            <p className="text-[13px] font-medium text-accent">Managed</p>
            <h3 className="mt-1 font-display text-[1.5rem] leading-tight tracking-tight">Protected around the clock</h3>
            <p className="mt-2 text-[15px] leading-relaxed text-muted">Every message is checked as it arrives, then stored encrypted under your workspace&apos;s keys. Admin tools manage policy and see counts, never content.</p>
          </div>
          <div className={cardClass}>
            <p className="text-[13px] font-medium text-accent">Client-sealed</p>
            <h3 className="mt-1 font-display text-[1.5rem] leading-tight tracking-tight">Sealed in your browser</h3>
            <p className="mt-2 text-[15px] leading-relaxed text-muted">Your browser derives a key from a passphrase, seals message bodies after they&apos;re checked, and uploads only ciphertext. The server discards its copy.</p>
          </div>
        </div>
      </Section>

      <More label="The whole architecture">
      <Section id="boundaries" tone="surface" title="Where the trust boundaries are.">
        <TrustDiagram />
      </Section>

      <Section id="matrix" title="Side by side.">
        <ResponsiveTable caption="Privacy by mode" corner="" columns={["Managed", "Client-sealed"]} rows={MATRIX} emphasis={0} />
      </Section>

      <Section id="mode-a" tone="surface" title="Inside managed processing.">
        <div className="grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          <Point title="Encryption">TLS everywhere. AES-256-GCM per record, with per-tenant keys wrapped by a root key held in a key management service outside the database. Subjects and participants are encrypted along with bodies, apart from the search index described below.</Point>
          <Point title="No path for admins or staff">There&apos;s no view-email control, debug endpoint, impersonation mode, hidden export or raw prompt log. Tests check that tenant admins can&apos;t read content.</Point>
          <Point title="Search, your choice">Server search keeps an index of words so results are instant. Turn it off and the index is removed.</Point>
          <Point title="Keys and recovery">Keys are managed for you, so access can be restored after you lose a password.</Point>
          <Point title="See your own setup">The Privacy Center in the app reads the real configuration: processors in use, keys, connected accounts, and AI settings.</Point>
        </div>
      </Section>

      <Section id="deletion" title="What deletion does.">
        <ResponsiveTable
          caption="What happens to each item on disconnect and on account deletion"
          corner="Item"
          columns={["Disconnect and delete", "Account deletion"]}
          rows={[
            { label: "Provider grant", cells: ["Revoked where the provider supports it. Otherwise the app shows instructions.", "Same."] },
            { label: "Credentials", cells: ["Deleted immediately.", "Deleted."] },
            { label: "Bodies, envelopes, search index, tasks, drafts, analyses", cells: ["Deleted immediately.", "Deleted. Tenant keys are destroyed for a personal workspace, which makes its ciphertext in the live database unreadable. Backups are covered below."] },
            { label: "Audit events", cells: ["Retained per policy. They contain no content.", "Retained, with the user ID pseudonymized."] },
            { label: "Aggregated telemetry", cells: ["Retained. Contains no message identity.", "Same."] },
            { label: "Backups", cells: ["Expire on a schedule set by the deployment. A backup taken before a deletion holds its own copy of the wrapped keys, so that data stays recoverable until the backup expires.", "Same."] },
          ]}
        />
      </Section>
      </More>
      <ClosingCta title="Mail that stays yours, guarded by AI." />
    </>
  );
}
