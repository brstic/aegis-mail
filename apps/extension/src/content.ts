import { checkLink } from "./analyze";

/**
 * Adds a visible note after risky links. Only textContent is ever written, so page content can't become markup, and nothing
 * is read from or sent to anywhere: the manifest asks for no permissions and this file makes no requests.
 */
const SEEN = new WeakSet<Element>();
const MAX_PER_PASS = 2000;

function annotate(a: HTMLAnchorElement) {
  if (SEEN.has(a)) return;
  SEEN.add(a);
  const href = a.getAttribute("href");
  if (!href) return;
  const finding = checkLink(href, a.textContent ?? "");
  if (!finding) return;
  const note = document.createElement("span");
  note.textContent = ` Check this link: ${finding.message}`;
  note.setAttribute("role", "note");
  note.dataset.aegisLinkCheck = finding.kind;
  note.style.cssText = "display:inline-block;margin-left:4px;padding:0 6px;border:1px solid #a12f1c;border-radius:4px;background:#f9e9e4;color:#a12f1c;font:600 12px system-ui,sans-serif";
  a.after(note);
}

function pass(root: ParentNode) {
  const links = root.querySelectorAll("a[href]");
  for (let i = 0; i < Math.min(links.length, MAX_PER_PASS); i++) annotate(links[i] as HTMLAnchorElement);
}

pass(document);
let queued = false;
new MutationObserver(() => {
  if (queued) return;
  queued = true;
  setTimeout(() => { queued = false; pass(document); }, 300);
}).observe(document.documentElement, { childList: true, subtree: true });
