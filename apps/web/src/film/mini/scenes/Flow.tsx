"use client";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { envelopeTexture, plaqueTexture, providerCard } from "../../gl/paper";
import { lerp, smooth } from "../../store";
import { MiniStage } from "../Stage";

const N = 24;
const COLORS = ["#ffffff", "#fcfcfd", "#f2f2f5", "#d8d8de", "#d8dbe2", "#f0f0f3"];

/** Sources on the left, one neat stream on the right. Used where a page talks about what's connected. */
export default function Flow({ sources, into, active = true }: { sources: string[]; into: string; active?: boolean }) {
  return (
    <MiniStage active={active} camera={[0, 9, 15.5]} look={[-0.8, 0, 0]} lean={0.08}>
      <group scale={0.84} position={[-0.35, 0, 0]}><Lanes sources={sources} into={into} /></group>
    </MiniStage>
  );
}

function Lanes({ sources, into }: { sources: string[]; into: string }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const map = useMemo(envelopeTexture, []);
  const cards = useMemo(() => sources.map(s => { const k = /gmail/i.test(s) ? ["gmail" as const] : /outlook/i.test(s) ? ["outlook" as const] : /icloud/i.test(s) ? ["icloud" as const, "imap" as const] : ["imap" as const]; return providerCard(k, s); }), [sources]);
  const end = useMemo(() => plaqueTexture([into], { w: 640, h: 200, size: into.length > 10 ? 62 : 80 }), [into]);
  const o = useMemo(() => new THREE.Object3D(), []);
  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    const c = new THREE.Color();
    for (let i = 0; i < N; i++) m.setColorAt(i, c.set(COLORS[i % COLORS.length]!));
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, []);
  const zs = sources.map((_, i) => (i - (sources.length - 1) / 2) * 2.6);
  useFrame(({ clock }) => {
    const m = ref.current;
    if (!m) return;
    const t = clock.elapsedTime;
    for (let i = 0; i < N; i++) {
      const lane = i % sources.length, s = ((i / N) + t * 0.05) % 1;
      const close = smooth(0.42, 0.92, s);
      o.position.set(lerp(-2.5, 3.1, s), 0.08 + Math.sin(t * 1.6 + i) * 0.04, lerp(zs[lane]!, 0, close));
      o.rotation.set(-Math.PI / 2 + 0.35, 0, Math.sin(t + i) * 0.06);
      // Small at the edges, so letters appear and leave instead of popping.
      o.scale.setScalar(0.62 * Math.min(1, s * 12, (1 - s) * 12));
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    }
    m.instanceMatrix.needsUpdate = true;
  });
  const card = (t: THREE.Texture, p: [number, number, number], k: number) => (
    <mesh key={k} position={p} rotation-x={-0.3} castShadow><planeGeometry args={[3.6, 1.01]} /><meshBasicMaterial map={t} transparent toneMapped={false} /></mesh>
  );
  return (
    <>
      <instancedMesh ref={ref} args={[undefined, undefined, N]} castShadow frustumCulled={false}><planeGeometry args={[1.5, 1]} /><meshStandardMaterial map={map} roughness={0.92} side={THREE.DoubleSide} /></instancedMesh>
      {cards.map((t, i) => card(t, [-4.2, 0.6, zs[i]!], i))}
      {card(end, [5.0, 0.6, 0], 99)}
    </>
  );
}
