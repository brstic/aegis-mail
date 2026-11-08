"use client";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { clamp, damp, film } from "../store";
import { CameraDirector, view } from "./Camera";
import { detectQuality, type Quality } from "./quality";
import { World } from "./World";

/** Reads scroll into the store before anything else each frame, and paces quality by what the machine actually manages. */
function Ticker({ q, onDegrade }: { q: Quality; onDegrade: () => void }) {
  const setDpr = useThree(s => s.setDpr);
  const started = useRef(false);
  const dpr = useRef(Math.min(window.devicePixelRatio || 1, q.maxDpr));
  const stat = useRef({ acc: 0, frames: 0, age: 0, slow: 0 });
  useFrame((_, dt) => {
    const d = Math.min(dt, 0.1);
    if (!film.frozen) film.time += d;
    film.rawY = window.scrollY;
    film.y = film.frozen ? film.rawY : damp(film.y, film.rawY, 9, d);
    if (Math.abs(film.y - film.rawY) < 0.05) film.y = film.rawY;
    const p = film.pointer;
    p.sx = damp(p.sx, p.x, 4, d); p.sy = damp(p.sy, p.y, 4, d);
    film.intro = film.frozen ? 1 : Math.min(1, film.intro + d / 2.4);
    film.night = film.frozen ? film.nightTarget : damp(film.night, film.nightTarget, 3, d);

    if (!started.current) { started.current = true; requestAnimationFrame(() => requestAnimationFrame(() => window.dispatchEvent(new Event("film:first-frame")))); }

    const s = stat.current;
    s.acc += d; s.frames++; s.age += d;
    // The first seconds are shader compilation, and say nothing about sustained speed.
    if (s.age < 4) { s.acc = 0; s.frames = 0; return; }
    if (s.acc >= 1.4 && !film.frozen) {
      film.fps = s.frames / s.acc;
      s.slow = film.fps < 42 ? s.slow + 1 : 0;
      const top = Math.min(window.devicePixelRatio || 1, q.maxDpr);
      if (s.slow >= 2 && dpr.current > 1) { s.slow = 0; dpr.current = Math.max(1, dpr.current - 0.25); setDpr(dpr.current); }
      else if (s.slow >= 3) { s.slow = 0; onDegrade(); }
      else if (film.fps > 57 && dpr.current < top) { dpr.current = Math.min(top, dpr.current + 0.05); setDpr(dpr.current); }
      s.frames = 0; s.acc = 0;
    }
  }, -100);
  return null;
}

/** Stops drawing once the film has scrolled away, so the plain page below costs nothing. */
function PauseBelowFilm() {
  const setFrameloop = useThree(s => s.setFrameloop);
  useEffect(() => {
    const onScroll = () => {
      const last = film.ranges.calm;
      if (!last) return;
      const past = window.scrollY > last.top + last.h + 40;
      setFrameloop(past ? "never" : "always");
      const el = document.getElementById("film-canvas");
      if (el) el.style.visibility = past ? "hidden" : "visible";
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, [setFrameloop]);
  return null;
}

export default function Stage() {
  const q0 = useMemo(detectQuality, []);
  const [step, setStep] = useState(0);
  const q = useMemo<Quality>(() => step === 0 ? q0 : { ...q0, flurry: Math.round(q0.flurry * clamp(1 - step * 0.35, 0.25, 1)), shadows: q0.shadows && step < 2 }, [q0, step]);
  const [lost, setLost] = useState(false);

  useEffect(() => { film.tier = q.tier; }, [q]);
  useEffect(() => {
    if (!lost) return;
    // A context lost part-way down falls back to the plain page, rather than a blank one.
    document.documentElement.classList.remove("film-mode");
    window.dispatchEvent(new Event("film:lost"));
  }, [lost]);
  if (lost) return null;

  return (
    <Canvas
      flat
      dpr={clamp(window.devicePixelRatio || 1, 1, q.maxDpr)}
      camera={{ fov: 28, near: 1, far: 400, position: [0, 6, 34] }}
      shadows={q.shadows ? "percentage" : false}
      gl={{ antialias: q.antialias, alpha: false, stencil: false, depth: true, powerPreference: "high-performance" }}
      onCreated={({ gl, scene }) => {
        if (new URLSearchParams(location.search).has("qa")) Object.assign(window, { __three: { gl, scene }, __project: (x: number, y: number, z: number) => { const v = new THREE.Vector3(x, y, z).project(view.camera!); return [(v.x * 0.5 + 0.5) * film.vw, (-v.y * 0.5 + 0.5) * film.vh]; } });
        gl.domElement.addEventListener("webglcontextlost", e => { e.preventDefault(); setLost(true); });
      }}
    >
      <Ticker q={q} onDegrade={() => setStep(s => s + 1)} />
      <PauseBelowFilm />
      <CameraDirector />
      <World q={q} />
    </Canvas>
  );
}
