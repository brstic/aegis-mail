"use client";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { clamp, damp, film, gOf } from "../store";
import { Track } from "../track";
import { LETTER as L, RIDE, SEAL_ON_LETTER, SEAL_X } from "./layout";
import { ACCENT, DANGER, flapTexture, letterBackTexture, sealTexture } from "./paper";
import { buildLetterPath } from "./shots";

/** The checks a letter is stamped with, in the order the arches stamp them. */
export const SEALS = [{ label: "SPF" }, { label: "DKIM" }, { label: "DMARC" }];
const SEAL_POS: [number, number][] = [[-0.9, -0.3], [0, -0.3], [0.9, -0.3]];

function flapGeometry() {
  // One triangle, hinged along its back edge. Bending at the tip keeps it from reading as card.
  const g = new THREE.BufferGeometry();
  const w = L.W / 2, d = L.D * 0.62;
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-w, 0, 0, w, 0, 0, 0, 0, d]), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 1, 1, 1, 0.5, 0]), 2));
  g.setIndex([0, 2, 1]);
  g.computeVertexNormals();
  return g;
}

/**
 * The one letter the film follows. Its path is keyed to the chapters like the camera's. Scenes read `letter` to know where it is,
 * and which seals it has picked up.
 */
export const letter = { x: 0, y: 0, z: 0, open: 0, group: null as THREE.Group | null };

export function Letter() {
  const root = useRef<THREE.Group>(null);
  const flap = useRef<THREE.Group>(null);
  const track = useRef(new Track(8));
  const built = useRef(-1);
  const seals = useRef<(THREE.Group | null)[]>([]);
  const body = useRef<THREE.MeshStandardMaterial>(null);
  const flapTex = useMemo(flapTexture, []);
  const flapGeo = useMemo(flapGeometry, []);
  const backs = useMemo(() => ({ real: letterBackTexture("billing", "acme-supplies.example", false), lookalike: letterBackTexture("billing", "acme-suppl1es.example", true) }), []);
  const faces = useMemo(() => SEALS.map(s => ({ ok: sealTexture(s.label, ACCENT, false), bad: sealTexture(s.label, DANGER, true) })), []);
  const sealMats = useRef<(THREE.MeshStandardMaterial | null)[]>([]);
  const sealSides = useRef<(THREE.MeshStandardMaterial | null)[]>([]);
  const lastSender = useRef<string | null>(null);
  const stamped = useRef([-1, -1, -1]);
  const rel = useRef(0);

  useFrame((_, dt) => {
    const g = root.current;
    if (!g || !film.ready) return;
    if (film.layout !== built.current) { built.current = film.layout; track.current.compile(buildLetterPath()); }
    const v = track.current.at(film.y);
    g.position.set(v[0]!, v[1]!, v[2]!);
    g.rotation.set(v[3]!, v[4]!, v[5]!);
    g.scale.setScalar(v[6]!);
    letter.x = v[0]!; letter.y = v[1]!; letter.z = v[2]!; letter.open = v[7]!; letter.group = g;
    // Before the sorter lets it out, it isn't there. After the autopsy it has its own scenes.
    const from = gOf("stream", 0.72), to = gOf("xray", 0.03), back = gOf("scale", 0.97), end = gOf("focus", 0.05);
    g.visible = (film.y > from && film.y < to) || (film.y > back && film.y < end);
    // Out of the case and back on the tape, if you let it out.
    rel.current = damp(rel.current, film.controls.released ? 1 : 0, 3.4, Math.min(dt, 0.05));
    if (film.y > back) { g.position.z += rel.current * 3.5; g.position.y -= rel.current * (v[1]! - RIDE); }
    if (flap.current) flap.current.rotation.x = -v[7]! * 2.6;
    // Spoofing the real domain breaks all three. A lookalike passes all three, because it really is that domain.
    // From the autopsy on, it's the forged invoice whatever was chosen above: that's the one the rest of the film follows.
    const sender = film.y > gOf("autopsy", 0) ? "lookalike" : film.controls.sender;
    if (sender !== lastSender.current) {
      lastSender.current = sender;
      if (body.current) { body.current.map = sender === "lookalike" ? backs.lookalike : backs.real; body.current.needsUpdate = true; }
      SEALS.forEach((_, i) => { const m = sealMats.current[i]; if (m) { m.map = sender === "spoofed" ? faces[i]!.bad : faces[i]!.ok; m.needsUpdate = true; } sealSides.current[i]?.color.set(sender === "spoofed" ? DANGER : ACCENT); });
    }
    // A seal lands the moment its press touches the letter: both follow where the letter really is, so there's no lag between
    // the stamp and the mark. It stays once the letter has passed, and goes again if you scroll back before the arch.
    const inSeals = film.y >= gOf("seals", 0) - 1;
    SEALS.forEach((_, i) => {
      const sg = seals.current[i];
      if (!sg) return;
      const off = letter.x + SEAL_ON_LETTER[i]! - SEAL_X[i]!;
      const landed = inSeals && off >= -0.3;
      const st = stamped.current;
      if (landed && st[i]! < 0) st[i] = film.time;
      if (!landed) st[i] = -1;
      sg.visible = landed;
      // A quick press: slightly big on contact, settling within a fifth of a second.
      const age = film.frozen ? 1 : clamp((film.time - st[i]!) / 0.18);
      sg.scale.setScalar(landed ? 1 + (1 - age) * 0.18 : 0.001);
    });
  });

  return (
    <group ref={root}>
      <mesh castShadow receiveShadow>
        <boxGeometry args={[L.W, L.T, L.D]} />
        <meshStandardMaterial attach="material-0" color="#e8e8ec" roughness={0.9} />
        <meshStandardMaterial attach="material-1" color="#e8e8ec" roughness={0.9} />
        <meshStandardMaterial attach="material-2" ref={body} map={backs.real} roughness={0.88} />
        <meshStandardMaterial attach="material-3" color="#f2f2f5" roughness={0.9} />
        <meshStandardMaterial attach="material-4" color="#e8e8ec" roughness={0.9} />
        <meshStandardMaterial attach="material-5" color="#e8e8ec" roughness={0.9} />
      </mesh>
      <group ref={flap} position={[0, L.T / 2 + 0.006, -L.D / 2]}>
        <mesh geometry={flapGeo} castShadow receiveShadow>
          <meshStandardMaterial map={flapTex} roughness={0.9} side={THREE.DoubleSide} />
        </mesh>
      </group>
      {SEALS.map((s, i) => (
        <group key={s.label} ref={g => { seals.current[i] = g; }} position={[SEAL_POS[i]![0], L.T / 2 + 0.022, SEAL_POS[i]![1]]} visible={false}>
          <mesh castShadow>
            <cylinderGeometry args={[0.34, 0.345, 0.04, 48]} />
            <meshStandardMaterial ref={m => { sealSides.current[i] = m; }} color={ACCENT} roughness={0.6} />
          </mesh>
          {/* The face is its own circle: a cylinder's cap maps its texture sideways. */}
          <mesh position={[0, 0.0215, 0]} rotation-x={-Math.PI / 2}>
            <circleGeometry args={[0.34, 48]} />
            <meshStandardMaterial ref={m => { sealMats.current[i] = m; }} map={faces[i]!.ok} roughness={0.6} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
