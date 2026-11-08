"use client";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { ch, damp, film, near, smooth, smoother } from "../../store";
import { STATION as S } from "../layout";
import { METAL, canvas, fonts, grain, INK, PAPER, plaqueTexture, texture } from "../paper";

const PLAIN = "Hello Morgan, please find invoice 4471 for October attached to our account. Thanks for your help this quarter. We'll send the next statement on the first of the month.";

function pageTexture(cipher: boolean) {
  const W = 768, H = 512;
  const { c, g } = canvas(W, H);
  const f = fonts();
  g.fillStyle = PAPER; g.fillRect(0, 0, W, H);
  let s = 41;
  const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const noise = "0123456789abcdef+/=$%#@&";
  const text = cipher ? Array.from({ length: PLAIN.length }, (_, i) => (i % 7 === 6 ? " " : noise[Math.floor(r() * noise.length)])).join("") : PLAIN;
  g.fillStyle = cipher ? "#6e6e73" : INK; g.font = cipher ? `500 34px ${f.mono}` : `400 40px ${f.display}`;
  let line = "", y = 72;
  for (const w of text.split(" ")) { const t = line ? `${line} ${w}` : w; if (g.measureText(t).width > W - 80 && line) { g.fillText(line, 40, y); y += 56; line = w; } else line = t; }
  g.fillText(line, 40, y);
  grain(g, W, H);
  return texture(c);
}

/** A key, built up from simple metal parts. */
function Key({ scale = 1 }: { scale?: number }) {
  const m = <meshStandardMaterial color={METAL} metalness={1} roughness={0.25} />;
  return (
    <group scale={scale} rotation={[Math.PI / 2, 0, 0]}>
      <mesh castShadow><torusGeometry args={[0.22, 0.05, 12, 28]} />{m}</mesh>
      <mesh castShadow position={[0.62, 0, 0]} rotation-z={Math.PI / 2}><cylinderGeometry args={[0.04, 0.04, 0.82, 10]} />{m}</mesh>
      <mesh castShadow position={[0.9, -0.1, 0]}><boxGeometry args={[0.07, 0.2, 0.05]} />{m}</mesh>
      <mesh castShadow position={[1.0, -0.08, 0]}><boxGeometry args={[0.06, 0.16, 0.05]} />{m}</mesh>
    </group>
  );
}

/**
 * Envelope encryption, literally: the page sealed under a key, that key sealed in its own envelope, and the envelope in a vault under the root key.
 * Destroy the key and the page turns to noise. That's what deleting an account does.
 */
