import { Parser } from "htmlparser2";

export interface ExtractedUrl {
  href: string;
  /** Visible text when from an anchor. */
  text?: string;
  host: string;
  source: "html" | "text";
}

const TEXT_URL = /\bhttps?:\/\/[^\s<>"')\]]{1,2000}/gi;
const MAX_URLS = 500;

export function hostOf(href: string): string | null {
  try { return new URL(href).hostname.toLowerCase(); } catch { return null; }
}

/** Pure string extraction: never resolves or visits a URL. */
export function extractUrls(text: string, html?: string): ExtractedUrl[] {
  const seen = new Set<string>();
  const out: ExtractedUrl[] = [];
  const add = (u: ExtractedUrl) => { const k = `${u.href}|${u.text ?? ""}`; if (!seen.has(k) && out.length < MAX_URLS) { seen.add(k); out.push(u); } };
  if (html) {
    // A streaming parser, since markup like "<a <a <a ..." makes patterns superlinear.
    let href: string | null = null, visible = "";
    const parser = new Parser({
      onopentag(name, attrs) { if (name === "a" && attrs.href && out.length < MAX_URLS) { href = attrs.href.trim(); visible = ""; } },
      ontext(t) { if (href !== null && visible.length < 2000) visible += t; },
      onclosetag(name) {
        if (name !== "a" || href === null) return;
        const shown = visible.replace(/\s+/g, " ").trim();
        if (/^(javascript|data|vbscript|file):/i.test(href.replace(/[\x00-\x20]+/g, ""))) add({ href, text: shown, host: "", source: "html" });
        else { const host = hostOf(href); if (host) add({ href, text: shown, host, source: "html" }); }
        href = null;
      },
    }, { decodeEntities: true });
    parser.write(html.slice(0, 1_000_000));
    parser.end();
  }
  for (const m of text.slice(0, 1_000_000).matchAll(TEXT_URL)) {
    const href = m[0].replace(/[.,;:!?]+$/, "");
    const host = hostOf(href);
    if (host) add({ href, host, source: "text" });
  }
  return out;
}
