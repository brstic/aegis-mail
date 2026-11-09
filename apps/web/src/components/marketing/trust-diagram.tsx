/**
 * Trust boundaries in Mode A (managed processing), drawn with theme tokens so it follows light and dark.
 * Two drawings of the same facts: a wide one, and a tall one whose text stays readable on a phone.
 */

const box = "fill-surface stroke-line-strong";
const label = "fill-ink text-[14px] font-semibold";
const sub = "fill-muted text-[12px]";

function Arrow({ d }: { d: string }) {
  return <path d={d} className="fill-none stroke-muted" strokeWidth={1.5} markerEnd="url(#tb-arrow)" />;
}

function Node({ x, y, w, h, title, lines, dashed }: { x: number; y: number; w: number; h: number; title: string; lines: string[]; dashed?: boolean }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={8} className={box} strokeWidth={1.25} strokeDasharray={dashed ? "5 4" : undefined} />
      <text x={x + 12} y={y + 22} className={label}>{title}</text>
      {lines.map((l, i) => <text key={l} x={x + 12} y={y + 41 + i * 16} className={sub}>{l}</text>)}
    </g>
  );
}

function Defs({ id }: { id: string }) {
  return (
    <defs>
      <marker id={id} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0 0 8 4 0 8Z" className="fill-muted" />
      </marker>
    </defs>
  );
}

function Wide() {
  return (
    <svg viewBox="0 0 1040 500" role="img" aria-labelledby="tb-wide-t tb-wide-d" className="hidden h-auto w-full lg:block">
      <title id="tb-wide-t">Trust boundaries in managed processing</title>
      <desc id="tb-wide-d">Mail travels from the sender to your mail provider, which sits outside the service. Inside the service boundary, workers and application servers handle plaintext in memory, while the database holds encrypted content and a plaintext search index. Your browser renders the mail. Tenant admins see aggregates only. A hosted AI model is outside the boundary. It receives content only when the server has a key for one, and then it reviews every incoming message.</desc>
      <Defs id="tb-arrow" />

      {/* Service boundary */}
      <rect x={300} y={20} width={480} height={460} rx={14} className="fill-accent-soft/50 stroke-accent" strokeWidth={1.5} strokeDasharray="7 5" />
      <text x={316} y={46} className="fill-accent text-[13px] font-semibold">Service boundary (the deployment&apos;s operator)</text>

      <Node x={20} y={70} w={220} h={82} title="Sender" lines={["Ordinary mail over SMTP", "From anyone, anywhere"]} />
      <Node x={20} y={210} w={220} h={100} title="Your mail provider" lines={["Gmail, Outlook, iCloud, IMAP", "Keeps its own access", "Receives the mail first"]} />

      <Node x={320} y={70} w={210} h={100} title="Background workers" lines={["Fetch, scan, classify", "Plaintext in memory only", "while processing"]} />
      <Node x={550} y={70} w={210} h={100} title="Application servers" lines={["Rendering and API", "Plaintext in memory only", "while you use the app"]} />
      <Node x={320} y={214} w={210} h={118} title="Database" lines={["Bodies, subjects, participants:", "encrypted per tenant", "Search words: plaintext unless", "you turn server search off"]} />
      <Node x={550} y={214} w={210} h={118} title="Key management" lines={["Holds the root key outside", "the database", "The service can decrypt: that's", "how scanning works"]} />
      <Node x={320} y={366} w={440} h={92} title="Admin console" lines={["Aggregate threat counts, policy changes, audit events.", "No screen, API or database role here shows message content."]} />

      <Node x={840} y={70} w={180} h={100} title="Your browser" lines={["Reads the mail in a", "sandboxed frame", "Client keys in Mode B"]} />
      <Node x={840} y={214} w={180} h={118} title="Hosted AI model" lines={["Off without a key", "With one, reviews", "every message", "Outside the boundary"]} dashed />
      <Node x={840} y={366} w={180} h={92} title="Tenant admins" lines={["See aggregates only"]} />

      <Arrow d="M130 152 V206" />
      <Arrow d="M240 240 H284 V130 H316" />
      <Arrow d="M425 170 V210" />
      <Arrow d="M655 170 V192 H470 V210" />
      <Arrow d="M530 120 H546" />
      <Arrow d="M530 273 H546" />
      <Arrow d="M760 120 H836" />
      <path d="M760 150 H800 V273 H836" className="fill-none stroke-muted" strokeWidth={1.5} strokeDasharray="4 4" markerEnd="url(#tb-arrow)" />
      <Arrow d="M760 412 H836" />
    </svg>
  );
}

