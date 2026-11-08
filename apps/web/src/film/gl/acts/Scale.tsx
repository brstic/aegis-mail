"use client";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, type RefObject } from "react";
import * as THREE from "three";
import { EVIDENCE, RISK_LABEL } from "../../data/content";
import { ch, clamp, damp, film, near } from "../../store";
import { STATION as S } from "../layout";
import { DANGER, METAL, plaqueTexture } from "../paper";

const ARM = 4.2, HANG = 2.1, TOP = 5, MAX = 14;
const RED = "#e5484d", BLUE = "#0071e3";

/**
 * A balance. Each finding the engine made for the chosen message is a coin, as thick as its weight: red on the side that says something's
 * wrong, blue on the side that says it's fine. The tilt is their sum. The findings themselves, with their numbers, are in the text beside it.
 */
export function Scale() {
  const root = useRef<THREE.Group>(null);
  const beam = useRef<THREE.Group>(null);
  const panL = useRef<THREE.Group>(null);
  const panR = useRef<THREE.Group>(null);
  const coins = useRef<(THREE.Mesh | null)[]>([]);
  const mats = useRef<(THREE.MeshStandardMaterial | null)[]>([]);
  const verdict = useMemo(() => EVIDENCE.samples.map(s => plaqueTexture([RISK_LABEL[s.label] ?? s.label], { w: 640, h: 150, size: 70, ink: s.label === "safe" ? BLUE : DANGER })), []);
  const verdictMat = useRef<THREE.MeshBasicMaterial>(null);
  const state = useRef({ sample: -1, since: 0, tilt: 0 });

  useFrame((_, dt) => {
    const g = root.current;
    if (!g) return;
    const on = near("scale", 0.5);
    g.visible = on;
    if (!on) return;
    const s = state.current, d = Math.min(dt, 0.05), p = ch("scale");
    const idx = film.controls.sample, started = p > 0.03;
    if (idx !== s.sample || (started && s.since === 0)) {
      s.sample = idx; s.since = started ? film.time || 0.001 : 0;
      if (verdictMat.current) { verdictMat.current.map = verdict[idx]!; verdictMat.current.needsUpdate = true; }
    }
    if (!started) s.since = 0;
    const ev = EVIDENCE.samples[idx]!.evidence;
    const age = s.since ? film.time - s.since : 0;
    let sum = 0;
    const stack = [0, 0];
    for (let i = 0; i < MAX; i++) {
      const c = coins.current[i], e = ev[i];
      if (!c) continue;
      if (!e) { c.visible = false; continue; }
      const side = e.weight > 0 ? 1 : 0;
      const land = film.frozen ? 1 : clamp((age - i * 0.18) / 0.5);
      const h = 0.04 + Math.abs(e.weight) * 0.045;
      const pan = side ? panR.current : panL.current;
      if (pan && c.parent !== pan) pan.add(c);
      const y = 0.06 + stack[side]! + h / 2;
      c.position.set(0, y + (1 - land) * (1 - land) * 6, 0);
      c.scale.set(1, h, 1);
      c.visible = started && (film.frozen || age > i * 0.18);
      mats.current[i]?.color.set(side ? RED : BLUE);
      stack[side] = stack[side]! + h + 0.006;
      if (land > 0.8) sum += e.weight;
    }
    const target = Math.tanh(sum / 6) * 0.26;
    s.tilt = film.frozen ? target : damp(s.tilt, target, 3, d);
    if (beam.current) beam.current.rotation.z = -s.tilt;
    const yL = Math.sin(s.tilt) * ARM, xc = Math.cos(s.tilt) * ARM;
    panL.current?.position.set(-xc, TOP + yL - HANG, 0);
    panR.current?.position.set(xc, TOP - yL - HANG, 0);
  });

  const metal = <meshStandardMaterial color={METAL} metalness={1} roughness={0.25} />;
  const pan = (ref: RefObject<THREE.Group | null>) => (
    <group ref={ref}>
      <mesh castShadow receiveShadow><cylinderGeometry args={[1.25, 1.15, 0.08, 64]} />{metal}</mesh>
      <mesh position={[0, HANG / 2, 0]} castShadow><cylinderGeometry args={[0.025, 0.025, HANG, 12]} />{metal}</mesh>
    </group>
  );

  return (
    <group ref={root} position={[S.scale, 0, 0]}>
      <mesh castShadow receiveShadow position={[0, 0.06, 0]}><cylinderGeometry args={[1.3, 1.4, 0.12, 64]} />{metal}</mesh>
      <mesh castShadow position={[0, TOP / 2, 0]}><cylinderGeometry args={[0.07, 0.1, TOP, 32]} />{metal}</mesh>
      <group ref={beam} position={[0, TOP, 0]}>
        <mesh castShadow rotation-z={Math.PI / 2}><cylinderGeometry args={[0.06, 0.06, ARM * 2 + 0.3, 24]} />{metal}</mesh>
        <mesh castShadow><sphereGeometry args={[0.16, 32, 16]} />{metal}</mesh>
      </group>
      {pan(panL)}
      {pan(panR)}
      {Array.from({ length: MAX }, (_, i) => (
        <mesh key={i} ref={m => { coins.current[i] = m; }} castShadow receiveShadow visible={false}>
          <cylinderGeometry args={[0.56, 0.56, 1, 48]} />
          <meshStandardMaterial ref={m => { mats.current[i] = m; }} color={RED} roughness={0.42} />
        </mesh>
      ))}
      <mesh position={[0, 0.5, 2.6]} rotation-x={-0.5}><planeGeometry args={[3.4, 0.8]} /><meshBasicMaterial ref={verdictMat} transparent toneMapped={false} /></mesh>
    </group>
  );
}
