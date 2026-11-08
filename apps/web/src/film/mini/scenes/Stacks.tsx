"use client";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { METAL } from "../../gl/paper";
import { damp } from "../../store";
import { MiniStage } from "../Stage";

export interface Column { id: string; label: string; height: number; limit?: number; highlight?: boolean }

const SHEET = 0.03;

/** Stacks of paper, one per column. Not used by any page since pricing was removed; kept with the other scenes. Height comes from the numbers the page already prints; a brass line marks a limit where there is one. */
export default function Stacks({ columns, active = true }: { columns: Column[]; active?: boolean }) {
  const width = columns.length * 3;
  return (
    <MiniStage active={active} camera={[0, 3.2 + width * 0.16, 6 + width * 0.82]} look={[0, 1.15, 0]} lean={0.12}>
      <Row columns={columns} />
    </MiniStage>
  );
}

const PER_STACK = 90;
function Row({ columns }: { columns: Column[] }) {
  const refs = useRef<(THREE.InstancedMesh | null)[]>([]);
  const heights = useRef(columns.map(() => 0));
  const m = useMemo(() => new THREE.Object3D(), []);
  useFrame((_, dt) => {
    const d = Math.min(dt, 0.05);
    columns.forEach((c, i) => {
      const mesh = refs.current[i];
      if (!mesh) return;
      heights.current[i] = damp(heights.current[i] ?? 0, c.height, 3, d);
      const n = Math.min(PER_STACK, Math.round(heights.current[i]! / SHEET));
      mesh.count = n;
      const pitch = n ? heights.current[i]! / n : SHEET;
      for (let k = 0; k < n; k++) {
        m.position.set(((k * 2.3) % 1) * 0.05 - 0.025, 0.02 + k * pitch, ((k * 3.7) % 1) * 0.05 - 0.025);
        m.rotation.y = ((k * 5.1) % 1) * 0.03 - 0.015;
        m.scale.set(1, Math.max(0.6, pitch / SHEET), 1);
        m.updateMatrix();
        mesh.setMatrixAt(k, m.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    });
  });
  return (
    <>
      {columns.map((c, i) => {
        const x = (i - (columns.length - 1) / 2) * 3;
        return (
          <group key={c.id} position={[x, 0, 0]}>
            <instancedMesh ref={r => { refs.current[i] = r; }} args={[undefined, undefined, PER_STACK]} castShadow receiveShadow frustumCulled={false}>
              <boxGeometry args={[2.1, SHEET * 0.92, 1.4]} />
              <meshStandardMaterial color={c.highlight ? "#e8e8ec" : "#fcfcfd"} roughness={0.9} />
            </instancedMesh>
            {c.limit !== undefined && (
              <mesh position={[0, c.limit, 0.72]} castShadow><boxGeometry args={[2.3, 0.025, 0.025]} /><meshStandardMaterial color={METAL} metalness={1} roughness={0.28} /></mesh>
            )}
          </group>
        );
      })}
    </>
  );
}
