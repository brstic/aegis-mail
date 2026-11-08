import { Mini } from "@/film/mini/Mini";
import type { Metadata } from "next";
import Link from "next/link";
import { Kbd } from "@/components/ui";
import { ClosingCta, Container, More, Note, PageIntro, proseClass, ResponsiveTable } from "@/components/marketing/primitives";
import { README_URL, REPO_URL } from "@/components/marketing/site";

export const metadata: Metadata = { title: "Docs", description: "Self-hosting Aegis Mail, your first five minutes, connecting Gmail, Outlook, iCloud and IMAP, keyboard shortcuts and search operators." };

const TOC = [
  { href: "#self-host", label: "Self-host" },
  { href: "#getting-started", label: "Your first five minutes" },
  { href: "#gmail", label: "Connect Gmail" },
  { href: "#outlook", label: "Connect Outlook" },
  { href: "#icloud", label: "Connect iCloud Mail" },
  { href: "#imap", label: "Connect other IMAP mail" },
  { href: "#shortcuts", label: "Keyboard shortcuts" },
  { href: "#search", label: "Search operators" },
  { href: "#administrators", label: "For administrators" },
];

const SHORTCUTS: [string, string][] = [
  ["j / k", "Next / previous conversation"], ["o or Enter", "Open"], ["u", "Back to the list"], ["e", "Archive"], ["#", "Move to Trash"], ["s", "Star or unstar"],
  ["Shift+u", "Mark unread"], ["r", "Reply"], ["c", "Compose"], ["/", "Search"], ["x", "Select conversation"], ["i", "Show or hide the summary"],
  ["a", "Assistant"], ["g then f", "Go to Focus"], ["g then i", "Go to Inbox"], ["?", "Show shortcuts"],
];

const OPERATORS: [string, string][] = [
  ["from:priya", "From a sender"], ["to:morgan", "Sent to someone"], ["subject:invoice", "Word in the subject"], ['"exact phrase"', "Exact words"],
  ["after:2026/10/01", "On or after a date"], ["before:2026/11/01", "Before a date"], ["has:attachment", "Has an attachment"],
  ["is:unread", "Unread"], ["is:read", "Read"], ["is:flagged", "Starred"], ["risk:suspicious", "Has a risk label"], ["priority:needs_attention", "In a Focus section"],
  ["label:clients", "Has a label"], ["account:work", "In one account"],
];

