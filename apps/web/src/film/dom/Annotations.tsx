"use client";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { view } from "../gl/Camera";
import { film } from "../store";

const v = new THREE.Vector3();

/** Labels tied to things in the world: real text in the DOM, with a thin line back to the object they describe. */
export function Annotations() {
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    let raf = 0;
    const nodes = () => [...document.querySelectorAll<HTMLElement>("[data-anchor]")];
    let list = nodes();
    const again = window.setInterval(() => { list = nodes(); }, 1000);
    const lines = new Map<string, SVGLineElement>();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const cam = view.camera, host = svg.current;
      if (!cam || !host) return;
      for (const el of list) {
        const id = el.dataset.anchor!;
        const a = film.anchors[id];
        let line = lines.get(id);
        if (!line) { line = document.createElementNS("http://www.w3.org/2000/svg", "line"); host.appendChild(line); lines.set(id, line); }
        const on = a?.on ?? 0;
        el.style.opacity = String(on);
        el.style.pointerEvents = on > 0.5 ? "auto" : "none";
        if (!a || on <= 0.01) { line.style.opacity = "0"; continue; }
        v.set(a.x, a.y, a.z).project(cam);
        const sx = (v.x * 0.5 + 0.5) * film.vw, sy = (-v.y * 0.5 + 0.5) * film.vh;
        const side = el.dataset.side === "left" ? "left" : "right";
        const lx = sx + (side === "right" ? 64 : -64), ly = sy - 34;
        const r = el.offsetWidth;
        el.style.transform = `translate3d(${Math.round(side === "right" ? lx : lx - r)}px, ${Math.round(ly - el.offsetHeight / 2)}px, 0)`;
        line.setAttribute("x1", String(sx)); line.setAttribute("y1", String(sy));
        line.setAttribute("x2", String(lx)); line.setAttribute("y2", String(ly));
        line.style.opacity = String(on);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); clearInterval(again); };
  }, []);
  return <svg ref={svg} id="film-lines" aria-hidden="true" />;
}
