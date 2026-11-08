"use client";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { film, lerp } from "../store";
import { Autopsy } from "./acts/Autopsy";
import { Calm } from "./acts/Calm";
import { Case } from "./acts/Case";
import { Flurry } from "./acts/Flurry";
import { Focus } from "./acts/Focus";
import { Glass } from "./acts/Glass";
import { Hero } from "./acts/Hero";
import { Xray } from "./acts/Xray";
import { Scale } from "./acts/Scale";
import { Seals } from "./acts/Seals";
import { Sorter } from "./acts/Sorter";
import { Uv } from "./acts/Uv";
import { Vault } from "./acts/Vault";
import { view } from "./Camera";
import { Letter } from "./Letter";
import { buildEnvironment, canvas, grain, texture } from "./paper";
import type { Quality } from "./quality";

const DAY = { sun: new THREE.Color("#ffffff"), sky: new THREE.Color("#ffffff"), ground: new THREE.Color("#f4f4f6") };
const NIGHT = { sun: new THREE.Color("#eef1ff"), sky: new THREE.Color("#23252c"), ground: new THREE.Color("#060607") };

/** Sets the fog and background to whatever the page's own background is, so scene and page are one surface. */
function Atmosphere() {
  const scene = useThree(s => s.scene);
  const gl = useThree(s => s.gl);
  const color = useMemo(() => new THREE.Color(film.bg), []);
  useEffect(() => { scene.environment = buildEnvironment(gl); scene.fog = new THREE.Fog(color, 40, 130); scene.background = color; return () => { scene.environment?.dispose(); scene.environment = null; }; }, [scene, gl, color]);
  useFrame(() => { color.set(film.bg); scene.environmentIntensity = lerp(0.5, 0.26, film.night); });
  return null;
}

/** The daylight, and at night the spotlight, follow what the camera is looking at, so the shadow map is spent where it's seen. */
function Lights({ q }: { q: Quality }) {
  const sun = useRef<THREE.DirectionalLight>(null);
  const hemi = useRef<THREE.HemisphereLight>(null);
  const target = useMemo(() => new THREE.Object3D(), []);
  useLayoutEffect(() => {
    if (!sun.current) return;
    sun.current.target = target;
    const c = sun.current.shadow.camera;
    c.left = -24; c.right = 24; c.top = 24; c.bottom = -24; c.near = 1; c.far = 90;
    c.updateProjectionMatrix();
    sun.current.shadow.bias = -0.0004; sun.current.shadow.normalBias = 0.02; sun.current.shadow.radius = 2.5;
  }, [target]);
  useFrame(() => {
    const s = sun.current, h = hemi.current;
    if (!s || !h) return;
    const n = film.night;
    // Long, low light from the side: most of what makes paper look like paper.
    const l = view.look;
    target.position.set(l.x, 0, l.z);
    target.updateMatrixWorld();
    s.position.set(l.x - 19, lerp(24, 18, n), l.z + 15);
    s.color.lerpColors(DAY.sun, NIGHT.sun, n);
    s.intensity = lerp(1.5, 2.6, n);
    h.color.lerpColors(DAY.sky, NIGHT.sky, n);
    h.groundColor.lerpColors(DAY.ground, NIGHT.ground, n);
    h.intensity = lerp(0.84, 0.34, n);
  });
  return (
    <>
      <primitive object={target} />
      <hemisphereLight ref={hemi} />
      <directionalLight ref={sun} castShadow={q.shadows} shadow-mapSize-width={q.shadowSize || 512} shadow-mapSize-height={q.shadowSize || 512} />
    </>
  );
}

