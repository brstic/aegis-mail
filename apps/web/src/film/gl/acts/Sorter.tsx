"use client";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { damp, film, gOf, near } from "../../store";
import { METAL, providerCard } from "../paper";
import { STATION as S } from "../layout";

const SOURCES = [
  { z: -4.2, kinds: ["gmail"] as const, label: "Gmail" },
  { z: 0, kinds: ["outlook"] as const, label: "Outlook" },
  { z: 4.2, kinds: ["icloud", "imap"] as const, label: "iCloud & IMAP" },
];

/** A card at the head of each lane, with the service's mark, and the slot they all close into. Switch a source off and its card lies down. */
export function Sorter() {
  const root = useRef<THREE.Group>(null);
  const cards = useRef<(THREE.Group | null)[]>([]);
  const faces = useMemo(() => SOURCES.map(s => providerCard([...s.kinds], s.label)), []);
  useFrame((_, dt) => {
    if (!root.current) return;
    // Not before the hero is over: from the first shot it would sit at the edge of the frame.
    root.current.visible = near("stream", 1) && film.y > gOf("flurry", 0.82);
    if (!root.current.visible) return;
    SOURCES.forEach((_, i) => {
      const c = cards.current[i];
      if (c) c.rotation.x = damp(c.rotation.x, film.controls.sources[i] ? -0.12 : -Math.PI / 2 + 0.03, 7, Math.min(dt, 0.05));
    });
  });
  const x = S.stream - 5.4;
  return (
    <group ref={root}>
      {SOURCES.map((s, i) => (
        <group key={s.z} position={[x, 0, s.z - 1.1]}>
          <mesh position={[0, 0.02, 0]} receiveShadow><cylinderGeometry args={[0.42, 0.46, 0.04, 40]} /><meshStandardMaterial color={METAL} metalness={1} roughness={0.32} /></mesh>
          <group ref={g => { cards.current[i] = g; }} position={[0, 0.05, 0]}>
            <mesh position={[0, 0.5, 0]} castShadow>
              <planeGeometry args={[3, 0.84]} />
              <meshBasicMaterial map={faces[i]} transparent toneMapped={false} side={THREE.DoubleSide} />
            </mesh>
          </group>
        </group>
      ))}
      {/* Where the lanes meet: a low white slot across the tape. */}
      <group position={[S.stream + 10, 0, 0]}>
        <mesh position={[0, 0.55, 0]} castShadow receiveShadow><boxGeometry args={[1.6, 1.1, 4.2]} /><meshStandardMaterial color="#f7f7f9" roughness={0.6} /></mesh>
        <mesh position={[-0.81, 0.2, 0]}><boxGeometry args={[0.02, 0.18, 3]} /><meshStandardMaterial color="#1d1d1f" /></mesh>
      </group>
    </group>
  );
}
