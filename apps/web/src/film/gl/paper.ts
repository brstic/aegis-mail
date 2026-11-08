import * as THREE from "three";

/** Everything printed in the world is drawn here, in the site's own fonts. No font atlas, no workers, so the CSP stays strict. */

export const INK = "#1d1d1f";
export const PAPER = "#ffffff";
export const ACCENT = "#0071e3";
export const DANGER = "#d70015";
export const METAL = "#d4d5da"; // Brushed aluminum.

export function fonts() {
  const inter = getComputedStyle(document.documentElement).getPropertyValue("--font-ui").split(",")[0]?.trim() || "Inter";
  const stack = `-apple-system, BlinkMacSystemFont, "Segoe UI", ${inter}, "Helvetica Neue", sans-serif`;
  return { display: stack, sans: stack, mono: "ui-monospace, SFMono-Regular, Menlo, monospace" };
}

export function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return { c, g: c.getContext("2d")! };
}

export function texture(c: HTMLCanvasElement, opts: { repeat?: boolean } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (opts.repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Faint paper fibres, added on top of what's already drawn. */
export function grain(g: CanvasRenderingContext2D, w: number, h: number, amount = 0.035) {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  g.save();
  for (let i = 0; i < (w * h) / 90; i++) {
    const x = rnd() * w, y = rnd() * h, l = 2 + rnd() * 14, a = rnd() * Math.PI;
    g.strokeStyle = rnd() > 0.5 ? `rgba(40,40,50,${amount * rnd()})` : `rgba(255,255,255,${amount * 1.6 * rnd()})`;
    g.lineWidth = 0.5 + rnd();
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  g.restore();
}

/** The flurry's envelope: flap and fold lines, so a tint from the instance colour still reads as paper. */
export function envelopeTexture() {
  const W = 384, H = 256;
  const { c, g } = canvas(W, H);
  g.fillStyle = "#ffffff"; g.fillRect(0, 0, W, H);
  g.fillStyle = "rgba(30,30,35,.05)";
  g.beginPath(); g.moveTo(0, H); g.lineTo(W / 2, H * 0.42); g.lineTo(W, H); g.fill();
  g.strokeStyle = "rgba(30,30,35,.2)"; g.lineWidth = 2;
  g.beginPath(); g.moveTo(0, 0); g.lineTo(W / 2, H * 0.58); g.lineTo(W, 0); g.stroke();
  g.beginPath(); g.moveTo(0, H); g.lineTo(W * 0.42, H * 0.5); g.moveTo(W, H); g.lineTo(W * 0.58, H * 0.5); g.stroke();
  g.strokeStyle = "rgba(30,30,35,.12)"; g.lineWidth = 3; g.strokeRect(1, 1, W - 2, H - 2);
  grain(g, W, H);
  return texture(c);
}

/** The back of the hero letter. Sender printed on the strip along the bottom edge, where the forged domain shows. */
export function letterBackTexture(sender: string, domain: string, forged: boolean) {
  const W = 1024, H = 672;
  const { c, g } = canvas(W, H);
  const f = fonts();
  g.fillStyle = PAPER; g.fillRect(0, 0, W, H);
  g.fillStyle = "rgba(30,30,35,.045)";
  g.beginPath(); g.moveTo(0, H); g.lineTo(W / 2, H * 0.44); g.lineTo(W, H); g.fill();
  g.strokeStyle = "rgba(30,30,35,.22)"; g.lineWidth = 2.5;
  g.beginPath(); g.moveTo(0, H); g.lineTo(W * 0.42, H * 0.52); g.moveTo(W, H); g.lineTo(W * 0.58, H * 0.52); g.stroke();
  g.fillStyle = "rgba(255,253,248,.94)"; g.fillRect(36, H - 108, W - 72, 76);
  g.strokeStyle = "rgba(30,30,35,.18)"; g.lineWidth = 1.5; g.strokeRect(36, H - 108, W - 72, 76);
  g.font = `500 28px ${f.sans}`; g.fillStyle = "#6e6e73"; g.textBaseline = "middle"; g.fillText("From", 52, H - 70);
  g.font = `600 38px ${f.mono}`;
  const x0 = 138;
  g.fillStyle = INK; g.fillText(sender + "@", x0, H - 70);
  const w0 = g.measureText(sender + "@").width;
  if (forged) { const wd = g.measureText(domain).width; g.fillStyle = "rgba(161,47,28,.14)"; g.fillRect(x0 + w0 - 3, H - 92, wd + 6, 44); g.fillStyle = DANGER; g.fillRect(x0 + w0 - 3, H - 50, wd + 6, 3); }
  g.fillStyle = forged ? DANGER : INK; g.fillText(domain, x0 + w0, H - 70);
  grain(g, W, H);
  return texture(c);
}

export function flapTexture() {
  const W = 1024, H = 512;
  const { c, g } = canvas(W, H);
  g.fillStyle = "#fcfcfd"; g.fillRect(0, 0, W, H);
  const v = g.createLinearGradient(0, 0, 0, H);
  v.addColorStop(0, "rgba(30,30,35,.02)"); v.addColorStop(1, "rgba(30,30,35,.08)");
  g.fillStyle = v; g.fillRect(0, 0, W, H);
  grain(g, W, H);
  return texture(c);
}

/** A seal's face: raised ring, raised letters, and for a failed check, a crack through it. */
export function sealTexture(label: string, color: string, cracked: boolean) {
  const S = 256;
  const { c, g } = canvas(S, S);
  const f = fonts();
  g.fillStyle = color; g.fillRect(0, 0, S, S);
  const lit = g.createRadialGradient(S * 0.36, S * 0.3, 8, S / 2, S / 2, S * 0.62);
  lit.addColorStop(0, "rgba(255,255,255,.08)"); lit.addColorStop(0.6, "rgba(255,255,255,0)"); lit.addColorStop(1, "rgba(0,0,0,.06)");
  g.fillStyle = lit; g.fillRect(0, 0, S, S);
    g.strokeStyle = "rgba(255,255,255,.28)"; g.lineWidth = 3; g.beginPath(); g.arc(S / 2, S / 2, S * 0.38, 0, 7); g.stroke();
  g.font = `600 ${label.length > 4 ? 44 : 54}px ${f.sans}`; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillStyle = "#ffffff"; g.fillText(label, S / 2, S / 2 + 1);
  if (cracked) {
    const pts: [number, number][] = [[S * 0.2, 0], [S * 0.36, S * 0.2], [S * 0.3, S * 0.38], [S * 0.5, S * 0.5], [S * 0.46, S * 0.68], [S * 0.66, S * 0.82], [S * 0.62, S]];
    const line = (w: number, col: string) => { g.strokeStyle = col; g.lineWidth = w; g.lineJoin = "bevel"; g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke(); };
    line(10, "rgba(20,5,0,.85)"); line(3, "rgba(255,220,200,.35)");
  }
  return texture(c);
}

/** A small printed label: the plaques on the arches and the tags in the world. */
/** A label: a white rounded card with crisp text. Transparent outside the card, so it reads as an object, not a sticker. */
export function plaqueTexture(lines: string[], opts: { w?: number; h?: number; bg?: string; ink?: string; size?: number; font?: "display" | "sans" | "mono" } = {}) {
  const W = (opts.w ?? 512) * 2, H = (opts.h ?? 160) * 2;
  const { c, g } = canvas(W, H);
  const f = fonts();
  const r = Math.min(H * 0.32, 64);
  g.clearRect(0, 0, W, H);
  g.fillStyle = opts.bg ?? "#ffffff";
  g.beginPath(); g.roundRect(4, 4, W - 8, H - 8, r); g.fill();
  g.strokeStyle = "rgba(0,0,0,.08)"; g.lineWidth = 3; g.stroke();
  g.fillStyle = opts.ink ?? INK;
  const size = (opts.size ?? 54) * 1.7;
  g.font = `600 ${size}px ${f[opts.font ?? "display"]}`; g.textAlign = "center"; g.textBaseline = "middle";
  const lh = size * 1.18, y0 = H / 2 - ((lines.length - 1) * lh) / 2 + size * 0.04;
  lines.forEach((l, i) => g.fillText(l, W / 2, y0 + i * lh, W - r * 1.2));
  return texture(c);
}

type Draw = (g: CanvasRenderingContext2D, x: number, y: number, s: number) => void;
/** Provider marks, drawn into a box of size s. Simplified, at label size, to say which service each lane is. */
export const PROVIDER_ICON: Record<"gmail" | "outlook" | "icloud" | "imap", Draw> = {
  gmail: (g, x, y, s) => {
    const t = s * 0.2, top = y + s * 0.2, bot = y + s * 0.86;
    g.fillStyle = "#4285F4"; g.beginPath(); g.roundRect(x, top, t, bot - top, [t * 0.4, 0, 0, t * 0.4]); g.fill();
    g.fillStyle = "#34A853"; g.beginPath(); g.roundRect(x + s - t, top, t, bot - top, [0, t * 0.4, t * 0.4, 0]); g.fill();
    g.lineJoin = "round"; g.lineCap = "round"; g.lineWidth = t * 0.92;
    g.strokeStyle = "#EA4335"; g.beginPath(); g.moveTo(x + t / 2, top + t * 0.35); g.lineTo(x + s / 2, top + s * 0.36); g.lineTo(x + s - t / 2, top + t * 0.35); g.stroke();
    g.fillStyle = "#C5221F"; g.beginPath(); g.arc(x + t / 2, top + t * 0.35, t * 0.46, 0, 7); g.fill();
    g.fillStyle = "#FBBC04"; g.beginPath(); g.arc(x + s - t / 2, top + t * 0.35, t * 0.46, 0, 7); g.fill();
  },
  outlook: (g, x, y, s) => {
    g.fillStyle = "#28A8EA"; g.beginPath(); g.roundRect(x + s * 0.32, y + s * 0.16, s * 0.68, s * 0.68, s * 0.08); g.fill();
    g.strokeStyle = "rgba(255,255,255,.85)"; g.lineWidth = s * 0.045; g.beginPath(); g.moveTo(x + s * 0.36, y + s * 0.24); g.lineTo(x + s * 0.66, y + s * 0.46); g.lineTo(x + s * 0.96, y + s * 0.24); g.stroke();
    g.fillStyle = "#0F6CBD"; g.beginPath(); g.roundRect(x, y + s * 0.22, s * 0.58, s * 0.58, s * 0.08); g.fill();
    g.strokeStyle = "#ffffff"; g.lineWidth = s * 0.075; g.beginPath(); g.ellipse(x + s * 0.29, y + s * 0.51, s * 0.13, s * 0.16, 0, 0, 7); g.stroke();
  },
  icloud: (g, x, y, s) => {
    const gr = g.createLinearGradient(x, y + s * 0.2, x, y + s * 0.85);
    gr.addColorStop(0, "#5AB3FF"); gr.addColorStop(1, "#1F7AE8");
    g.fillStyle = gr; g.beginPath();
    g.arc(x + s * 0.3, y + s * 0.6, s * 0.2, 0, 7); g.arc(x + s * 0.52, y + s * 0.46, s * 0.26, 0, 7); g.arc(x + s * 0.76, y + s * 0.62, s * 0.18, 0, 7);
    g.fill(); g.beginPath(); g.roundRect(x + s * 0.12, y + s * 0.58, s * 0.8, s * 0.22, s * 0.11); g.fill();
  },
  imap: (g, x, y, s) => {
    g.strokeStyle = "#636368"; g.lineWidth = s * 0.07; g.lineJoin = "round";
    g.beginPath(); g.roundRect(x + s * 0.06, y + s * 0.22, s * 0.88, s * 0.58, s * 0.08); g.stroke();
    g.beginPath(); g.moveTo(x + s * 0.1, y + s * 0.28); g.lineTo(x + s * 0.5, y + s * 0.56); g.lineTo(x + s * 0.9, y + s * 0.28); g.stroke();
  },
};

/** A source's card: its mark, then its name. */
export function providerCard(kinds: (keyof typeof PROVIDER_ICON)[], label: string) {
  const W = 1280, H = 360;
  const { c, g } = canvas(W, H);
  const f = fonts();
  g.clearRect(0, 0, W, H);
  g.fillStyle = "#ffffff"; g.beginPath(); g.roundRect(6, 6, W - 12, H - 12, 90); g.fill();
  g.strokeStyle = "rgba(0,0,0,.08)"; g.lineWidth = 4; g.stroke();
  const s = 170;
  kinds.forEach((k, i) => PROVIDER_ICON[k](g, 90 + i * (s + 26), (H - s) / 2, s));
  g.fillStyle = INK; g.font = `600 120px ${f.display}`; g.textBaseline = "middle";
  g.fillText(label, 90 + kinds.length * (s + 26) + 30, H / 2 + 6, W - 120 - kinds.length * (s + 26));
  return texture(c);
}

/** A clean studio, for metal to reflect. Built from a few glowing panels, with no image files. */
export function buildEnvironment(renderer: THREE.WebGLRenderer) {
  const scene = new THREE.Scene();
  // Mostly mid-grey, with a few bright panels: metal gets edges and highlights to mirror, and paper gets very little from it.
  scene.background = new THREE.Color("#77777c");
  const panel = (color: string, i: number, w: number, h: number, p: [number, number, number]) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(i), side: THREE.DoubleSide }));
    m.position.set(...p); m.lookAt(0, 0, 0); scene.add(m);
  };
  panel("#ffffff", 9, 16, 10, [-10, 22, 8]);
  panel("#ffffff", 7, 3, 26, [24, 8, 4]);
  panel("#ffffff", 2.4, 34, 3, [0, 4, 26]);
  panel("#ffffff", 5, 3, 22, [-24, 6, -12]);
  panel("#ffffff", 1.4, 40, 12, [0, 18, -24]);
  panel("#ffffff", 1.8, 44, 44, [0, 30, 0.01]);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0.04);
  pmrem.dispose();
  scene.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
  return rt.texture;
}
