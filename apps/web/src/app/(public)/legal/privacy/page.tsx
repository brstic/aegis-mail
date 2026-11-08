import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/marketing/legal";
import { REPO_URL } from "@/components/marketing/site";

export const metadata: Metadata = { title: "Privacy", description: "How Aegis Mail handles data: who controls an instance, when mail is read, what is kept and for how long, optional services, and deletion." };

const SECTIONS = [
  { id: "who", label: "Who controls your data" },
  { id: "when-read", label: "When and where a message is read" },
  { id: "ai-vendors", label: "Whether a hosted AI model receives content" },
  { id: "training", label: "Whether email is used to train models" },
  { id: "retention", label: "What is kept, why, and for how long" },
  { id: "plaintext-access", label: "Who can access your mail" },
  { id: "admins", label: "What organization admins see" },
  { id: "disconnect", label: "Disconnecting and deleting" },
  { id: "rights", label: "Your choices" },
  { id: "services", label: "Optional external services" },
  { id: "website", label: "This website" },
  { id: "changes", label: "Changes to this page" },
];

export default function PrivacyPage() {
  return (
    <LegalPage title="How Aegis Mail handles data" updated="2026-11-08" sections={SECTIONS} intro={<p>Aegis Mail is open source software that people run on their own servers. This page explains what the software does with your data: when your mail is read and why, what is kept, who can see it, and how to delete it.</p>}>
      <h2 id="who">Who controls your data</h2>
      <p>Whoever runs an Aegis Mail instance operates it and controls its data: you, your organization, or the person who invited you. Mail and account data stay on the servers they choose, and the Aegis Mail project receives none of it. Questions about a particular instance, such as where it runs or how long its backups are kept, go to the people who run it.</p>

      <h2 id="when-read">When and where a message is read</h2>
      <p>Your mail stays with your provider, such as Gmail, Outlook or iCloud. After you connect a mailbox, the instance fetches messages from that provider, starting with the last 30 days of mail.</p>
      <ul>
        <li><strong>Background workers</strong> read each message as it arrives, in server memory, to check it for threats, rank it and index it for search. This continues while the mailbox is connected, including when you aren&apos;t using the app.</li>
        <li><strong>Application servers</strong> read a message in memory when you open it, search for it, or ask for a summary or draft.</li>
        <li><strong>Your browser</strong> displays the message.</li>
        <li><strong>Attachments</strong> are unpacked and inspected, and checked by a malware scanner where one is configured.</li>
      </ul>
      <p>Messages are stored encrypted. In managed processing, the servers can decrypt them, because that&apos;s how protection and search work.</p>

      <h2 id="ai-vendors">Whether a hosted AI model receives content</h2>
      <p>Not by default. AI features start with processing that runs inside the instance, and nothing leaves it for this purpose. A hosted model receives message content only if the instance has one configured, and you turn it on and give consent. When it&apos;s on, the content needed for that feature is sent to the model&apos;s provider under that provider&apos;s API terms, including its retention terms. You can turn it off at any time, and the Privacy Center shows whether a hosted model is active, and which one.</p>

      <h2 id="training">Whether email is used to train models</h2>
      <p>Aegis Mail doesn&apos;t train models on your email. Your feedback, such as marking a sender as important, changes your own ranking and isn&apos;t shared with other users or organizations. If you turn on a hosted model, its provider&apos;s terms govern what it does with what it receives.</p>

      <h2 id="retention">What is kept, why, and for how long</h2>
      <ul>
        <li><strong>Message content, metadata and analysis</strong> are kept until you delete them, or until your organization&apos;s retention period removes them. Disconnecting a mailbox without choosing to delete keeps what&apos;s stored until you delete it. Organizations can set a retention period in days. When it passes, bodies and search words are removed, and a minimal record stays so that sync doesn&apos;t bring the message back.</li>
        <li><strong>The search index</strong> stores words from subjects and bodies, plus sender and recipient names and addresses, in plaintext so server search is fast. You can turn it off, and the index is removed.</li>
        <li><strong>Credentials</strong>, meaning OAuth tokens and app passwords, are stored encrypted until you disconnect.</li>
        <li><strong>Account data</strong>, meaning your name, email and sign-in methods, is kept until you delete your account.</li>
        <li><strong>Audit events</strong> are kept for security and accountability. They contain no message content.</li>
        <li><strong>Aggregated telemetry</strong> is kept to operate the instance. It contains no message identity or body content.</li>
        <li><strong>Database backups</strong> are made and kept by whoever runs the instance, on their own schedule.</li>
      </ul>

      <h2 id="plaintext-access">Who can access your mail</h2>
      <h3>Managed processing (the default)</h3>
      <p>Administration is content-blind, and processing happens on the server. Application servers and background workers handle plaintext in memory to protect, rank and search your mail. No administrator screen, API or database role gives organization administrators message content. Because servers process mail in memory, this mode is not zero-knowledge: it relies on how the people who run the instance control access to its servers.</p>
      <h3>Client-sealed cache</h3>
      <p>You can seal individual messages in your browser with a key derived from your passphrase, and the server can&apos;t decrypt them. Sealing covers the message text, not attachments, subject or sender. Messages are checked before they&apos;re sealed, and sealed messages are left out of search. The instance still holds your provider connection and delivers the app&apos;s code, so this mode protects your stored mail against database and backup exposure, while you continue to rely on the people who run the instance.</p>
      <h3>In every mode</h3>
      <p>Your mail provider keeps its own access to your mail. If you turn on a hosted AI model, it sees what&apos;s sent to it. The <Link href="/privacy-architecture#matrix">privacy architecture</Link> compares the modes side by side.</p>

      <h2 id="admins">What organization admins see</h2>
      <p>Administrators of an organization workspace see aggregate security counts, such as how many messages were held or reported, along with policy changes and audit events. Owners and security admins also see a list of blocked messages: which mailbox and person each was for, when it arrived and why it was held. They can release one or move it to trash. No administrator feature shows the subject, sender, body or attachments of someone else&apos;s message, and automated tests check this. The codes used in telemetry are fixed and contain no content.</p>

      <h2 id="disconnect">Disconnecting and deleting</h2>
      <ul>
        <li><strong>Disconnect a mailbox and choose to delete:</strong> the provider grant is revoked where the provider supports it, and otherwise the app shows you the steps. Bodies, metadata, search words, tasks, drafts and analyses for that mailbox are deleted immediately. Credentials are destroyed moments later, once the grant has been revoked.</li>
        <li><strong>Revoke access at your provider:</strong> sync stops, and the account is marked as needing to reconnect. Data already stored stays until you disconnect and delete it, or until retention removes it.</li>
        <li><strong>Delete your account:</strong> credentials and content are deleted. For a personal workspace, its encryption keys are destroyed, which makes any remaining ciphertext in the live database unreadable. Audit events are kept: they still reference your internal account ID, but the name and email behind it are erased. Aggregated telemetry is kept.</li>
        <li><strong>Backups:</strong> a backup taken before a deletion holds its own copy of the wrapped keys, so that data stays recoverable until the backup expires, on the schedule the instance&apos;s operators set.</li>
        <li><strong>Your provider:</strong> none of these actions delete mail from your provider&apos;s mailbox, apart from actions you take on individual messages.</li>
      </ul>

      <h2 id="rights">Your choices</h2>
      <p>You can export the conversations you can see, as a JSON file, and delete your account from the Privacy Center. If you&apos;re the only owner of an organization, you hand over ownership first. For anything else about your data on an instance, ask the people who run it.</p>

      <h2 id="services">Optional external services</h2>
      <p>An instance runs on its own with its database, web app and background worker. Its operators can also connect outside services, such as a hosted AI model, a key management service for the root key, or a relay for sign-in and invitation email. The <Link href="/trust#services">trust center</Link> lists each one and what it receives. Signed in, the Privacy Center shows the ones in use on your instance.</p>

      <h2 id="website">This website</h2>
      <p>The Aegis Mail website runs no analytics, advertising or tracking scripts. Its content security policy lets pages load scripts and make connections only to the site itself. Your light or dark theme choice is saved in your browser&apos;s local storage, and the interactive demos run in your browser on made-up mail. A cookie is set only when you sign in, to keep you signed in.</p>

      <h2 id="changes">Changes to this page</h2>
      <p>This page changes when the software does, and the date at the top changes with it. Every change to the software is recorded in the <a href={REPO_URL}>repository</a>.</p>
    </LegalPage>
  );
}
