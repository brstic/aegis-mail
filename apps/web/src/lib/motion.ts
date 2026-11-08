/**
 * Small movements that say what just happened to a row: archive folds it away like a sheet of paper, spam slides it off to the side, and
 * trash drops it. Quick enough never to be waited on, and nothing at all with reduced motion.
 */
const KEYFRAMES: Record<string, { to: Keyframe; origin?: string }> = {
  archive: { to: { transform: "perspective(600px) rotateX(-72deg)", opacity: 0 }, origin: "50% 0" },
  trash: { to: { transform: "translateY(10px) scale(.98)", opacity: 0 } },
  spam: { to: { transform: "translateX(36px)", opacity: 0 } },
};

export async function leaveRows(ids: string[], action: string): Promise<void> {
  const k = KEYFRAMES[action];
  if (!k || typeof document === "undefined" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const runs = ids.flatMap(id => {
    const el = document.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`);
    if (!el) return [];
    if (k.origin) el.style.transformOrigin = k.origin;
    return [el.animate([{ transform: "none", opacity: 1 }, k.to], { duration: 170, easing: "cubic-bezier(.4,0,.8,.4)", fill: "forwards" }).finished];
  });
  await Promise.allSettled(runs);
}
