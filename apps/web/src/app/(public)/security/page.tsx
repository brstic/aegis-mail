import { SecurityExplorer } from "@/film/mini/hosts";
import type { Metadata } from "next";
import { AlertTriangle, CircleHelp, ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX } from "lucide-react";
import { cardClass, ClosingCta, Container, More, PageIntro, Section } from "@/components/marketing/primitives";

export const metadata: Metadata = { title: "Security", description: "AI that takes every message apart and opens every attachment: phishing, malicious scripts and exploit PDFs, held before you open them." };

const LAYERS: [string, string][] = [
  ["AI review", "A model reads each message the way an attacker hopes you won't, and judges what the inspector found inside every file. It can raise the risk, never lower it."],
  ["Attachments, opened", "PDFs are decompressed stream by stream, and their scripts, auto-run actions, launch commands, hidden programs and links pulled out. Office files are checked for macros, remote templates and Follina-style links, RTF for Equation Editor exploits, web pages and SVG for fake sign-in forms and HTML smuggling, and scripts for what they download and run."],
  ["Malware signatures", "Attachments are also checked against ClamAV malware signatures. Archives are read without unpacking, so a zip bomb can't stall it."],
  ["Links", "Text that shows one site and goes to another, raw IP addresses, disguised user info, open redirects, shorteners and mixed alphabets. Links inside PDFs and documents, and QR codes in images, are checked the same way."],
  ["Sender identity", "Lookalike and homograph domains, a display name that doesn't match the address, Reply-To on another domain, and a known name writing from a new domain."],
  ["Authentication", "SPF, DKIM and DMARC, read with forwarding and mailing lists in mind. A pass counts for little on its own, because attackers can authenticate their own lookalikes."],
  ["Wording", "Password and account threats, payment-change requests, gift cards, secrecy, callback scams, delivery and tax lures."],
  ["History", "Who you already write to, and who joined a thread. A sender you know still can't slip a payment change past it."],
  ["AI manipulation", "Hidden text, comments, encoded text and attachments are screened for instructions aimed at an AI assistant."],
  ["Policy, outside the model", "The action comes from fixed rules applied to the evidence and your policy. A malware finding sets a floor nothing can talk down."],
];

const LABELS = [
  { icon: ShieldX, label: "Malicious", text: "Strong signs of an attack. Held back, out of your inbox." },
  { icon: ShieldAlert, label: "High risk", text: "Likely phishing or fraud. Held back by default." },
  { icon: AlertTriangle, label: "Be careful", text: "Some warning signs. Delivered, with the reasons shown beside it." },
  { icon: ShieldQuestion, label: "Couldn't verify", text: "Part of the message couldn't be read, so it's never marked safe." },
  { icon: CircleHelp, label: "Bulk", text: "Newsletters and bulk mail. Marked, and moved only if your policy says so." },
  { icon: ShieldCheck, label: "No concerns found", text: "The checks found no warning signs." },
];

const PRINCIPLES: [string, string][] = [
  ["Nothing is ever run", "Files are decoded and read, never opened in a viewer or executed. A hostile file is parsed on an isolated thread with size and time limits."],
  ["Email is data, never instructions", "Every model reads mail inside a randomly named boundary, and has no tool that can send, forward or delete."],
  ["Every verdict shows its evidence", "Each finding is written in plain language, with the weight it carried. You can always see why."],
  ["Held, never deleted", "What the AI holds back is kept safely. In an organization, your admin can restore anything held by mistake, and every restore is recorded."],
];

export default function SecurityPage() {
  return (
    <>
      <PageIntro title="AI that opens your mail first.">
        <p>Phishing, malicious scripts, PDFs carrying exploits. Every message is taken apart and every file is opened before you see it, and what&apos;s built to hurt you is held back.</p>
      </PageIntro>

      <Section id="layers" title="Every part, read on its own.">
        <SecurityExplorer />
        <More label="All the checks">
        <ol className="grid gap-x-10 gap-y-6 lg:grid-cols-2">
          {LAYERS.map(([t, d], i) => (
            <li key={t} className="flex gap-4 border-t border-line pt-4">
              <span aria-hidden className="w-6 shrink-0 font-display text-xl leading-6 text-muted">{i + 1}</span>
              <div>
                <h3 className="text-base font-semibold">{t}</h3>
                <p className="mt-1 text-[15px] leading-relaxed text-muted">{d}</p>
              </div>
            </li>
          ))}
        </ol>
        </More>
      </Section>

      <Section id="principles" tone="surface" title="Built so an attacker has nothing to work with.">
        <dl className="grid gap-4 sm:grid-cols-2">
          {PRINCIPLES.map(([t, d]) => (
            <div key={t} className={`${cardClass} bg-bg`}>
              <dt className="text-[1.0625rem] font-semibold">{t}</dt>
              <dd className="mt-1.5 text-[15px] leading-relaxed text-muted">{d}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Container className="pt-16 sm:pt-20">
        <More label="What the ratings mean">
          <div id="labels" className="scroll-mt-20 pb-4">
            <div className="mx-auto max-w-3xl text-center">
              <h2 className="font-display text-[2rem] leading-[1.1] text-balance sm:text-[3rem]">What the labels mean.</h2>
              <p className="mt-4 text-[17px] leading-[1.5] text-muted sm:text-[19px]">Risk is always shown with a word and an icon, never color alone. Your organization decides which labels are held back.</p>
            </div>
            <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {LABELS.map(l => {
                const I = l.icon;
                return (
                  <li key={l.label} className={cardClass}>
                    <p className="flex items-center gap-2 text-[1.0625rem] font-semibold"><I className="size-4 shrink-0" aria-hidden />{l.label}</p>
                    <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{l.text}</p>
                  </li>
                );
              })}
            </ul>
          </div>
        </More>
      </Container>

      <ClosingCta title="Let the AI open it first." />
    </>
  );
}
