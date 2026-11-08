"use client";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { damp, film, near } from "../../store";
import { STATION as S } from "../layout";
import { METAL, canvas, fonts, grain, INK, plaqueTexture, texture } from "../paper";

const W = 5.2, H = 3.5, D = 3.7;

function auditTexture(released: boolean) {
  const CW = 1024, CH = 512;
  const { c, g } = canvas(CW, CH);
  const f = fonts();
  g.fillStyle = "#ffffff"; g.fillRect(0, 0, CW, CH);
  g.fillStyle = INK; g.font = `500 44px ${f.mono}`;
  const rows = ["Audit log", "held    risk: malicious", released ? "released    by you" : "- - - - - - - - - - -"];
  rows.forEach((r, i) => g.fillText(r, 44, 90 + i * 110));
  grain(g, CW, CH);
  return texture(c);
}

/** Not a bin. A glass case with the letter inside it, a front that really opens, and a slip of paper recording what happened. */
export function Case() {
  const root = useRef<THREE.Group>(null);
  const door = useRef<THREE.Group>(null);
  const slip = useRef<THREE.Mesh>(null);
  const slipMat = useRef<THREE.MeshStandardMaterial>(null);
  const plaque = useMemo(() => plaqueTexture(["Blocked"], { w: 640, h: 160, size: 78 }), []);
  const audit = useMemo(() => ({ held: auditTexture(false), released: auditTexture(true) }), []);
  const last = useRef(false);
  const glass = <meshStandardMaterial color="#eef1f5" transparent opacity={0.16} roughness={0.05} metalness={0.15} side={THREE.DoubleSide} depthWrite={false} />;
  const bar = <meshStandardMaterial color={METAL} metalness={1} roughness={0.28} />;

  useFrame((_, dt) => {
    const g = root.current;
    if (!g) return;
    const on = near("case", 0.5);
    g.visible = on;
    if (!on) return;
    const d = Math.min(dt, 0.05);
    const r = film.controls.released;
    if (door.current) door.current.rotation.y = damp(door.current.rotation.y, r ? -1.9 : 0, 5, d);
    if (r !== last.current) { last.current = r; if (slipMat.current) { slipMat.current.map = r ? audit.released : audit.held; slipMat.current.needsUpdate = true; } }
  });

  const posts: [number, number][] = [[-W / 2, -D / 2], [W / 2, -D / 2], [-W / 2, D / 2], [W / 2, D / 2]];
  return (
    <group ref={root} position={[S.case, 0, 0]}>
      <mesh position={[0, 0.2, 0]} castShadow receiveShadow><boxGeometry args={[W + 0.5, 0.4, D + 0.5]} /><meshStandardMaterial color="#f2f2f5" roughness={0.85} /></mesh>
      <mesh position={[0, 0.2, D / 2 + 0.253]}><planeGeometry args={[2.3, 0.3]} /><meshBasicMaterial map={plaque} transparent toneMapped={false} /></mesh>
      {posts.map(([x, z]) => <mesh key={`${x}${z}`} position={[x, 0.4 + H / 2, z]} castShadow><boxGeometry args={[0.07, H, 0.07]} />{bar}</mesh>)}
      <mesh position={[0, 0.4 + H, 0]} castShadow receiveShadow><boxGeometry args={[W + 0.14, 0.06, D + 0.14]} /><meshStandardMaterial color="#f7f7f9" roughness={0.88} /></mesh>
      <mesh position={[0, 0.4 + H / 2, -D / 2]}><planeGeometry args={[W, H]} />{glass}</mesh>
      <mesh position={[-W / 2, 0.4 + H / 2, 0]} rotation-y={Math.PI / 2}><planeGeometry args={[D, H]} />{glass}</mesh>
      <mesh position={[W / 2, 0.4 + H / 2, 0]} rotation-y={Math.PI / 2}><planeGeometry args={[D, H]} />{glass}</mesh>
      {/* The front, hinged on the left. */}
      <group ref={door} position={[-W / 2, 0.4 + H / 2, D / 2]}>
        <mesh position={[W / 2, 0, 0]}><planeGeometry args={[W, H]} />{glass}</mesh>
        <mesh position={[W - 0.2, 0, 0.05]} castShadow><boxGeometry args={[0.06, 0.8, 0.06]} />{bar}</mesh>
        <mesh position={[W / 2, H / 2, 0]} castShadow><boxGeometry args={[W, 0.05, 0.05]} />{bar}</mesh>
        <mesh position={[W / 2, -H / 2 + 0.03, 0]} castShadow><boxGeometry args={[W, 0.05, 0.05]} />{bar}</mesh>
      </group>
      <mesh ref={slip} position={[W / 2 + 1.5, 0.02, 0.6]} rotation={[-Math.PI / 2, 0, 0.1]} receiveShadow castShadow>
        <planeGeometry args={[2.1, 1.05]} />
        <meshStandardMaterial ref={slipMat} map={audit.held} roughness={0.9} />
      </mesh>
    </group>
  );
}
