"use client";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { ch, film, near, smoother } from "../../store";
import { STATION as S } from "../layout";
import { METAL, envelopeTexture } from "../paper";

const ROW = 7;

/** The end of the film. The same paper as the first shot, all of it in a straight line, and one small stack. */
export function Calm() {
  const root = useRef<THREE.Group>(null);
  const row = useRef<(THREE.Mesh | null)[]>([]);
  const map = useMemo(envelopeTexture, []);
  useFrame(() => {
    const g = root.current;
    if (!g) return;
    const on = near("calm", 0.5);
    g.visible = on;
    if (!on) return;
    const p = ch("calm");
    row.current.forEach((m, i) => {
      if (!m) return;
      const k = smoother(0, 1, (p - i * 0.03) / 0.45);
      m.position.set(-6.2 + i * 2.1, 0.1 + (1 - k) * (2.4 + i * 0.4) + Math.sin(film.time * 0.8 + i) * (1 - k) * 0.3, (1 - k) * -2);
      m.rotation.set(-Math.PI / 2 + (1 - k) * 0.5, 0, (1 - k) * (i % 2 ? 0.5 : -0.5));
    });
  });
  const stack = useMemo(() => Array.from({ length: 12 }, (_, i) => ({ y: 0.1 + i * 0.045, r: ((i * 7) % 5 - 2) * 0.012 })), []);
  return (
    <group ref={root} position={[S.calm, 0, 0]}>
      {Array.from({ length: ROW }, (_, i) => (
        <mesh key={i} ref={m => { row.current[i] = m; }} castShadow receiveShadow>
          <planeGeometry args={[1.9, 1.25]} />
          <meshStandardMaterial map={map} roughness={0.9} side={THREE.DoubleSide} />
        </mesh>
      ))}
      <group position={[0, 0, 2.9]}>
        {stack.map((s, i) => <mesh key={i} position={[0, s.y, 0]} rotation-y={s.r} castShadow receiveShadow><boxGeometry args={[1.9, 0.04, 1.25]} /><meshStandardMaterial color="#fcfcfd" roughness={0.9} /></mesh>)}
        <mesh position={[0, 0.72, 0]} castShadow><cylinderGeometry args={[0.32, 0.38, 0.16, 36]} /><meshStandardMaterial color={METAL} metalness={1} roughness={0.22} /></mesh>
      </group>
    </group>
  );
}
