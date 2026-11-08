import Link from "next/link";
import { headers } from "next/headers";
import type { CSSProperties, ReactNode } from "react";
import { CtaLink, GitHubCta } from "@/components/marketing/primitives";
import { durOf, FILM_MODE_CHECK, type ChapterId } from "../store";
import "../film.css";
import { DetailSheet, SenderChoice, SourceToggles } from "./Controls";
import { FilmClient } from "./FilmClient";
import { AutopsyPanel, CasePanel, FocusPanel, GlassPanel, ScalePanel, UvPanel, VaultPanel, XrayPanel } from "./Panels";

const STILL_ALT: Record<ChapterId, string> = {
  flurry: "Hundreds of white envelopes tumbling above a surface.",
  stream: "Envelopes in three lanes, one each for Gmail, Outlook, and iCloud and IMAP, closing into one stream.",
  seals: "An envelope carrying three blue seals marked SPF, DKIM and DMARC.",
  autopsy: "A letter separated into floating layers, each labelled with what's checked.",
  xray: "An invoice PDF opened into four layers, a blue scan passing through them, and a red script pulled out in front.",
  uv: "A violet lamp over a letter, showing hidden text in the white space between its lines.",
  scale: "A metal balance tipped heavily by labelled red weights, with the verdict Malicious at its foot.",
  case: "A letter held in a glass case on a plinth labelled Blocked.",
  focus: "Letters on shelves labelled by priority, with a separate tray for security review.",
  glass: "A draft inside a sealed glass case with a point of light beside it, and a blue Send button outside the case.",
  vault: "A page of noise, beside a closed vault under a large metal key.",
  calm: "A straight row of envelopes on an empty surface, and one small stack.",
};

/** In the plain page, a frame from the film. Hidden in film mode, and lazily loaded, so nobody watching the film downloads it. */
// Some frames were composed for the film, with text beside them, so their subject sits off to one side. On the plain page they
// stand alone under the text, so they're cropped to the subject: x, y, width and height, as fractions of the frame.
const STILL_CROP: Partial<Record<ChapterId, [number, number, number, number]>> = { stream: [0.43, 0.37, 0.57, 0.36] };

function Still({ id }: { id: ChapterId }) {
  const crop = STILL_CROP[id];
  // eslint-disable-next-line @next/next/no-img-element -- Prerendered frames, sized here. They don't need the image optimizer.
  const img = <img src={`/film/${id}.jpg`} alt={STILL_ALT[id]} width={1200} height={750} loading="lazy" style={crop ? { position: "absolute", width: `${100 / crop[2]}%`, maxWidth: "none", left: `${(-crop[0] / crop[2]) * 100}%`, top: `${(-crop[1] / crop[3]) * 100}%` } : undefined} />;
  return <div className="beat-inner"><figure className="film-still" style={crop ? { position: "relative", aspectRatio: `${crop[2] * 1200} / ${crop[3] * 750}` } : undefined}>{img}</figure></div>;
}

function Chapter({ id, label, children }: { id: ChapterId; label: string; children: ReactNode }) {
  return <section id={id} data-chapter={id} aria-label={label} className="chapter" style={{ "--dur": durOf(id) } as CSSProperties}>{children}<Still id={id} /></section>;
}

/** A piece of copy, pinned while the scroll is between `a` and `b` of its chapter. */
function Beat({ a = 0, b = 1, place = "left", wide, first, children }: { a?: number; b?: number; place?: "left" | "right" | "center"; wide?: boolean; first?: boolean; children: ReactNode }) {
  return (
    <div className={`beat ${place}${first ? " live first" : ""}`} style={{ "--a": a, "--b": b } as CSSProperties}>
      <div className="beat-inner"><div className={`copy${wide ? " wide" : ""}`}>{children}</div></div>
    </div>
  );
}

/** Words that only make sense with the film running, such as moving the lamp. The plain page has a button for the same thing. */
const FilmOnly = ({ children }: { children: ReactNode }) => <span className="film-only">{children}</span>;

/**
 * The film's words. This is the real page: it's server-rendered text, and reads as a normal article with no JavaScript, with reduced
 * motion, or without WebGL. Everything said here comes from what the product does, and matches docs/STATUS.md.
 */
