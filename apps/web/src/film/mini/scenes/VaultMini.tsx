"use client";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { METAL, envelopeTexture, plaqueTexture } from "../../gl/paper";
import { damp } from "../../store";
import { MiniStage } from "../Stage";

/**
 * The key chain, drawn from a deployment's real state. Each shelf in the vault is a class of key that actually exists; the slip outside is
 * the search index, which is unencrypted when it's on, so it sits outside the vault where it can be seen.
 */
export default function VaultMini({ keyClasses, searchIndex, rootLabel, open = 0.65, active = true }: { keyClasses: string[]; searchIndex: boolean; rootLabel: string; open?: number; active?: boolean }) {
  return (
    <MiniStage active={active} camera={[-4.5, 6.4, 13.5]} look={[0.4, 1.9, 0]} lean={0.12}>
      <Model keyClasses={keyClasses} searchIndex={searchIndex} rootLabel={rootLabel} open={open} />
    </MiniStage>
  );
}

function Model({ keyClasses, searchIndex, rootLabel, open }: { keyClasses: string[]; searchIndex: boolean; rootLabel: string; open: number }) {
  const door = useRef<THREE.Group>(null), slip = useRef<THREE.Group>(null);
  const env = useMemo(envelopeTexture, []);
  const shelves = useMemo(() => keyClasses.slice(0, 5).map(k => plaqueTexture([k], { w: 640, h: 128, size: k.length > 14 ? 42 : 54 })), [keyClasses]);
  const root = useMemo(() => plaqueTexture([rootLabel], { w: 768, h: 128, size: rootLabel.length > 22 ? 38 : 50 }), [rootLabel]);
  const index = useMemo(() => plaqueTexture(["Search index"], { w: 512, h: 128, size: 56 }), []);
  useFrame((_, dt) => {
    const d = Math.min(dt, 0.05);
    if (door.current) door.current.rotation.y = damp(door.current.rotation.y, open * 2.1, 3, d);
    if (slip.current) { const s = damp(slip.current.scale.x, searchIndex ? 1 : 0.001, 5, d); slip.current.scale.setScalar(s); }
  });
  const paper = <meshStandardMaterial color="#f7f7f9" roughness={0.88} />;
  const metal = <meshStandardMaterial color={METAL} metalness={1} roughness={0.26} />;
  const H = 3.5, W = 3.8, D = 2.6;
  return (
    <group position={[0.8, 0, 0]}>
      <mesh position={[0, 0.08, 0]} castShadow receiveShadow><boxGeometry args={[W + 0.2, 0.16, D + 0.2]} />{paper}</mesh>
      <mesh position={[0, H + 0.1, 0]} castShadow receiveShadow><boxGeometry args={[W + 0.2, 0.12, D + 0.2]} />{paper}</mesh>
      <mesh position={[-W / 2, H / 2 + 0.1, 0]} castShadow receiveShadow><boxGeometry args={[0.1, H, D]} />{paper}</mesh>
      <mesh position={[W / 2, H / 2 + 0.1, 0]} castShadow receiveShadow><boxGeometry args={[0.1, H, D]} />{paper}</mesh>
      <mesh position={[0, H / 2 + 0.1, -D / 2]} receiveShadow><boxGeometry args={[W, H, 0.1]} />{paper}</mesh>
      {shelves.map((t, i) => {
        const y = 0.5 + (i * (H - 0.7)) / Math.max(1, shelves.length);
        return (
          <group key={i} position={[0, y, 0.1]}>
            <mesh castShadow receiveShadow><boxGeometry args={[W - 0.15, 0.04, D - 0.4]} /><meshStandardMaterial color="#fcfcfd" roughness={0.9} /></mesh>
            <mesh position={[0, 0.14, 0.9]}><planeGeometry args={[2.1, 0.42]} /><meshBasicMaterial map={t} transparent toneMapped={false} /></mesh>
            <mesh position={[1.35, 0.06, 0.5]} castShadow rotation-x={Math.PI / 2}><torusGeometry args={[0.1, 0.025, 8, 20]} />{metal}</mesh>
          </group>
        );
      })}
      {/* Hinged on the right and swinging outward, away from the camera's side, so the open door never stands in front of the shelf labels. */}
      <group ref={door} position={[W / 2, H / 2 + 0.1, D / 2 + 0.03]}>
        <mesh position={[-W / 2, 0, 0]} castShadow receiveShadow><boxGeometry args={[W, H, 0.07]} />{paper}</mesh>
        <mesh position={[-W / 2, 0, 0.05]} rotation-x={Math.PI / 2} castShadow><cylinderGeometry args={[0.42, 0.46, 0.05, 32]} />{metal}</mesh>
        <mesh position={[-W / 2, 0, -0.05]} rotation-x={Math.PI / 2} castShadow><cylinderGeometry args={[0.42, 0.46, 0.05, 32]} />{metal}</mesh>
      </group>
      <mesh position={[0, H + 0.2, 0]} rotation-x={-Math.PI / 2}><planeGeometry args={[3.5, 0.58]} /><meshBasicMaterial map={root} transparent toneMapped={false} /></mesh>
      <group ref={slip} position={[W / 2 + 1.5, 0.03, 1.1]} scale={0.001}>
        <mesh rotation-x={-Math.PI / 2} castShadow receiveShadow><planeGeometry args={[1.9, 1.25]} /><meshStandardMaterial map={env} roughness={0.9} side={THREE.DoubleSide} /></mesh>
        <mesh position={[0, 0.01, 0.9]} rotation-x={-Math.PI / 2}><planeGeometry args={[1.7, 0.42]} /><meshBasicMaterial map={index} transparent toneMapped={false} /></mesh>
      </group>
    </group>
  );
}