function Tall() {
  const rows: { title: string; lines: string[]; inside?: boolean; dashed?: boolean }[] = [
    { title: "Sender", lines: ["Ordinary mail over SMTP", "From anyone, anywhere"] },
    { title: "Your mail provider", lines: ["Gmail, Outlook, iCloud, IMAP", "Receives the mail first", "Keeps its own access"] },
    { title: "Background workers", lines: ["Fetch, scan, classify", "Plaintext in memory only"], inside: true },
    { title: "Database", lines: ["Content encrypted per tenant", "Search words: plaintext unless", "you turn server search off"], inside: true },
    { title: "Application servers", lines: ["Plaintext in memory only", "while you use the app"], inside: true },
    { title: "Admin console", lines: ["Aggregate counts and audit", "No path to message content"], inside: true },
    { title: "Your browser", lines: ["Reads the mail in a", "sandboxed frame"] },
    { title: "Hosted AI model", lines: ["Off without a key. With one,", "it reviews every", "incoming message"], dashed: true },
  ];
  const w = 320, gap = 22, heightOf = (n: number) => 36 + n * 16;
  let y = 8;
  const placed = rows.map(r => { const h = heightOf(r.lines.length); const at = y; y += h + gap; return { ...r, at, h }; });
  const first = placed.find(r => r.inside)!, last = [...placed].reverse().find(r => r.inside)!;
  const total = y - gap + 8;
  return (
    <svg viewBox={`0 0 ${w} ${total}`} role="img" aria-labelledby="tb-tall-t tb-tall-d" className="mx-auto h-auto w-full max-w-sm lg:hidden">
      <title id="tb-tall-t">Trust boundaries in managed processing</title>
      <desc id="tb-tall-d">From top to bottom: sender, your mail provider, then inside the service boundary the workers, database, application servers and admin console, then your browser, and a hosted AI model that sees content only when the server has a key for one, and then reviews every incoming message.</desc>
      <Defs id="tb-arrow-tall" />
      <rect x={1} y={first.at - 12} width={w - 2} height={last.at + last.h - first.at + 22} rx={12} className="fill-accent-soft/50 stroke-accent" strokeWidth={1.25} strokeDasharray="6 4" />
      {placed.map((r, i) => (
        <g key={r.title}>
          <Node x={14} y={r.at} w={w - 28} h={r.h} title={r.title} lines={r.lines} dashed={r.dashed} />
          {i < placed.length - 1 && <path d={`M${w / 2} ${r.at + r.h} V${placed[i + 1]!.at - 3}`} className="fill-none stroke-muted" strokeWidth={1.5} strokeDasharray={placed[i + 1]!.dashed ? "4 4" : undefined} markerEnd="url(#tb-arrow-tall)" />}
        </g>
      ))}
    </svg>
  );
}

export function TrustDiagram() {
  return (
    <figure className="rounded-xl border border-line bg-bg p-3 sm:p-5">
      <Wide />
      <Tall />
      <figcaption className="mt-4 text-sm leading-relaxed text-muted">Managed processing. Mail arrives from your provider, is checked, and is stored sealed under your workspace&apos;s keys. The dashed outline is the deployment.</figcaption>
    </figure>
  );
}