export async function FilmChapters() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <>
      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: FILM_MODE_CHECK }} />
      <FilmClient />

      <Chapter id="flurry" label="The problem">
        <Beat a={0} b={0.7} wide first>
          <h1>The smart inbox that stops threats.</h1>
          <p>AI reads every message and opens every link, script and PDF before you do. Phishing and malware are held back. What matters comes first. Gmail, Outlook, iCloud and IMAP, in one place. Free and open source, on your own server.</p>
          <div className="film-controls">
            <GitHubCta />
            <CtaLink href="#focus-demo" variant="secondary">Try the demo</CtaLink>
          </div>
        </Beat>
        <Beat a={0.72} b={1} place="right">
          <h2>This is your mail.<FilmOnly> Move through it.</FilmOnly></h2>
          <p>Most of it is fine. Some of it matters today. One piece is built to steal from you, and the AI&apos;s job is to find it first.</p>
          <DetailSheet title="Where this mail comes from">
            <p>Nowhere. It&apos;s drawn on this page, and nothing about you is involved.</p>
          </DetailSheet>
        </Beat>
      </Chapter>

      <Chapter id="stream" label="One workspace">
        <Beat a={0.1} b={1}>
          <h2>Every mailbox. One stream.</h2>
          <p>Connect the accounts you already have. Your mail stays where it is, and every message is checked as it arrives.</p>
          <SourceToggles />
          <DetailSheet title="How mailboxes connect">
            <ul>
              <li>Gmail and Outlook connect by OAuth, so your password stays with them.</li>
              <li>iCloud and other IMAP hosts use an app password, sealed under your workspace&apos;s keys.</li>
              <li>The first sync fetches the last 30 days. Older mail stays with your provider.</li>
              <li>The sending address is checked again before anything goes.</li>
            </ul>
          </DetailSheet>
        </Beat>
      </Chapter>

      <Chapter id="seals" label="Authentication">
        <Beat a={0.04} b={0.96}>
          <h2>Who is this really from?</h2>
          <p>SPF, DKIM and DMARC are how a domain vouches for its mail. Try a bad one.</p>
          <SenderChoice />
          <DetailSheet title="What the three checks prove">
            <ul>
              <li><b>SPF</b> asks whether this server may send for that domain.</li>
              <li><b>DKIM</b> asks whether that domain signed the message, and it hasn&apos;t changed since.</li>
              <li><b>DMARC</b> asks whether either of those lines up with the From line.</li>
            </ul>
            <p>An attacker who owns a lookalike domain can pass all three. So a pass helps a little, and never clears a message by itself.</p>
          </DetailSheet>
        </Beat>
      </Chapter>

      <Chapter id="autopsy" label="What gets checked">
        <Beat a={0.12} b={1}>
          <h2>Then the AI takes it apart.</h2>
          <p>Sender, signature, wording, links, files and history, each read on its own. A clean signature can&apos;t excuse a bad link.</p>
          <AutopsyPanel />
          <DetailSheet title="Why they're read separately">
            <p>Each layer produces findings, with a weight for or against. They&apos;re added together at the end, so no single layer decides.</p>
            <p>Malware findings are the exception: they set a floor that nothing can talk down.</p>
          </DetailSheet>
        </Beat>
      </Chapter>

      <Chapter id="xray" label="Inside the attachment">
        <Beat a={0.04} b={1}>
          <h2>It opens the PDF, so you don&apos;t have to.</h2>
          <p>Scripts packed into compressed streams, exploits aimed at your PDF reader, macros, fake sign-in pages. Every file is unpacked and read, and the AI judges what&apos;s inside.</p>
          <XrayPanel />
          <DetailSheet title="What gets opened">
            <ul>
              <li><b>PDF.</b> Every stream is decompressed, object streams and disguised names included. Scripts, actions that run on open, launch commands, hidden programs and links are pulled out.</li>
              <li><b>Office.</b> Macros, remote templates, Follina-style links and command fields.</li>
              <li><b>RTF.</b> Embedded objects, including Equation Editor exploits.</li>
              <li><b>Web pages and SVG.</b> Fake sign-in forms, HTML smuggling, scripts inside images.</li>
              <li><b>Scripts.</b> What they download, and what they run.</li>
            </ul>
            <p>Nothing is ever run. The AI sees what was decoded, the structure and the code, and a finding like this one sets a floor no other signal can talk down.</p>
          </DetailSheet>
        </Beat>
      </Chapter>

      <Chapter id="uv" label="Hidden instructions">
        <Beat a={0.06} b={1}>
          <h2>Some mail is written for your AI.</h2>
          <p>White text on white, aimed at any assistant that reads it.<FilmOnly> Move the lamp and find it.</FilmOnly></p>
          <UvPanel />
          <DetailSheet title="What happens to hidden instructions">
            <p>Before any AI feature sees a message, it&apos;s screened for text written to manipulate a model. What&apos;s found raises the risk, and is explained to you.</p>
            <p>And the model has no tool to send, forward or delete, so an instruction has nothing to use.</p>
          </DetailSheet>
        </Beat>
      </Chapter>

      <Chapter id="scale" label="The evidence">
        <Beat a={0.06} b={1}>
          <h2>Every warning shows its evidence.</h2>
          <p>Choose a message. These are the weights the engine gave it.</p>
          <ScalePanel />
          <DetailSheet title="How the weights become a verdict">
            <p>They&apos;re added, and the total becomes a rating, such as suspicious, high risk or malicious. Your policy decides what each rating does.</p>
            <p>Notice how little a DMARC pass counts, because attackers can pass it on their own domains.</p>
            <p>If a check couldn&apos;t run, the report says so, and doesn&apos;t call the message safe.</p>
          </DetailSheet>
        </Beat>
      </Chapter>

      <Chapter id="case" label="Held back">
        <Beat a={0.08} b={1}>
          <h2>Held, not deleted.</h2>
          <p>Nothing in it runs, and nothing is lost. Anything held by mistake can be restored, and every restore is recorded.</p>
          <CasePanel />
          <DetailSheet title="How held mail works">
            <ul>
              <li>A held message is out of your inbox, and nothing in it runs or loads.</li>
              <li>In an organization, admins handle held mail and can restore anything held by mistake. Every restore is recorded.</li>
              <li>A file rated malicious can&apos;t be forwarded, even after a release.</li>
            </ul>
          </DetailSheet>
        </Beat>
      </Chapter>

      <Chapter id="focus" label="Focus">
        <Beat a={0.06} b={1}>
          <h2>The rest gets put in order.</h2>
          <p>Security runs first, so a scam can&apos;t climb by saying URGENT. Every letter says why it&apos;s there.<FilmOnly> Drag one somewhere else.</FilmOnly></p>
          <FocusPanel />
          <DetailSheet title="How the order is decided">
            <p>From what a message asks of you, who it&apos;s from, whether you usually reply, and dates it mentions. Early rankings are estimates, and improve as you correct them.</p>
            <p>Moving a letter here only moves it on this page. Prefer plain email? Turn AI organization off for a chronological inbox.</p>
          </DetailSheet>
        </Beat>
      </Chapter>

      <Chapter id="glass" label="AI you approve">
        <Beat a={0.08} b={1}>
          <h2>AI drafts. You send.</h2>
          <p>The model has no tool to send, forward or delete. Nothing goes without your approval.</p>
          <GlassPanel />
          <DetailSheet title="What the AI can touch">
            <ul>
              <li>Security checks run on every message. With AI review on, a model also judges each message and what was found inside its files.</li>
              <li>A hosted model only sees your mail once you&apos;ve turned it on.</li>
              <li>Summaries and drafts are separate features you can turn off.</li>
              <li>The model has no tool to send. Instructions hidden in a message can&apos;t give it one.</li>
            </ul>
          </DetailSheet>
        </Beat>
      </Chapter>

      <Chapter id="vault" label="Encryption">
        <Beat a={0.08} b={1}>
          <h2>Your mail, sealed.</h2>
          <p>Each workspace has its own keys. Delete an account and they&apos;re destroyed, which leaves only noise.</p>
          <VaultPanel />
          <DetailSheet title="Exactly how keys work here">
            <ul>
              <li>Subjects, bodies, participants and attachments are encrypted at rest under per-workspace keys, wrapped by a root key.</li>
              <li>The root key can live in AWS KMS.</li>
              <li>Server search is optional, and can be turned off.</li>
            </ul>
            <p><Link href="/privacy-architecture">Read the architecture</Link>.</p>
          </DetailSheet>
        </Beat>
      </Chapter>

      <Chapter id="calm" label="The end of the film">
        <Beat a={0.12} b={0.615} place="center" wide>
          <h2>Quiet.</h2>
          <p>What needs you, in order. What&apos;s built to hurt you, held back.</p>
          <div className="film-controls">
            <GitHubCta />
            <CtaLink href="#focus-demo" variant="secondary">Try the demo</CtaLink>
          </div>
          <DetailSheet label="What you just saw" title="What you just saw">
            <ul>
              <li>Every mailbox in one stream, each still labelled.</li>
              <li>Authentication, which says who sent it.</li>
              <li>AI that takes every message apart, and opens every file.</li>
              <li>Instructions hidden for your AI, found.</li>
              <li>A verdict with its evidence, and mail held back, never deleted.</li>
              <li>Focus, after security, with the reason on every letter.</li>
              <li>AI that drafts, and a lever only you can pull.</li>
              <li>Keys that can be destroyed.</li>
            </ul>
          </DetailSheet>
        </Beat>
      </Chapter>
    </>
  );
}
