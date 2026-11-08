export interface Quality { tier: "high" | "mid" | "low"; maxDpr: number; shadows: boolean; shadowSize: number; flurry: number; antialias: boolean }

const TIERS: Record<Quality["tier"], Quality> = {
  high: { tier: "high", maxDpr: 2, shadows: true, shadowSize: 4096, flurry: 700, antialias: true },
  mid: { tier: "mid", maxDpr: 1.5, shadows: true, shadowSize: 2048, flurry: 420, antialias: true },
  low: { tier: "low", maxDpr: 1.25, shadows: false, shadowSize: 0, flurry: 220, antialias: false },
};

/** Coarse on purpose: the frame rate decides the rest at run time. `?tier=` forces one, for comparing frames. */
export function detectQuality(): Quality {
  const forced = new URLSearchParams(location.search).get("tier");
  if (forced === "high" || forced === "mid" || forced === "low") return TIERS[forced];
  const cores = navigator.hardwareConcurrency || 4;
  const memory = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8;
  const phone = matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 700;
  if (phone) return cores >= 6 && memory >= 6 ? TIERS.mid : TIERS.low;
  if (cores <= 4 || memory <= 4) return TIERS.mid;
  return TIERS.high;
}