export function Vault() {
  const root = useRef<THREE.Group>(null);
  const page = useRef<THREE.MeshStandardMaterial>(null);
  const noise = useRef<THREE.MeshStandardMaterial>(null);
  const key = useRef<THREE.Group>(null);
  const wrap = useRef<THREE.Group>(null);
  const wrapMat = useRef<THREE.MeshStandardMaterial>(null);
  const door = useRef<THREE.Group>(null);
  const seal = useRef<THREE.Mesh>(null);
  const ash = useRef<THREE.InstancedMesh>(null);
  const textures = useMemo(() => ({ plain: pageTexture(false), cipher: pageTexture(true), page: plaqueTexture(["Your mail"], { w: 512, h: 128, size: 58 }), mid: plaqueTexture(["Workspace key"], { w: 512, h: 128, size: 50 }), root: plaqueTexture(["Root key"], { w: 512, h: 128, size: 58 }) }), []);
  const state = useRef({ shred: 0, wrapAlpha: 1, since: 0 });
  const seeds = useMemo(() => Array.from({ length: 80 }, (_, i) => ({ a: i * 2.399, r: 0.1 + ((i * 37) % 19) / 19 * 0.9, s: 0.5 + ((i * 13) % 17) / 17 })), []);
  const o = useMemo(() => new THREE.Object3D(), []);

  useFrame((_, dt) => {
    const g = root.current;
    if (!g) return;
    const on = near("vault", 0.5);
    g.visible = on;
    if (!on) return;
    const d = Math.min(dt, 0.05), p = ch("vault"), st = state.current;
    const shredded = film.controls.shredded;
    if (shredded && !st.since) st.since = film.time || 0.001;
    if (!shredded) st.since = 0;
    st.shred = damp(st.shred, shredded ? 1 : 0, 2.2, d);
    // First the page seals, then its key goes into an envelope, then that goes into the vault, and the door shuts.
    const seal1 = smooth(0.12, 0.26, p), wrapIn = smoother(0.28, 0.46, p), toVault = smoother(0.46, 0.64, p), shut = smoother(0.62, 0.74, p);
    if (page.current) { page.current.opacity = 1 - st.shred; page.current.transparent = true; }
    if (noise.current) { noise.current.opacity = Math.max(st.shred, seal1 * 0.85); noise.current.transparent = true; }
    if (seal.current) seal.current.scale.setScalar(seal1 < 0.01 ? 0.001 : seal1);
    if (key.current) {
      key.current.position.set(-0.8 + wrapIn * 3, 1.25 - wrapIn * 0.8, 0.8);
      key.current.visible = wrapIn < 0.96 && !shredded;
    }
    if (wrap.current) {
      wrap.current.position.set(2.3 + toVault * 3.1, 0.42 + toVault * 0.5, 0.8 - toVault * 0.8);
      const s = smooth(0.2, 0.3, p) * (1 - st.shred);
      wrap.current.scale.setScalar(s < 0.01 ? 0.001 : s);
    }
    if (door.current) door.current.rotation.y = 1.6 * (1 - shut) + st.shred * 1.6;
    // What's left of the key.
    const m = ash.current;
    if (m) {
      const age = st.since ? film.time - st.since : 0;
      m.visible = shredded && (age < 3.4 || film.frozen);
      if (m.visible) {
        seeds.forEach((s, i) => {
          const t = film.frozen ? 0.6 : Math.min(1, age / 3.2);
          o.position.set(5.4 + Math.cos(s.a) * s.r * (0.4 + t * 1.2), 0.9 + t * 1.8 * s.s - t * t * 1.4, Math.sin(s.a) * s.r * 0.6 + 0.1);
          o.rotation.set(s.a + t * 5, s.r * 7 + t * 3, t * 4);
          o.scale.setScalar((1 - t) * 0.09 * s.s + 0.001);
          o.updateMatrix(); m.setMatrixAt(i, o.matrix);
        });
        m.instanceMatrix.needsUpdate = true;
      }
    }
  });

  const metal = <meshStandardMaterial color={METAL} metalness={1} roughness={0.28} />;
  return (
    <group ref={root} position={[S.vault - 2.6, 0, 0]}>
      {/* The page. */}
      <group position={[-2.2, 0, 0]}>
        <mesh position={[0, 0.06, 0]} castShadow receiveShadow><boxGeometry args={[4, 0.12, 2.7]} /><meshStandardMaterial color="#e8e8ec" /></mesh>
        <mesh position={[0, 0.122, 0]} rotation-x={-Math.PI / 2}><planeGeometry args={[3.9, 2.6]} /><meshStandardMaterial ref={page} map={textures.plain} roughness={0.9} /></mesh>
        <mesh position={[0, 0.125, 0]} rotation-x={-Math.PI / 2}><planeGeometry args={[3.9, 2.6]} /><meshStandardMaterial ref={noise} map={textures.cipher} roughness={0.9} transparent opacity={0} /></mesh>
        <mesh ref={seal} position={[1.4, 0.16, 0.9]} castShadow scale={0.001}><cylinderGeometry args={[0.3, 0.33, 0.07, 32]} /><meshStandardMaterial color="#0071e3" roughness={0.4} /></mesh>
        <mesh position={[0, 0.02, 1.9]} rotation-x={-Math.PI / 2}><planeGeometry args={[2, 0.5]} /><meshBasicMaterial map={textures.page} transparent toneMapped={false} /></mesh>
      </group>
      <group ref={key}><Key scale={0.8} /></group>
      {/* The key's envelope. */}
      <group ref={wrap} scale={0.001}>
        <mesh castShadow receiveShadow><boxGeometry args={[1.6, 0.05, 1.06]} /><meshStandardMaterial ref={wrapMat} color="#fcfcfd" roughness={0.9} /></mesh>
        <mesh position={[0, 0.03, 0]} rotation-x={-Math.PI / 2}><planeGeometry args={[1.5, 0.38]} /><meshBasicMaterial map={textures.mid} transparent toneMapped={false} /></mesh>
      </group>
      {/* The vault. */}
      <group position={[5.4, 0, 0]}>
        <mesh position={[0, 0.1, 0]} castShadow receiveShadow><boxGeometry args={[3.6, 0.2, 2.9]} /><meshStandardMaterial color="#f7f7f9" roughness={0.88} /></mesh>
        <mesh position={[0, 3.1, 0]} castShadow receiveShadow><boxGeometry args={[3.6, 0.14, 2.9]} /><meshStandardMaterial color="#f7f7f9" roughness={0.88} /></mesh>
        <mesh position={[-1.74, 1.6, 0]} castShadow><boxGeometry args={[0.12, 2.9, 2.9]} /><meshStandardMaterial color="#e8e8ec" /></mesh>
        <mesh position={[1.74, 1.6, 0]} castShadow><boxGeometry args={[0.12, 2.9, 2.9]} /><meshStandardMaterial color="#e8e8ec" /></mesh>
        <mesh position={[0, 1.6, -1.4]} castShadow><boxGeometry args={[3.6, 2.9, 0.1]} /><meshStandardMaterial color="#e8e8ec" /></mesh>
        <group position={[0.2, 3.34, 0]}><Key scale={1.5} /></group>
        <mesh position={[0, 3.72, 0.1]} rotation-x={-0.2}><planeGeometry args={[1.5, 0.38]} /><meshBasicMaterial map={textures.root} transparent toneMapped={false} /></mesh>
        <group ref={door} position={[-1.74, 1.6, 1.42]} rotation-y={1.6}>
          <mesh position={[1.74, 0, 0]} castShadow receiveShadow><boxGeometry args={[3.48, 2.86, 0.1]} /><meshStandardMaterial color="#f2f2f5" roughness={0.85} /></mesh>
          <mesh position={[1.74, 0, 0.07]} castShadow rotation-x={Math.PI / 2}><cylinderGeometry args={[0.46, 0.5, 0.07, 36]} />{metal}</mesh>
        </group>
      </group>
      <instancedMesh ref={ash} args={[undefined, undefined, 80]} frustumCulled={false} visible={false}><planeGeometry args={[1, 1]} /><meshStandardMaterial color="#8e8e93" side={THREE.DoubleSide} /></instancedMesh>
    </group>
  );
}
