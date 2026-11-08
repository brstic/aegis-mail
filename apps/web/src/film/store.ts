/**
 * The film's state. Scroll writes it, the DOM and the 3D world read it, and React stays out of the per-frame path.
 * `dur` is a chapter's length in screen heights × 100.
 */
export const CHAPTERS = [
  { id: "flurry", dur: 210 },
  { id: "stream", dur: 170 },
  { id: "seals", dur: 280 },
  { id: "autopsy", dur: 320 },
  { id: "xray", dur: 280 },
  { id: "uv", dur: 210 },
  { id: "scale", dur: 260 },
  { id: "case", dur: 190 },
  { id: "focus", dur: 250 },
  { id: "glass", dur: 220 },
  { id: "vault", dur: 260 },
  { id: "calm", dur: 260 },
] as const;

export type ChapterId = (typeof CHAPTERS)[number]["id"];
export const CHAPTER_IDS = CHAPTERS.map(c => c.id) as ChapterId[];
export const durOf = (id: ChapterId) => CHAPTERS.find(c => c.id === id)!.dur;

export const film = {
  rawY: 0,
  y: 0,
  vw: 1440,
  vh: 900,
  aspect: 1.6,
  portrait: false,
  ranges: {} as Record<ChapterId, { top: number; h: number }>,
  ready: false,
  /** Goes up whenever the chapters are measured again, so tracks know to rebuild without comparing anything each frame. */
  layout: 0,
  /** Seconds since the first frame, unless QA freezes it. */
  time: 0,
  frozen: false,
  /** Lights come up, and the flurry falls in. 0 to 1. */
  intro: 0,
  /** 0 is daylight, 1 is a spotlight in the dark. `nightTarget` follows the theme. */
  night: 0,
  nightTarget: 0,
  bg: "#f5f5f7",
  /** -1 to 1, raw and smoothed. `world` is the pointer on a plane through what the camera looks at. */
  pointer: { x: 0, y: 0, sx: 0, sy: 0, px: -9999, py: -9999, seen: false, wx: 0, wy: 0, wz: 0, wvx: 0, wvy: 0, wvz: 0 },
  tier: "high" as "high" | "mid" | "low",
  fps: 60,
  /** How far the wind has pushed the furthest letter this frame. */
  windPeak: 0,
  /** What the DOM controls set, and scenes read. */
  controls: {
    sources: [true, true, true] as boolean[],
    /** The sender in the seals chapter: the real one, one faking the real domain, or a domain made to look like it. */
    sender: "real" as "real" | "spoofed" | "lookalike",
    sample: 0,
    released: false,
    leverPulled: false,
    shredded: false,
    inspect: "" as string,
    uvFound: false,
    /** Letters the visitor moved to another shelf. */
    shelfOf: {} as Record<string, number>,
    glassKnock: 0,
  },
  /** A sideways move on top of the shot, for scenes where choosing something takes you to it. */
  camShift: 0,
  /** Written by scenes each frame, projected to the screen by the annotation layer. */
  anchors: {} as Record<string, { x: number; y: number; z: number; on: number }>,
};

export const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a || 1e-6)); return t * t * (3 - 2 * t); };
export const smoother = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a || 1e-6)); return t * t * t * (t * (t * 6 - 15) + 10); };
export const damp = (a: number, b: number, lambda: number, dt: number) => lerp(a, b, 1 - Math.exp(-lambda * dt));
/** Settles past its target once, like something with a little weight. */
export const backOut = (t: number) => { const c = 1.70158; const x = clamp(t) - 1; return 1 + (c + 1) * x * x * x + c * x * x; };

/** Progress through a chapter, 0 to 1, from the smoothed scroll. */
export function ch(id: ChapterId): number {
  const r = film.ranges[id];
  return r ? clamp((film.y - r.top) / r.h) : 0;
}

/** Whether a chapter is near the camera. Scenes outside it skip their work, and aren't drawn. */
export function near(id: ChapterId, margin = 0.6): boolean {
  const r = film.ranges[id];
  if (!r) return false;
  const pad = film.vh * margin * 3;
  return film.y > r.top - pad && film.y < r.top + r.h + pad;
}

export const gOf = (id: ChapterId, t: number) => { const r = film.ranges[id]; return r ? r.top + r.h * t : 0; };

export function measureFilm() {
  if (typeof window === "undefined") return;
  film.vw = window.innerWidth;
  film.vh = window.innerHeight;
  film.aspect = film.vw / film.vh;
  film.portrait = film.aspect < 1;
  for (const c of CHAPTERS) {
    const el = document.querySelector<HTMLElement>(`[data-chapter="${c.id}"]`);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    film.ranges[c.id] = { top: r.top + window.scrollY, h: Math.max(1, r.height) };
  }
  film.layout++;
  film.ready = true;
}

/** The film needs WebGL 2 and someone who hasn't asked for less motion. `?static` forces the plain page. */
export const FILM_MODE_CHECK = `try{var q=location.search,c=document.createElement('canvas');if(q.indexOf('static')<0&&!matchMedia('(prefers-reduced-motion: reduce)').matches&&c.getContext('webgl2'))document.documentElement.classList.add('film-mode')}catch(e){}`;
export function canRunFilm(): boolean {
  try {
    if (location.search.includes("static") || matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
    return !!document.createElement("canvas").getContext("webgl2");
  } catch { return false; }
}
