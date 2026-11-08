"use client";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { METAL, plaqueTexture } from "../../gl/paper";
import { MiniStage } from "../Stage";

const MAX = 40;
const STATES = [{ id: "queued", label: "Queued", x: -5, c: "#e8e8ec" }, { id: "running", label: "Running", x: 0, c: "#d8dbe2" }, { id: "dead", label: "Dead", x: 5, c: "#e0574b" }] as const;

/** The job queue as a belt. Only how many, in which state, ever reaches this: never a tenant or a payload. */
export default function Conveyor({ counts, active = true }: { counts: Record<"queued" | "running" | "dead", number>; active?: boolean }) {
  return (
    <MiniStage active={active} camera={[-0.8, 8, 18]} look={[0, 0.4, 0.4]} lean={0.08}>
      <Belt counts={counts} />
    </MiniStage>
  );
}

function Belt({ counts }: { counts: Record<"queued" | "running" | "dead", number> }) {
  const refs = useRef<(THREE.InstancedMesh | null)[]>([]);
  const rollers = useRef<THREE.Group>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  const labels = useMemo(() => STATES.map(s => plaqueTexture([s.label], { w: 512, h: 128, size: 66 })), []);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    STATES.forEach((s, k) => {
      const m = refs.current[k];
      if (!m) return;
      const n = Math.min(MAX, counts[s.id]);
      m.count = n;
      for (let i = 0; i < n; i++) {
        const col = i % 4, layer = Math.floor(i / 4);
        // Running jobs jiggle along the belt. Everything else just waits.
        o.position.set(s.x - 1.2 + col * 0.8 + (s.id === "running" ? Math.sin(t * 2 + i) * 0.05 : 0), 0.34 + layer * 0.26, s.id === "running" ? Math.sin(t * 1.4 + i) * 0.1 : 0);
        o.rotation.set(0, ((i * 2.7) % 1) * 0.3 - 0.15, 0);
        o.updateMatrix();
        m.setMatrixAt(i, o.matrix);
      }
      m.instanceMatrix.needsUpdate = true;
    });
    if (rollers.current && counts.running > 0) rollers.current.children.forEach(c => { c.rotation.z = -t * 1.6; });
  });
  const rollerX = useMemo(() => Array.from({ length: 22 }, (_, i) => -8.4 + i * 0.8), []);
  return (
    <>
      <mesh position={[0, 0.15, 0]} castShadow receiveShadow><boxGeometry args={[17.8, 0.14, 2.6]} /><meshStandardMaterial color="#e8e8ec" roughness={0.9} /></mesh>
      <group ref={rollers}>
        {rollerX.map(x => <mesh key={x} position={[x, 0.1, 1.38]} rotation-x={Math.PI / 2} castShadow><cylinderGeometry args={[0.09, 0.09, 0.08, 14]} /><meshStandardMaterial color={METAL} metalness={1} roughness={0.3} /></mesh>)}
      </group>
      {STATES.map((s, k) => (
        <group key={s.id}>
          <instancedMesh ref={r => { refs.current[k] = r; }} args={[undefined, undefined, MAX]} castShadow receiveShadow frustumCulled={false}>
            <boxGeometry args={[0.7, 0.24, 0.5]} /><meshStandardMaterial color={s.c} roughness={0.8} />
          </instancedMesh>
          <mesh position={[s.x, 0.02, 2.1]} rotation-x={-Math.PI / 2}><planeGeometry args={[3.4, 0.86]} /><meshBasicMaterial map={labels[k]} transparent toneMapped={false} /></mesh>
        </group>
      ))}
    </>
  );
}
