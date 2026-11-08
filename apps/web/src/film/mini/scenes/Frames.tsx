"use client";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { METAL, plaqueTexture } from "../../gl/paper";
import { MiniStage } from "../Stage";

/** A wall of empty frames. It's the status table, as an object: nothing's been earned yet, so nothing's hanging. */
export default function Frames({ items, active = true }: { items: string[]; active?: boolean }) {
  return (
    <MiniStage active={active} camera={[-3.2, 3.2, 15]} look={[0, 2.8, 0]} lean={0.1}>
      <Wall items={items} />
    </MiniStage>
  );
}

function Wall({ items }: { items: string[] }) {
  const swing = useRef<(THREE.Group | null)[]>([]);
  const labels = useMemo(() => items.map(t => plaqueTexture([t], { w: 640, h: 128, size: t.length > 18 ? 38 : 48 })), [items]);
  useFrame(({ clock }) => {
    // One's been hung slightly crooked, and it moves a little if you look at it long enough.
    swing.current.forEach((g, i) => { if (g) g.rotation.z = ((i * 7) % 5 - 2) * 0.008 + Math.sin(clock.elapsedTime * 0.5 + i) * 0.004; });
  });
  const cols = 3;
  const metal = <meshStandardMaterial color={METAL} metalness={1} roughness={0.27} />;
  return (
    <>
      <mesh position={[0, 3, -0.08]} receiveShadow><planeGeometry args={[60, 30]} /><shadowMaterial color="#101014" transparent opacity={0.13} /></mesh>
      {items.map((_, i) => {
        const col = i % cols, row = Math.floor(i / cols);
        return (
          <group key={i} ref={g => { swing.current[i] = g; }} position={[(col - 1) * 3.7, 4.3 - row * 2.7, 0]}>
            {[[0, 0.95, 3.1, 0.09], [0, -0.95, 3.1, 0.09], [-1.5, 0, 0.09, 1.99], [1.5, 0, 0.09, 1.99]].map(([x, y, w, h], k) => (
              <mesh key={k} position={[x!, y!, 0.04]} castShadow><boxGeometry args={[w!, h!, 0.09]} />{metal}</mesh>
            ))}
            <mesh position={[0, -0.32, 0.03]} castShadow><planeGeometry args={[2.5, 0.5]} /><meshBasicMaterial map={labels[i]} transparent toneMapped={false} /></mesh>
          </group>
        );
      })}
    </>
  );
}
