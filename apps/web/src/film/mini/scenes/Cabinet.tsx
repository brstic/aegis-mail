"use client";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { METAL, envelopeTexture } from "../../gl/paper";
import { damp } from "../../store";
import { MiniStage } from "../Stage";

const MAX = 24;

/** The quarantine as a glass cabinet, with one letter inside for each thing really held, up to a point. The count is printed beside it. */
export default function Cabinet({ held, active = true }: { held: number; active?: boolean }) {
  return (
    <MiniStage active={active} camera={[-3.6, 4.6, 11.5]} look={[0, 1.3, 0]} lean={0.12}>
      <Box held={held} />
    </MiniStage>
  );
}

function Box({ held }: { held: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const map = useMemo(envelopeTexture, []);
  const o = useMemo(() => new THREE.Object3D(), []);
  const scale = useRef(new Array<number>(MAX).fill(0));
  useFrame((_, dt) => {
    const m = ref.current;
    if (!m) return;
    const d = Math.min(dt, 0.05);
    for (let i = 0; i < MAX; i++) {
      scale.current[i] = damp(scale.current[i]!, i < held ? 0.8 : 0, 4 - (i % 6) * 0.3, d);
      const col = i % 4, row = Math.floor(i / 4) % 3, layer = Math.floor(i / 12);
      o.position.set(-1.35 + col * 0.9, 0.42 + layer * 0.03 + i * 0.002, -0.7 + row * 0.7);
      o.rotation.set(-Math.PI / 2, 0, ((i * 2.3) % 1) * 0.2 - 0.1);
      o.scale.setScalar(scale.current[i]! || 0.0001);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    }
    m.instanceMatrix.needsUpdate = true;
  });
  const glass = <meshStandardMaterial color="#eef1f5" transparent opacity={0.16} roughness={0.05} metalness={0.15} side={THREE.DoubleSide} depthWrite={false} />;
  const bar = <meshStandardMaterial color={METAL} metalness={1} roughness={0.28} />;
  const W = 4.4, H = 2.5, D = 2.8;
  return (
    <>
      <mesh position={[0, 0.17, 0]} castShadow receiveShadow><boxGeometry args={[W + 0.4, 0.34, D + 0.4]} /><meshStandardMaterial color="#f2f2f5" roughness={0.85} /></mesh>
      {[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, z]) => <mesh key={`${x}${z}`} position={[x! * W / 2, 0.34 + H / 2, z! * D / 2]} castShadow><boxGeometry args={[0.06, H, 0.06]} />{bar}</mesh>)}
      <mesh position={[0, 0.34 + H, 0]} castShadow receiveShadow><boxGeometry args={[W + 0.14, 0.06, D + 0.14]} /><meshStandardMaterial color="#f7f7f9" roughness={0.88} /></mesh>
      <mesh position={[0, 0.34 + H / 2, -D / 2]}><planeGeometry args={[W, H]} />{glass}</mesh>
      <mesh position={[0, 0.34 + H / 2, D / 2]}><planeGeometry args={[W, H]} />{glass}</mesh>
      <mesh position={[-W / 2, 0.34 + H / 2, 0]} rotation-y={Math.PI / 2}><planeGeometry args={[D, H]} />{glass}</mesh>
      <mesh position={[W / 2, 0.34 + H / 2, 0]} rotation-y={Math.PI / 2}><planeGeometry args={[D, H]} />{glass}</mesh>
      <instancedMesh ref={ref} args={[undefined, undefined, MAX]} castShadow frustumCulled={false}><planeGeometry args={[1.15, 0.76]} /><meshStandardMaterial map={map} color="#d8d8de" roughness={0.9} side={THREE.DoubleSide} /></instancedMesh>
    </>
  );
}
