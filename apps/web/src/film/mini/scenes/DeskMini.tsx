"use client";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { METAL, envelopeTexture } from "../../gl/paper";
import { MiniStage } from "../Stage";

/** The empty inbox: the last shot of the film, a small stack and nothing to do. */
export default function DeskMini({ letters = 8, active = true }: { letters?: number; active?: boolean }) {
  return (
    <MiniStage active={active} camera={[-1.6, 5, 8]} look={[0, 0.4, 0]} lean={0.14}>
      <Stack letters={letters} />
    </MiniStage>
  );
}

function Stack({ letters }: { letters: number }) {
  const weight = useRef<THREE.Mesh>(null);
  const map = useMemo(envelopeTexture, []);
  const sheets = useMemo(() => Array.from({ length: letters }, (_, i) => ({ y: 0.08 + i * 0.05, r: ((i * 7) % 5 - 2) * 0.02 })), [letters]);
  useFrame(({ clock }) => { if (weight.current) weight.current.rotation.y = Math.sin(clock.elapsedTime * 0.3) * 0.2; });
  const top = 0.1 + letters * 0.05;
  return (
    <>
      {sheets.map((s, i) => <mesh key={i} position={[0, s.y, 0]} rotation-y={s.r} castShadow receiveShadow><boxGeometry args={[3, 0.045, 2]} /><meshStandardMaterial color="#fcfcfd" roughness={0.9} /></mesh>)}
      <mesh position={[0, top + 0.002, 0]} rotation={[-Math.PI / 2, 0, sheets[letters - 1]?.r ?? 0]}><planeGeometry args={[3, 2]} /><meshStandardMaterial map={map} roughness={0.9} /></mesh>
      <mesh ref={weight} position={[0.5, top + 0.1, 0.15]} castShadow><cylinderGeometry args={[0.42, 0.48, 0.18, 36]} /><meshStandardMaterial color={METAL} metalness={1} roughness={0.22} /></mesh>
    </>
  );
}
