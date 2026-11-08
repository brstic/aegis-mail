import { Parser } from "htmlparser2";
import sanitizeHtml from "sanitize-html";

export interface SanitizeResult {
  html: string;
  /** Count of remote images and other external resources removed. */
  blockedRemote: number;
  trackingPixels: number;
  hiddenText: string[];
  htmlComments: string[];
  removedActive: number;
}

const ALLOWED_TAGS = ["a","abbr","b","blockquote","br","caption","center","code","col","colgroup","dd","del","div","dl","dt","em","font","h1","h2","h3","h4","h5","h6","hr","i","img","ins","li","ol","p","pre","q","s","small","span","strike","strong","sub","sup","table","tbody","td","tfoot","th","thead","tr","tt","u","ul"];

const SAFE_STYLE: Record<string, RegExp[]> = {
  color: [/^[#\w(),.\s%-]+$/], "background-color": [/^[#\w(),.\s%-]+$/],
  "text-align": [/^(left|right|center|justify)$/], "font-weight": [/^(normal|bold|[1-9]00)$/], "font-style": [/^(normal|italic)$/],
  "font-size": [/^\d+(\.\d+)?(px|pt|em|rem|%)$/], "text-decoration": [/^(none|underline|line-through)$/],
  padding: [/^[\d.\s]+(px|em|%)?[\d.\spxem%]*$/], margin: [/^[\d.\s]+(px|em|%)?[\d.\spxem%]*$/],
  width: [/^\d+(px|%)$/], "border-collapse": [/^(collapse|separate)$/], "vertical-align": [/^(top|middle|bottom)$/],
};

const HIDDEN_STYLE = /(display\s{0,8}:\s{0,8}none|visibility\s{0,8}:\s{0,8}hidden|font-size\s{0,8}:\s{0,8}0|opacity\s{0,8}:\s{0,8}0(?![.\d])|color\s{0,8}:\s{0,8}(#fff(fff)?|white)\b.{0,200}background|mso-hide\s{0,8}:\s{0,8}all|max-height\s{0,8}:\s{0,8}0)/i;
/** Analysis scans at most this much of a hostile document. */
const SCAN_WINDOW = 1_000_000;

const MAX_COLLECTED = 200;

/**
 * Text a person can't see but a model would read, and HTML comments. Uses a streaming parser, not regexes: hostile markup
 * with many unclosed tags makes any backtracking pattern superlinear even with bounded quantifiers.
 */
function collectInvisible(html: string): { hiddenText: string[]; htmlComments: string[] } {
  const hiddenText: string[] = [], htmlComments: string[] = [];
  let hiddenDepth = 0, depth = 0, current = "";
  const parser = new Parser({
    onopentag(_name, attrs) {
      depth++;
      if (hiddenDepth === 0 && attrs.style && attrs.style.length < 4000 && HIDDEN_STYLE.test(attrs.style)) hiddenDepth = depth;
    },
    ontext(t) { if (hiddenDepth && current.length < 2000) current += t; },
    onclosetag() {
      if (hiddenDepth && depth === hiddenDepth) {
        const v = current.replace(/\s+/g, " ").trim();
        if (v && hiddenText.length < MAX_COLLECTED) hiddenText.push(v.slice(0, 2000));
        current = ""; hiddenDepth = 0;
      }
      depth = Math.max(0, depth - 1);
    },
    oncomment(c) {
      const t = c.trim();
      if (t && !/^\[(if |endif)/.test(t) && htmlComments.length < MAX_COLLECTED) htmlComments.push(t.slice(0, 2000));
    },
  }, { decodeEntities: true });
  parser.write(html.slice(0, SCAN_WINDOW));
  parser.end();
  return { hiddenText, htmlComments };
}

export interface SanitizeOptions {
  /** Maps original hrefs to a safe click-through URL. Default keeps original. */
  rewriteHref?: (href: string) => string;
  /** When true, http(s) images keep their src. Only after explicit per-message user consent. */
  allowRemoteImages?: boolean;
  /** Maps cid: references to data URIs when inline images are permitted. */
  cidMap?: Record<string, string>;
}

/**
 * Browsers strip control characters and whitespace from URLs, so "h\\tttps://x" still navigates. Normalizing first
 * means a disguised link can't slip past the click-through page. Relative links have no meaning in an email: dropped.
 */
export function normalizeHref(raw: string): string | null {
  const stripped = raw.replace(/[\x00-\x20\x7f]+/g, "");
  if (!stripped) return null;
  let u: URL;
  try { u = new URL(stripped); } catch { return null; }
  return ["http:", "https:", "mailto:", "tel:"].includes(u.protocol) ? u.toString() : null;
}

/** Plain text of already-sanitized HTML. Used so analysis reads what the person will actually see. */
export function htmlToText(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {}, nonTextTags: ["script", "style", "title", "head"] })
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").trim();
}

/** Allowlist sanitizer. HTML email is hostile input; the output is still rendered in a sandbox iframe. */
export function sanitizeEmailHtml(input: string, opts: SanitizeOptions = {}): SanitizeResult {
  const { hiddenText, htmlComments } = collectInvisible(input);
  let blockedRemote = 0;
  let trackingPixels = 0;
  let removedActive = (input.slice(0, SCAN_WINDOW).match(/<(script|iframe|object|embed|form|meta|base|link|svg|math|video|audio|applet)\b/gi) ?? []).length
    + (input.slice(0, SCAN_WINDOW).match(/\son[a-z]{1,32}\s{0,8}=/gi) ?? []).length;

  const html = sanitizeHtml(input, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ["href", "title", "rel", "target"],
      img: ["src", "alt", "width", "height"],
      td: ["colspan", "rowspan", "align", "valign", "width", "bgcolor"],
      th: ["colspan", "rowspan", "align", "valign", "width", "bgcolor"],
      table: ["align", "border", "cellpadding", "cellspacing", "width", "bgcolor"],
      font: ["color", "size"],
      "*": ["style", "dir", "lang"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["http", "https", "data", "cid"] },
    allowProtocolRelative: false,
    allowedStyles: { "*": SAFE_STYLE },
    disallowedTagsMode: "discard",
    nonTextTags: ["script", "style", "textarea", "option", "noscript", "iframe", "object", "embed", "title", "head"],
    transformTags: {
      a: (tagName, attribs) => {
        const out: Record<string, string> = { rel: "noopener noreferrer nofollow", target: "_blank" };
        const href = normalizeHref(attribs.href ?? "");
        if (href) out.href = opts.rewriteHref && /^https?:/i.test(href) ? opts.rewriteHref(href) : href;
        if (attribs.title) out.title = attribs.title;
        return { tagName, attribs: out };
      },
      img: (tagName, attribs) => {
        const src = (attribs.src ?? "").trim();
        const w = Number(attribs.width), h = Number(attribs.height);
        const isPixel = (w > 0 && w <= 2) || (h > 0 && h <= 2) || /display\s*:\s*none/i.test(attribs.style ?? "");
        if (/^https?:/i.test(src)) {
          if (isPixel) trackingPixels++;
          if (!opts.allowRemoteImages || isPixel) {
            blockedRemote++;
            return { tagName: "span", attribs: { "data-blocked-image": "1" } as Record<string, string>, text: attribs.alt ? `[image: ${attribs.alt}]` : "[image blocked]" };
          }
          return { tagName, attribs: { src, alt: attribs.alt ?? "" } as Record<string, string> };
        }
        if (/^cid:/i.test(src)) {
          const mapped = opts.cidMap?.[src.slice(4)];
          if (mapped) return { tagName, attribs: { src: mapped, alt: attribs.alt ?? "" } as Record<string, string> };
          return { tagName: "span", attribs: {} as Record<string, string>, text: attribs.alt ? `[image: ${attribs.alt}]` : "[inline image]" };
        }
        if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(src)) return { tagName, attribs: { src, alt: attribs.alt ?? "" } as Record<string, string> };
        removedActive++;
        return { tagName: "span", attribs: {} as Record<string, string>, text: "" };
      },
    },
  });
  return { html, blockedRemote, trackingPixels, hiddenText, htmlComments, removedActive };
}

/** Wrap sanitized HTML for `<iframe sandbox="" srcdoc>`. The CSP blocks anything the sanitizer missed. */
export function wrapForSandbox(html: string, opts: { allowRemoteImages?: boolean; dark?: boolean } = {}): string {
  const imgSrc = opts.allowRemoteImages ? "data: https:" : "data:";
  const csp = `default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`;
  const palette = opts.dark ? "color:#e8e4dd;background:#1c1b19" : "color:#262421;background:#fff";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>body{font:14px/1.55 -apple-system,system-ui,sans-serif;margin:0;padding:2px;${palette};word-wrap:break-word;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}a{color:${opts.dark ? "#7fc4b0" : "#1f5f4f"}}blockquote{margin:0 0 0 .6em;padding-left:.8em;border-left:2px solid #bbb}pre{white-space:pre-wrap}</style></head><body>${html}</body></html>`;
}
