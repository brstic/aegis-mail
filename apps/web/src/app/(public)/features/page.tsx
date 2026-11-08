import { Mini } from "@/film/mini/Mini";
import type { Metadata } from "next";
import Link from "next/link";
import { cardClass, Container, CtaPair, More, PageIntro, Point, Section } from "@/components/marketing/primitives";

export const metadata: Metadata = { title: "Features", description: "AI protection that opens every message and attachment, one inbox for every account, Focus, and AI drafts you approve." };

export default function FeaturesPage() {
  return (
    <>
      <PageIntro title="Email, guarded by AI." visual={<Mini scene="flow" className="hidden h-80 sm:block" props={{ sources: ["Gmail", "Outlook", "iCloud & IMAP"], into: "One list" }} />}>
        <p>Everything you expect from email, with an AI that reads every message and opens every file first.</p>
      </PageIntro>

      <Container className="pb-20 sm:pb-28">
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["AI protection", "Phishing, malicious scripts and PDFs carrying exploits, held before you open them."],
            ["Every file, opened", "PDFs, Office files, web pages and scripts unpacked and read. Nothing is ever run."],
            ["One inbox", "Gmail, Outlook, iCloud and IMAP, together. Each row still shows its account."],
            ["Focus", "What needs you, in order. Every position comes with a reason."],
            ["Security you can read", "Every warning lists what raised it, in plain words."],
            ["Nothing lost", "Held mail is kept safely, never deleted, and anything held by mistake can be restored."],
            ["AI you approve", "It drafts, and you send. Or turn it off."],
            ["Sealed at rest", "Your mail is encrypted under your workspace's own keys."],
          ].map(([t, d]) => <li key={t} className={cardClass}><h2 className="font-display text-[1.375rem] leading-tight">{t}</h2><p className="mt-2 text-[16px] leading-snug text-muted">{d}</p></li>)}
        </ul>
        <CtaPair className="mt-10" />
      </Container>
      <More label="Everything it does">
      <Section id="protection" title="AI that stops what's built to hurt you.">
        <div className="grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          <Point title="Exploit PDFs">Every stream is decompressed and read. Scripts that run on open, launch commands, hidden programs and reader exploits are found, and the message is held.</Point>
          <Point title="Malicious documents">Macros, remote templates, Follina-style links, command fields and Equation Editor exploits in Office and RTF files.</Point>
          <Point title="Fake sign-in pages">HTML attachments that open a login form, HTML smuggling, and SVG images that carry a script.</Point>
          <Point title="Scripts and programs">Disguised executables, double extensions, scripts that download and run, archives hiding a program.</Point>
          <Point title="Phishing and fraud">Lookalike domains, forged senders, payment-change requests, gift-card scams and links that lie about where they go.</Point>
          <Point title="An AI that judges">A model reviews each message and what was found inside its files. It can raise the risk, and a fixed policy decides what happens.</Point>
        </div>
      </Section>

      <Section id="workspace" tone="surface" title="One workspace for all your mailboxes.">
        <div className="grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          <Point title="Many accounts, one list">Gmail and Outlook connect by OAuth. iCloud and other IMAP hosts connect with an app password. Each row shows which account it belongs to.</Point>
          <Point title="Familiar mail">Threads, labels, archive, star, search, drafts and trash work the way you expect. Keyboard shortcuts cover the daily actions.</Point>
          <Point title="The right sending address">The composer always shows which address you&apos;re sending from, and the server checks it against the account before it sends.</Point>
          <Point title="Search with operators">Filter by sender, date, attachment, risk, account and more. <Link href="/docs#search">See the operators</Link>.</Point>
          <Point title="Clear sync status">Each account shows its sync state and when it last succeeded.</Point>
          <Point title="Reversible actions">AI organization never hides a destructive action. Held mail can be restored, and every decision is recorded.</Point>
        </div>
      </Section>

      <Section id="focus" title="Focus: what needs you, and why.">
        <div className="grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          <Point title="Clear sections">Needs your attention, Security review, Today&apos;s commitments, Important people, Read later, Low priority.</Point>
          <Point title="Reasons on every message">Rankings come from stored signals such as how often you correspond, whether you were asked something, and dates in the message. You can read them.</Point>
          <Point title="Security comes first">A flagged message drops out of the ranking entirely. Writing URGENT doesn&apos;t move a scam up the list.</Point>
          <Point title="Your feedback stays yours">Marking a sender important or not affects your own view, and no one else&apos;s.</Point>
          <Point title="Rules with approvals">Describe an automation, try it as a dry run, and approve what it proposes.</Point>
          <Point title="Off switch">Turn off AI organization and the Inbox is simply chronological.</Point>
        </div>
      </Section>

      <Section id="ai" tone="surface" title="AI that helps, and asks first.">
        <div className="grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          <Point title="Summaries, tasks and drafts">Summarize a thread, pull out tasks, and draft a reply that you edit and approve. Nothing sends itself.</Point>
          <Point title="Private by default">Hosted models only see content once you turn them on. Your email is never used to train models.</Point>
          <Point title="Email is treated as data">Text in a message can&apos;t instruct the assistant. Hidden text is screened for injection attempts, and the model has no tool to send, forward or delete.</Point>
          <Point title="Off switch">Every AI feature can be turned off on its own.</Point>
        </div>
      </Section>

      <Section id="teams" title="For organizations.">
        <div className="grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          <Point title="Roles and invitations">Invite people, set roles, and keep personal and work workspaces separate.</Point>
          <Point title="Security policy">Choose what gets blocked, blocked and allowed domains, and protected domains for lookalike checks.</Point>
          <Point title="Security Center and audit log">Aggregate threat counts, policy changes and audit events, with no message content.</Point>
        </div>
      </Section>

      </More>
    </>
  );
}
