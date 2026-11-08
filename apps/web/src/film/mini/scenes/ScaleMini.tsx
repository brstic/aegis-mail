"use client";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, type RefObject } from "react";
import * as THREE from "three";
import { METAL } from "../../gl/paper";
import { clamp, damp } from "../../store";
import { MiniStage } from "../Stage";

const ARM = 3, DROP = 1.5;

/** A small balance for a real report: one block per finding, sized by its weight. The findings themselves are listed beside it, in text. */
export default function ScaleMini({ weights, active = true }: { weights: number[]; active?: boolean }) {
  return (
    <MiniStage active={active} camera={[0, 3.4, 17.5]} look={[0, 2, 0]} lean={0.1}>
      <Balance weights={weights} />
    </MiniStage>
  );
}

function Balance({ weights }: { weights: number[] }) {
  const beam = useRef<THREE.Group>(null), left = useRef<THREE.Group>(null), right = useRef<THREE.Group>(null);
  const tilt = useRef(0), age = useRef(0);
  const blocks = useMemo(() => {
    const stack = [0, 0];
    return weights.slice(0, 16).map((w, i) => {
      const side = w > 0 ? 1 : 0, h = 0.05 + Math.abs(w) * 0.05, y = stack[side]! + h / 2 + 0.05;
      stack[side]! += h + 0.008;
      return { w, side, h, y, x: 0, r: 0 };
    });
  }, [weights]);
  const refs = useRef<(THREE.Group | null)[]>([]);
  useFrame((_, dt) => {
    const d = Math.min(dt, 0.05);
    age.current += d;
    let sum = 0;
    blocks.forEach((b, i) => {
      const land = clamp((age.current - 0.3 - i * 0.14) / 0.45);
      const g = refs.current[i];
      if (g) { g.position.y = b.y + (1 - land) * (1 - land) * 5; g.visible = age.current > 0.3 + i * 0.14; }
      if (land > 0.8) sum += b.w;
    });
    tilt.current = damp(tilt.current, Math.tanh(sum / 6) * 0.3, 3, d);
    if (beam.current) beam.current.rotation.z = -tilt.current;
    const y = Math.sin(tilt.current) * ARM, x = Math.cos(tilt.current) * ARM;
    left.current?.position.set(-x, 3.5 + y - DROP, 0);
    right.current?.position.set(x, 3.5 - y - DROP, 0);
  });
  const metal = <meshStandardMaterial color={METAL} metalness={1} roughness={0.27} />;
  const pan = (ref: RefObject<THREE.Group | null>, side: number) => (
    <group ref={ref}>
      <mesh castShadow receiveShadow><cylinderGeometry args={[1.05, 0.95, 0.06, 40]} />{metal}</mesh>
      <mesh castShadow position={[0, DROP / 2, 0]}><cylinderGeometry args={[0.02, 0.02, DROP, 10]} />{metal}</mesh>
      {blocks.map((b, i) => b.side === side && (
        <group key={i} ref={g => { refs.current[i] = g; }} position={[b.x, b.y, 0]} rotation-y={b.r} visible={false}>
          <mesh castShadow scale={[1, b.h, 1]}><cylinderGeometry args={[0.5, 0.5, 1, 40]} /><meshStandardMaterial color={b.w > 0 ? "#e5484d" : "#0071e3"} roughness={0.42} /></mesh>
        </group>
      ))}
    </group>
  );
  return (
    <>
      <mesh castShadow receiveShadow position={[0, 0.07, 0]}><cylinderGeometry args={[1, 1.15, 0.14, 40]} />{metal}</mesh>
      <mesh castShadow position={[0, 1.8, 0]}><cylinderGeometry args={[0.06, 0.09, 3.4, 20]} />{metal}</mesh>
      <mesh castShadow position={[0, 3.5, 0]}><sphereGeometry args={[0.13, 20, 14]} />{metal}</mesh>
      <group ref={beam} position={[0, 3.5, 0]}><mesh castShadow rotation-z={Math.PI / 2}><cylinderGeometry args={[0.035, 0.035, ARM * 2 + 0.1, 12]} />{metal}</mesh></group>
      {pan(left, 0)}
      {pan(right, 1)}
    </>
  );
}
