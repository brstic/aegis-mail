"use client";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { plaqueTexture } from "../../gl/paper";
import { damp } from "../../store";
import { MiniStage } from "../Stage";

export interface Stratum { id: string; label: string; received: number; sent: number; flagged: number }

/** Each account as a block of layered paper: what came in, what went out and what was flagged. Heights share one scale. The numbers are in the table beside it. */
export default function Strata({ rows, active = true }: { rows: Stratum[]; active?: boolean }) {
  const width = Math.max(rows.length, 2) * 3.4;
  return (
    <MiniStage active={active} camera={[-width * 0.28, 5.4, 8 + width * 0.82]} look={[0, 1.4, 0]} lean={0.12}>
      <Blocks rows={rows} />
    </MiniStage>
  );
}

function Blocks({ rows }: { rows: Stratum[] }) {
  const max = Math.max(1, ...rows.map(r => r.received + r.sent + r.flagged));
  const labels = useMemo(() => rows.map(r => plaqueTexture([r.label.slice(0, 26)], { w: 768, h: 128, size: r.label.length > 18 ? 42 : 56 })), [rows]);
  const refs = useRef<(THREE.Mesh | null)[]>([]);
  const heights = useRef<number[]>([]);
  const parts = rows.flatMap((r, i) => {
    const scale = 4 / max;
    const list = [{ h: r.received * scale, c: "#fcfcfd" }, { h: r.sent * scale, c: "#d8dbe2" }, { h: r.flagged * scale, c: "#e0574b" }];
    let y = 0;
    return list.map(p => { const out = { i, base: y, ...p }; y += p.h; return out; });
  });
  useFrame((_, dt) => {
    const d = Math.min(dt, 0.05);
    parts.forEach((p, k) => {
      const m = refs.current[k];
      if (!m) return;
      heights.current[k] = damp(heights.current[k] ?? 0, 1, 2.6 - (p.i % 3) * 0.3, d);
      const t = heights.current[k]!;
      m.scale.y = Math.max(0.001, p.h * t);
      m.position.y = p.base * t + (p.h * t) / 2 + 0.01;
    });
  });
  const x = (i: number) => (i - (rows.length - 1) / 2) * 3.4;
  return (
    <>
      {parts.map((p, k) => <mesh key={k} ref={m => { refs.current[k] = m; }} position={[x(p.i), 0, 0]} castShadow receiveShadow><boxGeometry args={[2.4, 1, 1.7]} /><meshStandardMaterial color={p.c} roughness={0.9} /></mesh>)}
      {rows.map((r, i) => <mesh key={r.id} position={[x(i), 0.02, 1.4]} rotation-x={-Math.PI / 2}><planeGeometry args={[3, 0.5]} /><meshBasicMaterial map={labels[i]} transparent toneMapped={false} /></mesh>)}
    </>
  );
}
