"use client";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { canvas, fonts, grain, INK, PAPER, ACCENT, DANGER, texture } from "../../gl/paper";
import { damp } from "../../store";
import { MiniStage } from "../Stage";

export interface Layer { id: string; title: string; lines: string[]; tone?: "raises" | "lowers" | "none" }

function sheet(l: Layer) {
  const W = 1024, H = 672;
  const { c, g } = canvas(W, H);
  const f = fonts();
  g.fillStyle = PAPER; g.fillRect(0, 0, W, H);
  g.fillStyle = l.tone === "raises" ? DANGER : ACCENT; g.fillRect(0, 0, 12, H);
  g.font = `500 62px ${f.display}`; g.textBaseline = "top"; g.fillText(l.title, 58, 48);
  g.strokeStyle = "rgba(30,30,35,.25)"; g.lineWidth = 2; g.beginPath(); g.moveTo(58, 130); g.lineTo(W - 58, 130); g.stroke();
  g.fillStyle = INK; g.font = `500 35px ${f.mono}`;
  l.lines.slice(0, 7).forEach((t, i) => g.fillText(t.slice(0, 48), 58, 166 + i * 66));
  grain(g, W, H);
  return texture(c);
}

/** A message as a stack of sheets, one per thing that was checked. Selecting one brings it forward. Used on /security, with a sample, and on a real report. */
export default function Layers({ layers, selected, onSelect, active = true }: { layers: Layer[]; selected: string; onSelect?: (id: string) => void; active?: boolean }) {
  return (
    <MiniStage active={active} camera={[3.2, 10.5, 7.5]} look={[0, 0.9, 0]} lean={0.08}>
      <Stack layers={layers} selected={selected} onSelect={onSelect} />
    </MiniStage>
  );
}

function Stack({ layers, selected, onSelect }: { layers: Layer[]; selected: string; onSelect?: (id: string) => void }) {
  const refs = useRef<(THREE.Group | null)[]>([]);
  const key = layers.map(l => `${l.id}:${l.tone}:${l.lines.join("|")}`).join("#");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the layers' content.
  const maps = useMemo(() => layers.map(sheet), [key]);
  const state = useRef(layers.map(() => ({ y: 0, out: 0 })));
  useFrame((_, dt) => {
    const d = Math.min(dt, 0.05);
    const n = layers.length;
    layers.forEach((l, i) => {
      const g = refs.current[i];
      if (!g) return;
      const s = (state.current[i] ??= { y: 0, out: 0 });
      s.y = damp(s.y, 0.22 + (n - 1 - i) * 0.45, 3.4, d);
      s.out = damp(s.out, l.id === selected ? 1 : 0, 7, d);
      g.position.set(s.out * 0.2, s.y + s.out * 0.5, s.out * 0.9);
      g.rotation.x = s.out * 0.35;
      g.scale.setScalar(1 + s.out * 0.06);
    });
  });
  return (
    <>
      {layers.map((l, i) => (
        <group key={l.id} ref={g => { refs.current[i] = g; }}>
          <mesh castShadow receiveShadow
            onClick={e => { e.stopPropagation(); onSelect?.(l.id); }}
            onPointerOver={() => { if (onSelect) document.documentElement.style.cursor = "pointer"; }}
            onPointerOut={() => { document.documentElement.style.cursor = ""; }}
          >
            <boxGeometry args={[4.4, 0.016, 2.9]} />
            <meshStandardMaterial attach="material-0" color="#e8e8ec" />
            <meshStandardMaterial attach="material-1" color="#e8e8ec" />
            <meshStandardMaterial attach="material-2" map={maps[i]} roughness={0.9} />
            <meshStandardMaterial attach="material-3" color="#f2f2f5" />
            <meshStandardMaterial attach="material-4" color="#e8e8ec" />
            <meshStandardMaterial attach="material-5" color="#e8e8ec" />
          </mesh>
        </group>
      ))}
    </>
  );
}
