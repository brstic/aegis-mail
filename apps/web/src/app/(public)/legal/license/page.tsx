import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/marketing/legal";
import { LICENSE_URL, REPO_URL } from "@/components/marketing/site";

export const metadata: Metadata = { title: "License", description: "Aegis Mail is free and open source under the GNU Affero General Public License, version 3: what that lets you do, and what it asks of you." };

const SECTIONS = [
  { id: "freedoms", label: "What you can do" },
  { id: "sharing", label: "Sharing copies and changes" },
  { id: "network", label: "Running a changed version for others" },
  { id: "warranty", label: "No warranty" },
  { id: "instance", label: "Running your own instance" },
  { id: "text", label: "The full license" },
];

export default function LicensePage() {
  return (
    <LegalPage title="License" updated="2026-11-08" sections={SECTIONS} intro={<p>Aegis Mail is free and open source software, released under the <a href={LICENSE_URL} className="text-accent underline underline-offset-2">GNU Affero General Public License, version 3</a> (AGPL-3.0). This page explains it in plain language. It&apos;s a summary, not legal advice, and where it differs from the license, the license decides.</p>}>
      <h2 id="freedoms">What you can do</h2>
      <p>You can run Aegis Mail for any purpose, on as many servers as you like, at no cost. You can read the source code, study how it works, change it, and share it, as it is or with your changes.</p>

      <h2 id="sharing">Sharing copies and changes</h2>
      <p>If you give a copy to someone else, changed or not, you give it under the same license, with its source code, and keep the copyright and license notices. Anyone who receives it gets the same freedoms you have.</p>

      <h2 id="network">Running a changed version for others</h2>
      <p>This is what makes the license &ldquo;Affero&rdquo;. If you change Aegis Mail and let other people use your changed version over a network, you offer those people the source code of your version, under the same license. Running it unchanged, you can point people to the <a href={REPO_URL}>original repository</a>.</p>

      <h2 id="warranty">No warranty</h2>
      <p>The software is provided as it is, without warranty of any kind, and to the extent the law allows, its authors aren&apos;t liable for damages from using it. Sections 15 and 16 of the license say this exactly.</p>

      <h2 id="instance">Running your own instance</h2>
      <p>Whoever runs an instance of Aegis Mail operates it: they decide where it runs, which optional services it uses, and who can sign in. The <Link href="/legal/privacy">privacy page</Link> explains what the software does with mail and account data. Your mail provider&apos;s own terms still apply to each mailbox you connect.</p>

      <h2 id="text">The full license</h2>
      <p>The complete text is in the <a href={LICENSE_URL}>LICENSE file</a> in the repository. The libraries Aegis Mail uses keep their own licenses.</p>
    </LegalPage>
  );
}