export default function DocsPage() {
  return (
    <>
      <PageIntro title="Get set up." visual={<Mini scene="flow" className="hidden h-72 sm:block" props={{ sources: ["Your mailbox", "Another one"], into: "Your workspace" }} />}>
        <p>Run it on your own server, create your account, then connect each mailbox you use. The AI starts protecting every message from the moment it arrives.</p>
      </PageIntro>
      <Container className="py-12 sm:py-16">
        <div className="grid gap-10 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-14">
          <nav aria-label="On this page" className="lg:sticky lg:top-24 lg:self-start">
            <h2 className="text-sm font-semibold">On this page</h2>
            <ul className="mt-2 space-y-1.5 text-[15px]">
              {TOC.map(t => <li key={t.href}><a href={t.href} className="text-muted underline-offset-2 hover:text-ink hover:underline">{t.label}</a></li>)}
            </ul>
          </nav>

          <div className={`min-w-0 max-w-3xl ${proseClass} [&>h2:first-child]:mt-0`}>
            <h2 id="self-host">Self-host</h2>
            <p>Aegis Mail is free and open source under the AGPL-3.0. You run it on your own server, and the mail it fetches is kept in your own database.</p>
            <ol>
              <li>Clone the <a href={REPO_URL}>repository</a> from GitHub onto your server.</li>
              <li>Copy <code>infra/docker/selfhost.env.example</code> to <code>.env</code> and fill it in: the address people will use, database passwords, a root key in AWS KMS, and the mail providers you want to offer.</li>
              <li>Run <code>docker compose up -d --build</code>. It starts the database, the malware scanner, the web app and the background worker, and sets up the database. Put a reverse proxy with TLS in front of it.</li>
              <li>Create your account and connect a mailbox, as described below. Gmail and Outlook need a Google or Microsoft OAuth app registered for your instance. iCloud and other IMAP mail need nothing extra.</li>
            </ol>
            <p>Want to look around first? <code>docker compose -f infra/docker/compose.yml up --build</code> runs a demo on synthetic mail at <code>http://localhost:3000</code>. The <a href={README_URL}>README</a> has the full steps.</p>

            <h2 id="getting-started">Your first five minutes</h2>
            <ol>
              <li>Create your account on your instance with an email and password. Then add a passkey or an authenticator app in Security settings.</li>
              <li>Choose a personal or an organization workspace. Either way, your mail is sealed under your workspace&apos;s own keys. <Link href="/privacy-architecture">See how</Link>.</li>
              <li>Connect your first mailbox with the steps below. Google and Microsoft show you exactly what you&apos;re allowing before you approve.</li>
              <li>Open Focus. Every message shows why it&apos;s where it is, and the order gets better as you correct it.</li>
              <li>Prefer plain email? Turn off AI organization for a simple, chronological Inbox.</li>
            </ol>
            <Note title="When new mail shows up">New mail appears moments after your provider receives it: about a minute for Gmail and Outlook, and a few minutes for mailboxes that are checked on a schedule.</Note>

            <h2 id="gmail">Connect Gmail or Google Workspace</h2>
            <p>Sign in with Google and approve access. Your Google password stays with Google.</p>
            <ul>
              <li><strong>Read-only</strong> lets Aegis Mail read and protect your mail without changing anything (the <code>gmail.readonly</code> permission).</li>
              <li><strong>Full access</strong> adds labels, drafts and sending (<code>gmail.modify</code>). It can&apos;t permanently delete mail.</li>
              <li>Every new message is checked as soon as Gmail delivers it.</li>
            </ul>

            <h2 id="outlook">Connect Outlook or Microsoft 365</h2>
            <p>Sign in with Microsoft and approve access. Access covers your own mailbox only. Outlook addresses always connect through Microsoft sign-in, so you never type your Microsoft password here.</p>
            <ul>
              <li>Work and school accounts may need your IT admin to approve the app once.</li>
              <li>Every new message is checked as soon as Microsoft delivers it.</li>
              <li>To disconnect completely, also remove Aegis Mail from the app permissions in your Microsoft account.</li>
            </ul>

            <h2 id="icloud">Connect iCloud Mail</h2>
            <Note title="iCloud uses an app-specific password">Sign in with Apple identifies you to websites, but it doesn&apos;t open your mail to apps. iCloud Mail connects with an app-specific password from Apple instead. It takes about a minute.</Note>
            <ol>
              <li>Make sure two-factor authentication is on for your Apple Account. Apple requires it for app-specific passwords.</li>
              <li>Sign in to your Apple Account on Apple&apos;s website, open Sign-In and Security, and choose App-Specific Passwords.</li>
              <li>Generate a new password and give it a name you&apos;ll recognize, such as &quot;Aegis Mail&quot;. Copy it. Apple shows it once.</li>
              <li>In the app, go to Settings, then Accounts, and add an account. Choose iCloud and enter your iCloud address and the app-specific password. Use the app-specific password, not your Apple Account password.</li>
              <li>Confirm the server settings below, then connect.</li>
            </ol>
            <div className="mt-5"><ResponsiveTable caption="iCloud Mail server settings" corner="Setting" columns={["Incoming (IMAP)", "Outgoing (SMTP)"]} rows={[
              { label: "Server", cells: ["imap.mail.me.com", "smtp.mail.me.com"] },
              { label: "Port", cells: ["993", "587"] },
              { label: "Security", cells: ["SSL/TLS", "STARTTLS"] },
              { label: "Username", cells: ["Usually the part before the @. If that fails, try the full address.", "Your full address"] },
            ]} /></div>
            <ul>
              <li>New mail appears within about 2 minutes.</li>
              <li>To disconnect at Apple&apos;s end, delete the app-specific password in your Apple Account.</li>
            </ul>

            <h2 id="imap">Connect other IMAP mail</h2>
            <p>Most mail hosts work over IMAP and SMTP with TLS. Many ask for an app password rather than your normal one. The app suggests settings for common hosts, and you confirm them before connecting.</p>
            <div className="mt-5"><ResponsiveTable caption="Support by provider" corner="Provider" columns={["How it connects", "New mail"]} rows={[
              { label: "Yahoo", cells: ["imap.mail.yahoo.com:993 and smtp.mail.yahoo.com:465 or 587, with an app password", "About 2 minutes"] },
              { label: "Fastmail", cells: ["imap.fastmail.com:993 and smtp.fastmail.com, with an app password. IMAP access may depend on your Fastmail plan.", "About 2 minutes"] },
              { label: "Zoho, cPanel, Plesk, self-hosted", cells: ["IMAP and SMTP settings from your host", "About 5 minutes"] },
              { label: "POP3", cells: ["Imports your mail. Folders, labels and read status stay with your provider, and you send from another connection.", "About 15 minutes"] },
              { label: "Proton", cells: [{ verdict: "no", verdictLabel: "Not available", text: "Proton Mail connects only through its Bridge app on your own computer." }, "Not applicable"] },
            ]} /></div>
            <p>To disconnect at your host&apos;s end, delete the app password there.</p>

            <h2 id="shortcuts">Keyboard shortcuts</h2>
            <p>These work inside the app, except while you&apos;re typing in a field.</p>
            <dl className="mt-5 grid gap-x-8 sm:grid-cols-2">
              {SHORTCUTS.map(([k, d]) => (
                <div key={k} className="flex items-center justify-between gap-4 border-b border-line py-2 text-[15px]">
                  <dt className="order-2 shrink-0"><Kbd>{k}</Kbd></dt>
                  <dd className="order-1">{d}</dd>
                </div>
              ))}
            </dl>

            <h2 id="search">Search operators</h2>
            <p>Combine operators with plain words. Anything that isn&apos;t an operator is searched as words. You can turn server search off in your privacy settings.</p>
            <dl className="mt-5">
              {OPERATORS.map(([k, d]) => (
                <div key={k} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-line py-2 text-[15px]">
                  <dt className="order-2 [overflow-wrap:anywhere]"><code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[13px]">{k}</code></dt>
                  <dd className="order-1">{d}</dd>
                </div>
              ))}
            </dl>

            <h2 id="administrators">For administrators</h2>
            <p>Setting up Aegis Mail for a team, or running your own deployment? The details are here.</p>
            <More label="Show administrator details" align="start">
              <ul className="list-disc space-y-2 pl-5">
                <li><strong>Google.</strong> Gmail sign-in appears once a Google OAuth app is configured for the deployment. If people don&apos;t see the Gmail option, that&apos;s the step to finish.</li>
                <li><strong>Microsoft.</strong> Your Microsoft 365 tenant settings may require admin consent for the app before people can connect.</li>
                <li><strong>Disconnecting Microsoft accounts.</strong> Disconnecting deletes the stored token right away. Microsoft handles delegated app access in each person&apos;s account settings, which is where the last step happens.</li>
                <li><strong>Network safety.</strong> Mail server settings that point at private or internal network addresses are refused, so a mailbox connection can never reach inside your network.</li>
              </ul>
            </More>
          </div>
        </div>
      </Container>
      <ClosingCta title="Ready when you are." />
    </>
  );
}