/** The desk has no colour of its own: it only receives shadows, on top of the page's background. */
function Desk() {
  const mat = useRef<THREE.ShadowMaterial>(null);
  const pool = useRef<THREE.Mesh>(null);
  const poolMat = useRef<THREE.MeshBasicMaterial>(null);
  const glow = useMemo(() => {
    const { c, g } = canvas(512, 512);
    const r = g.createRadialGradient(256, 256, 8, 256, 256, 256);
    r.addColorStop(0, "rgba(200,212,255,.13)"); r.addColorStop(0.5, "rgba(190,205,255,.05)"); r.addColorStop(1, "rgba(180,200,255,0)");
    g.fillStyle = r; g.fillRect(0, 0, 512, 512);
    return texture(c);
  }, []);
  useFrame(() => {
    if (mat.current) mat.current.opacity = lerp(0.13, 0.6, film.night);
    if (pool.current && poolMat.current) { pool.current.position.set(view.look.x, 0.03, view.look.z); poolMat.current.opacity = film.night; pool.current.visible = film.night > 0.01; }
  });
  return (
    <>
    <mesh ref={pool} rotation-x={-Math.PI / 2} renderOrder={-1}>
      <planeGeometry args={[58, 58]} />
      <meshBasicMaterial ref={poolMat} map={glow} transparent depthWrite={false} blending={THREE.AdditiveBlending} fog={false} />
    </mesh>
    <mesh rotation-x={-Math.PI / 2} position={[140, 0, 0]} receiveShadow>
      <planeGeometry args={[640, 200]} />
      <shadowMaterial ref={mat} color="#101014" transparent fog={false} />
    </mesh>
    </>
  );
}

/** The paper tape the letter rides, printed with ticks. It runs through every scene, and holds the film together. */
function Tape() {
  const mat = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(() => { if (mat.current) mat.current.color.setScalar(lerp(1, 0.09, film.night)); });
  const map = useMemo(() => {
    const { c, g } = canvas(512, 128);
    g.fillStyle = "#ececef"; g.fillRect(0, 0, 512, 128);
    g.strokeStyle = "rgba(30,30,35,.12)"; g.lineWidth = 2;
    for (let x = 0; x < 512; x += 64) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 16); g.moveTo(x, 112); g.lineTo(x, 128); g.stroke(); }
    
    
    const t = texture(c, { repeat: true });
    t.repeat.set(40, 1);
    return t;
  }, []);
  return (
    <mesh rotation-x={-Math.PI / 2} position={[170, 0.012, 0]} receiveShadow>
      <planeGeometry args={[290, 3.1]} />
      <meshStandardMaterial ref={mat} map={map} roughness={0.95} />
    </mesh>
  );
}

/**
 * Compiles every shader and uploads every texture before the fade-in, while nobody's watching. Otherwise each scene stalls the frame
 * the first time it's on screen. Scenes hide themselves when they're far away, so they're all shown for this one moment.
 */
function WarmUp() {
  const { gl, scene, camera } = useThree();
  const done = useRef(false);
  useFrame(() => {
    if (done.current || !film.ready) return;
    done.current = true;
    const hidden: THREE.Object3D[] = [];
    scene.traverse(o => { if (!o.visible) { hidden.push(o); o.visible = true; } });
    gl.compile(scene, camera);
    const seen = new Set<THREE.Texture>();
    scene.traverse(o => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
        const t = (mat as THREE.MeshStandardMaterial).map;
        if (t && !seen.has(t)) { seen.add(t); gl.initTexture(t); }
        const u = (mat as THREE.ShaderMaterial).uniforms;
        if (u) for (const k of Object.keys(u)) { const v = u[k]!.value; if (v?.isTexture && !seen.has(v)) { seen.add(v); gl.initTexture(v); } }
      }
    });
    hidden.forEach(o => { o.visible = false; });
  }, -80);
  return null;
}

export function World({ q }: { q: Quality }) {
  return (
    <>
      <WarmUp />
      <Atmosphere />
      <Lights q={q} />
      <Desk />
      <Tape />
      <Hero />
      <Flurry q={q} />
      <Sorter />
      <Seals />
      <Letter />
      <Autopsy />
      <Xray />
      <Uv />
      <Scale />
      <Case />
      <Focus />
      <Glass />
      <Vault />
      <Calm />
    </>
  );
}
