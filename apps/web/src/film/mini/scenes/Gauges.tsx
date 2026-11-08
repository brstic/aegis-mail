"use client";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { METAL, canvas, fonts, grain, INK, PAPER, texture } from "../../gl/paper";
import { damp } from "../../store";
import { MiniStage } from "../Stage";

export interface Gauge { id: string; label: string; state: "ok" | "bad" | "off" }

const ANGLE = { ok: -0.85, off: 0, bad: 0.85 };

function dial(label: string) {
  const S = 512;
  const { c, g } = canvas(S, S);
  const f = fonts();
  g.fillStyle = PAPER; g.fillRect(0, 0, S, S);
  const arc = (from: number, to: number, col: string) => { g.strokeStyle = col; g.lineWidth = 28; g.beginPath(); g.arc(S / 2, S * 0.6, S * 0.34, from, to); g.stroke(); };
  arc(Math.PI * 1.02, Math.PI * 1.34, "#0071e3");
  arc(Math.PI * 1.36, Math.PI * 1.64, "#b9b19e");
  arc(Math.PI * 1.66, Math.PI * 1.98, "#d9483b");
  g.fillStyle = INK; g.font = `500 46px ${f.display}`; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(label.slice(0, 16), S / 2, S * 0.8);
  grain(g, S, S);
  return texture(c);
}

/** A dial for each subsystem. Only three positions, the same three states as the list below it, which says what they mean. */
export default function Gauges({ gauges, active = true }: { gauges: Gauge[]; active?: boolean }) {
  const cols = Math.min(gauges.length, 5);
  return (
    <MiniStage active={active} camera={[0, 1.5, 5.2 + cols * 1.55]} look={[0, gauges.length > 5 ? 1.2 : 0.2, 0]} lean={0.1}>
      <Panel gauges={gauges} cols={cols} />
    </MiniStage>
  );
}

function Panel({ gauges, cols }: { gauges: Gauge[]; cols: number }) {
  const needles = useRef<(THREE.Group | null)[]>([]);
  const faces = useMemo(() => gauges.map(g => dial(g.label)), [gauges]);
  useFrame(({ clock }, dt) => {
    const d = Math.min(dt, 0.05);
    gauges.forEach((g, i) => {
      const n = needles.current[i];
      if (n) n.rotation.z = damp(n.rotation.z, ANGLE[g.state] + (g.state === "off" ? 0 : Math.sin(clock.elapsedTime * 3 + i) * 0.012), 4, d);
    });
  });
  const metal = <meshStandardMaterial color={METAL} metalness={1} roughness={0.25} />;
  return (
    <>
      {gauges.map((g, i) => {
        const row = Math.floor(i / cols), col = i % cols;
        return (
          <group key={g.id} position={[(col - (cols - 1) / 2) * 2.7, 2.4 - row * 2.7 - (gauges.length > 5 ? 0 : 2.2), 0]} rotation-x={-0.1}>
            <mesh rotation-x={Math.PI / 2} castShadow><cylinderGeometry args={[1.22, 1.26, 0.12, 48]} />{metal}</mesh>
            <mesh position={[0, 0, 0.065]}><circleGeometry args={[1.12, 48]} /><meshStandardMaterial map={faces[i]} roughness={0.86} /></mesh>
            <group ref={n => { needles.current[i] = n; }} position={[0, -0.22, 0.09]}>
              <mesh position={[0, 0.42, 0]} castShadow><boxGeometry args={[0.03, 0.84, 0.015]} /><meshStandardMaterial color="#1d1d1f" /></mesh>
              <mesh rotation-x={Math.PI / 2}><cylinderGeometry args={[0.06, 0.06, 0.03, 16]} />{metal}</mesh>
            </group>
          </group>
        );
      })}
    </>
  );
}
