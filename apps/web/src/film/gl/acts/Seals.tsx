"use client";
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { ch, near, smooth } from "../../store";
import { METAL, plaqueTexture } from "../paper";
import { SEAL_ON_LETTER, SEAL_X } from "../layout";
import { letter, SEALS } from "../Letter";

/** A brass arch with a press in it: as the letter passes beneath, the press comes down and leaves a seal. */
function Arch({ x, label, i }: { x: number; label: string; i: number }) {
  const press = useRef<THREE.Group>(null);
  const sign = useRef<THREE.Mesh>(null);
  const camera = useThree(st => st.camera);
  const plaque = useMemo(() => plaqueTexture([label], { w: 408, h: 136, size: 72, font: "sans" }), [label]);
  const curve = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    for (let a = 0; a <= 32; a++) { const t = (a / 32) * Math.PI; pts.push(new THREE.Vector3(0, Math.sin(t) * 3.2 + 0.02, Math.cos(t) * 2.3)); }
    return new THREE.CatmullRomCurve3(pts);
  }, []);
  useFrame(() => {
    if (sign.current) sign.current.quaternion.copy(camera.quaternion);
    if (!press.current) return;
    // Comes down as the letter's middle is under it, and goes back up.
    const off = letter.x + SEAL_ON_LETTER[i]! - x;
    const k = smooth(-1.1, -0.15, off) * (1 - smooth(0.15, 1.1, off));
    press.current.position.y = 2.65 - k * 2.12;
  });
  return (
    <group position={[x, 0, 0]} scale={0.78}>
      <mesh castShadow><tubeGeometry args={[curve, 48, 0.07, 12, false]} /><meshStandardMaterial color={METAL} metalness={1} roughness={0.28} /></mesh>
      <mesh ref={sign} position={[0, 4.05, 0]}><planeGeometry args={[2.1, 0.66]} /><meshBasicMaterial map={plaque} transparent toneMapped={false} /></mesh>
      <mesh position={[0, 3.0, -0.3]} castShadow><cylinderGeometry args={[0.1, 0.1, 0.5, 16]} /><meshStandardMaterial color={METAL} metalness={1} roughness={0.3} /></mesh>
      <group ref={press} position={[0, 2.65, 0]}>
        <mesh castShadow position={[0, 1.2, -0.3]}><cylinderGeometry args={[0.05, 0.05, 2.5, 12]} /><meshStandardMaterial color={METAL} metalness={1} roughness={0.3} /></mesh>
        <mesh castShadow position={[0, -0.1, -0.3]}><cylinderGeometry args={[0.34, 0.3, 0.2, 40]} /><meshStandardMaterial color={METAL} metalness={1} roughness={0.22} /></mesh>
      </group>
    </group>
  );
}

export function Seals() {
  const root = useRef<THREE.Group>(null);
  useFrame(() => {
    if (!root.current) return;
    // Their work done, they lift away, and leave the letter on its own.
    const gone = smooth(0.8, 0.94, ch("seals"));
    root.current.visible = near("seals", 0.34) && gone < 1;
    root.current.position.y = 16 * gone * gone;
  });
  return (
    <group ref={root}>
      {SEALS.map((s, i) => <Arch key={s.label} x={SEAL_X[i]!} label={s.label} i={i} />)}
    </group>
  );
}
