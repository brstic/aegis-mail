"use client";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { canRunFilm } from "../store";

/**
 * A small 3D scene on an ordinary page. This file doesn't import three.js: each scene is its own chunk, fetched only once it's about to be
 * on screen, so a page without one pays nothing. Every scene is decorative or has its data in the DOM beside it, so with reduced motion
 * or no WebGL the `fallback` shows and nothing is lost.
 */
/**
 * While a scene's chunk loads, its box shows a soft, quietly shimmering surface, so the space reads as something arriving and never as a
 * hole. The sign-in shield sits on its own backdrop, so it has none.
 */
function Hold() {
  return <div className="absolute inset-0 overflow-hidden rounded-3xl bg-surface/70"><div className="absolute inset-0 animate-pulse bg-[radial-gradient(60%_55%_at_50%_55%,var(--surface-3),transparent_75%)] opacity-70" /></div>;
}

export const SCENES = {
  layers: dynamic(() => import("./scenes/Layers"), { ssr: false, loading: Hold }),
  scale: dynamic(() => import("./scenes/ScaleMini"), { ssr: false, loading: Hold }),
  stacks: dynamic(() => import("./scenes/Stacks"), { ssr: false, loading: Hold }),
  vault: dynamic(() => import("./scenes/VaultMini"), { ssr: false, loading: Hold }),
  frames: dynamic(() => import("./scenes/Frames"), { ssr: false, loading: Hold }),
  flow: dynamic(() => import("./scenes/Flow"), { ssr: false, loading: Hold }),
  cabinet: dynamic(() => import("./scenes/Cabinet"), { ssr: false, loading: Hold }),
  strata: dynamic(() => import("./scenes/Strata"), { ssr: false, loading: Hold }),
  conveyor: dynamic(() => import("./scenes/Conveyor"), { ssr: false, loading: Hold }),
  gauges: dynamic(() => import("./scenes/Gauges"), { ssr: false, loading: Hold }),
  desk: dynamic(() => import("./scenes/DeskMini"), { ssr: false, loading: Hold }),
  shield: dynamic(() => import("./scenes/ShieldMini"), { ssr: false }),
};

type Scenes = typeof SCENES;
type PropsOf<K extends keyof Scenes> = Scenes[K] extends ComponentType<infer P> ? P : never;

export function Mini<K extends keyof Scenes>({ scene, props, className = "h-80", fallback = null }: { scene: K; props: PropsOf<K>; className?: string; fallback?: ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  const [can, setCan] = useState<boolean | null>(null);
  const [near, setNear] = useState(false);
  const [onScreen, setOnScreen] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Only known in the browser, after hydration.
    setCan(canRunFilm());
    const el = host.current;
    if (!el) return;
    const load = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) setNear(true); }, { rootMargin: "600px" });
    const seen = new IntersectionObserver(es => setOnScreen(es.some(e => e.isIntersecting)));
    load.observe(el); seen.observe(el);
    return () => { load.disconnect(); seen.disconnect(); };
  }, []);

  const Scene = SCENES[scene] as unknown as ComponentType<{ active: boolean }>;
  if (can === false) return <>{fallback}</>;
  const ready = can && near;
  return <div ref={host} className={`relative ${className}`} aria-hidden="true">{ready ? <Scene {...(props as object)} active={onScreen} /> : scene !== "shield" && <Hold />}</div>;
}
