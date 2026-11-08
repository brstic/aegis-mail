"use client";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { LAYERS } from "../../data/content";
import { ch, damp, film, near, smooth } from "../../store";
import { LETTER as L, RIDE, STATION as S } from "../layout";
import { ACCENT, canvas, fonts, grain, INK, PAPER, texture } from "../paper";

function sheetTexture(title: string, lines: readonly string[]) {
  const W = 1024, H = 672;
  const { c, g } = canvas(W, H);
  const f = fonts();
  g.fillStyle = PAPER; g.fillRect(0, 0, W, H);
  g.fillStyle = ACCENT; g.font = `500 62px ${f.display}`; g.textBaseline = "top"; g.fillText(title, 58, 48);
  g.strokeStyle = "rgba(30,30,35,.25)"; g.lineWidth = 2; g.beginPath(); g.moveTo(58, 130); g.lineTo(W - 58, 130); g.stroke();
  g.fillStyle = INK; g.font = `500 37px ${f.mono}`;
  lines.forEach((l, i) => g.fillText(l.slice(0, 46), 58, 168 + i * 66));
  grain(g, W, H);
  return texture(c);
}

/** The letter comes apart into the layers that get read separately, spreading upward as you scroll. Selecting one brings it out to be read. */
export function Autopsy() {
  const root = useRef<THREE.Group>(null);
  const sheets = useRef<(THREE.Group | null)[]>([]);
  const maps = useMemo(() => LAYERS.map(l => sheetTexture(l.title, l.print)), []);
  const out = useRef(LAYERS.map(() => 0));

  useFrame((_, dt) => {
    const g = root.current;
    if (!g) return;
    const on = near("autopsy", 0.5);
    g.visible = on;
    for (const l of LAYERS) { if (!film.anchors[`au-${l.id}`]) film.anchors[`au-${l.id}`] = { x: 0, y: 0, z: 0, on: 0 }; }
    if (!on) { for (const l of LAYERS) film.anchors[`au-${l.id}`]!.on = 0; return; }
    const p = ch("autopsy");
    const spread = smooth(0.14, 0.56, p);
    const gone = smooth(0.97, 1, p);
    const d = Math.min(dt, 0.05);
    LAYERS.forEach((l, i) => {
      const sheet = sheets.current[i];
      if (!sheet) return;
      const n = LAYERS.length;
      // Each leaves the envelope in turn, the top one first.
      const own = smooth(0.14 + (n - 1 - i) * 0.05, 0.3 + (n - 1 - i) * 0.05, p);
      const sel = film.controls.inspect === l.id ? 1 : 0;
      out.current[i] = damp(out.current[i]!, sel, 7, d);
      const o = out.current[i]!;
      const y = RIDE + 0.5 + own * (0.5 + (n - 1 - i) * 0.84 * spread);
      sheet.position.set(0, y, (1 - own) * 0.05 + o * 1.5);
      // Selected, it tilts up to face the lens.
      sheet.rotation.set(o * 0.62, 0, 0);
      sheet.scale.setScalar(own < 0.002 ? 0.001 : 1 + o * 0.12);
      const a = film.anchors[`au-${l.id}`]!;
      a.x = S.autopsy + L.W / 2 * Math.cos(0); a.y = y + 0.04; a.z = sheet.position.z - L.D / 2 + 0.2;
      a.on = smooth(0.3 + (n - 1 - i) * 0.05, 0.42 + (n - 1 - i) * 0.05, p) * (1 - gone);
    });
  });

  return (
    <group ref={root} position={[S.autopsy, 0, 0]}>
      {LAYERS.map((l, i) => (
        <group key={l.id} ref={g => { sheets.current[i] = g; }} scale={0.001}>
          <mesh castShadow receiveShadow onClick={e => { e.stopPropagation(); window.dispatchEvent(new CustomEvent("film:inspect", { detail: l.id })); }}>
            <boxGeometry args={[L.W - 0.12, 0.012, L.D - 0.1]} />
            <meshStandardMaterial attach="material-0" color="#e8e8ec" />
            <meshStandardMaterial attach="material-1" color="#e8e8ec" />
            <meshStandardMaterial attach="material-2" map={maps[i]} roughness={0.9} />
            <meshStandardMaterial attach="material-3" color="#f2f2f5" />
            <meshStandardMaterial attach="material-4" color="#e8e8ec" />
            <meshStandardMaterial attach="material-5" color="#e8e8ec" />
          </mesh>
        </group>
      ))}
    </group>
  );
}
