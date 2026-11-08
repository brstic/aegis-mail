import type { Metadata } from "next";
import Link from "next/link";
import { cardClass, ClosingCta, More, PageIntro, Section } from "@/components/marketing/primitives";
import { REPO_URL } from "@/components/marketing/site";

export const metadata: Metadata = { title: "Trust center", description: "How your mail is protected: isolation between workspaces, encryption at rest, AI that acts only with your approval, optional external services and responsible disclosure." };

const GUARANTEES: [string, string][] = [
  ["Your workspace is yours alone", "Row-level security separates every workspace in the database, enforced under restricted logins and checked by automated tests."],
  ["Admins manage policy, not mail", "Organization admins see policy, counts and audit events. Message content stays sealed from them, in the database and in the API."],
  ["Encrypted at rest", "Subjects, bodies, participants and attachments are encrypted under per-workspace keys, wrapped by a root key."],
  ["AI that works for you, only with your approval", "Instructions hidden in email are ignored, and the assistant has no tool to send, forward or delete on its own. Tested against a set of prompt-injection samples."],
  ["Hostile files stay contained", "Attachments are parsed on an isolated thread with size and time limits, and are never opened or run."],
  ["Connections stay on the public internet", "Mail server settings are checked, so they only ever reach public addresses, never private or internal networks."],
];

export default function TrustPage() {
  return (
    <>
      <PageIntro title="Built to be trusted with your mail.">
        <p>How your mail is kept apart, kept sealed, and kept out of reach.</p>
      </PageIntro>

      <Section id="protections" title="What protects you.">
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {GUARANTEES.map(([t, d]) => (
            <li key={t} className={cardClass}>
              <h3 className="text-[1.0625rem] font-semibold">{t}</h3>
              <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{d}</p>
            </li>
          ))}
        </ul>
        <p className="mt-10 text-center text-[15px] leading-relaxed text-muted">More on <Link href="/security" className="text-accent underline underline-offset-2">how messages are checked</Link> and <Link href="/privacy-architecture" className="text-accent underline underline-offset-2">how keys work</Link>.</p>
      </Section>

      <More label="Optional services and disclosure">
      <Section id="services" tone="surface" title="Optional services." lead={<p>An instance runs on its own: a database, the web app and a background worker, on servers you choose. Whoever runs it can connect these services too, and each one receives only what&apos;s described here. Signed in, the Privacy Center shows what&apos;s configured on yours.</p>}>
        <ul className="grid gap-x-10 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
          {[
            ["Mail providers", "Gmail, Outlook, iCloud or any IMAP host: the mailboxes people connect, under their own terms. Gmail and Outlook need an OAuth app registered for the instance."],
            ["Hosted AI model", "An Anthropic model, or a compatible endpoint you choose. It receives message content only for people who turn it on and consent."],
            ["Key management", "Holds the root key that wraps every workspace's keys. AWS KMS can hold it."],
            ["Malware scanner", "ClamAV, running as its own service inside the deployment, scans every attachment."],
            ["Email relay", "Sends verification, password reset and invitation email, and the digest for people who turn it on. It never carries anyone's mail."],
            ["Semantic search model", "A small model that runs on your own server, so no mail text leaves it. Its files download once from Hugging Face, unless you provide them."],
            ["Sign-in providers", "Sign in with Google or Microsoft, or an organization's own single sign-on. They confirm who someone is, and never see mail."],
          ].map(([t, d]) => (
            <li key={t}>
              <h3 className="text-base font-semibold">{t}</h3>
              <p className="mt-1 text-[15px] leading-relaxed text-muted">{d}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="disclosure" title="Responsible disclosure.">
        <div className="max-w-2xl space-y-4 text-[15px] leading-relaxed">
          <p>If you find a security problem in Aegis Mail, we want to hear about it. Please report it privately through the <a href={`${REPO_URL}/security`} className="text-accent underline underline-offset-2">repository&apos;s security page</a> on GitHub, and give us reasonable time to fix it before you share details publicly. Don&apos;t access other people&apos;s data, and test only with accounts and mail that you own.</p>
          <p>For a problem with a particular instance, such as its configuration, contact the people who run it.</p>
        </div>
      </Section>
      </More>
      <ClosingCta title="Mail you can trust, from the first message." tone="surface" />
    </>
  );
}
