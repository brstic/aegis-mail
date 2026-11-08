"use client";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { EVIDENCE } from "../../data/content";
import { ch, damp, film, near, smooth } from "../../store";
import { view } from "../Camera";
import { STATION as S } from "../layout";
import { METAL, canvas, fonts, grain, INK, PAPER, texture } from "../paper";

const SW = 8.4, SH = 5.6;
const CW = 1536, CH = 1024;

function wrap(g: CanvasRenderingContext2D, text: string, x: number, y: number, max: number, lh: number) {
  const words = text.split(" ");
  let line = "", yy = y;
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (g.measureText(t).width > max && line) { g.fillText(line, x, yy); yy += lh; line = w; } else line = t;
  }
  g.fillText(line, x, yy);
  return yy + lh;
}

/** The visible letter, and exactly where the hidden text sits on the page. It's in the message's real markup, written in the page's own colour. */
function letterTextures() {
  const f = fonts();
  const a = canvas(CW, CH);
  a.g.fillStyle = PAPER; a.g.fillRect(0, 0, CW, CH);
  a.g.fillStyle = "#6e6e73"; a.g.font = `500 30px ${f.sans}`; a.g.fillText("From  Harlow Partners  <office@harlow-partners.example>", 96, 92);
  a.g.fillText("Subject  Notes from Tuesday", 96, 134);
  a.g.strokeStyle = "rgba(30,30,35,.2)"; a.g.lineWidth = 2; a.g.beginPath(); a.g.moveTo(96, 166); a.g.lineTo(CW - 96, 166); a.g.stroke();
  a.g.fillStyle = INK; a.g.font = `400 46px ${f.display}`;
  wrap(a.g, EVIDENCE.injection.visible, 96, 248, CW - 192, 66);
  grain(a.g, CW, CH);
  const b = canvas(CW, CH);
  b.g.fillStyle = "#000"; b.g.fillRect(0, 0, CW, CH);
  b.g.fillStyle = "#fff"; b.g.font = `500 40px ${f.mono}`;
  const hiddenEnd = wrap(b.g, EVIDENCE.injection.hidden, 96, 610, CW - 192, 58);
  const hidden = new THREE.CanvasTexture(b.c);
  hidden.colorSpace = THREE.NoColorSpace;
  return { base: texture(a.c), hidden, band: { top: 570, bottom: hiddenEnd } };
}

const VS = `varying vec2 vUv; varying vec3 vP; void main(){ vUv=uv; vec4 w=modelMatrix*vec4(position,1.); vP=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }`;
const FS = `
uniform sampler2D map; uniform sampler2D hiddenMap; uniform vec3 lamp; uniform float radius; uniform float reveal; uniform float dim;
varying vec2 vUv; varying vec3 vP;
void main(){
  float d = distance(vP.xz, lamp.xz);
  float m = max(1.0 - smoothstep(radius * 0.985, radius, d), reveal);
  vec3 base = texture2D(map, vUv).rgb * mix(1.0, 0.7, dim);
  vec3 under = base * vec3(0.93, 0.91, 1.0);
  float h = texture2D(hiddenMap, vUv).r;
  vec3 col = mix(base, under, m);
  col = mix(col, vec3(0.36, 0.2, 0.92), h * m);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.1), ray = new THREE.Raycaster(), hit = new THREE.Vector3(), ndc = new THREE.Vector2();

/**
 * The page under a lamp. Your pointer is the lamp, and what it uncovers is in the message's real markup, written in white on white.
 * Without a pointer, or before it's moved, the lamp sweeps the page by itself.
 */
export function Uv() {
  const root = useRef<THREE.Group>(null);
  const lampObj = useRef<THREE.Group>(null);
  const tex = useMemo(letterTextures, []);
  const uniforms = useMemo(() => ({ map: { value: tex.base }, hiddenMap: { value: tex.hidden }, lamp: { value: new THREE.Vector3(S.uv, 0, 0) }, radius: { value: 1.55 }, reveal: { value: 0 }, dim: { value: 0 } }), [tex]);
  const pos = useRef(new THREE.Vector3(S.uv - 2, 0, 0));
  const sweepFrom = useRef(0);

  useFrame((_, dt) => {
    const g = root.current;
    if (!g) return;
    const on = near("uv", 0.5);
    g.visible = on;
    if (!on) return;
    const d = Math.min(dt, 0.05);
    const p = ch("uv");
    const cam = view.camera;
    const inChapter = p > 0.03 && p < 0.97;
    let tx = S.uv + Math.sin(film.time * 0.55) * 2.8, tz = (610 + 90) / CH * SH - SH / 2 + Math.sin(film.time * 1.1) * 0.5;
    if (film.pointer.seen && cam && inChapter) {
      ndc.set((film.pointer.px / film.vw) * 2 - 1, -(film.pointer.py / film.vh) * 2 + 1);
      ray.setFromCamera(ndc, cam);
      if (ray.ray.intersectPlane(plane, hit)) { tx = hit.x; tz = hit.z; }
    }
    pos.current.x = damp(pos.current.x, tx, 11, d); pos.current.z = damp(pos.current.z, tz, 11, d);
    uniforms.lamp.value.copy(pos.current);
    uniforms.reveal.value = damp(uniforms.reveal.value, film.controls.inspect === "uv-all" ? 1 : 0, 5, d);
    uniforms.dim.value = film.night;
    if (lampObj.current) {
      lampObj.current.position.set(pos.current.x, 0.5, pos.current.z);
      lampObj.current.scale.setScalar(smooth(0.02, 0.1, p) * (1 - smooth(0.93, 1, p)) + 0.001);
    }
    // Tell the page once the lamp has been over the hidden lines.
    const cz = (pos.current.z + SH / 2) / SH * CH;
    // Someone with a pointer finds it themselves. With no pointer, the sweep shows it after giving them a moment to read.
    if (!inChapter) sweepFrom.current = 0; else if (!sweepFrom.current) sweepFrom.current = film.time || 0.001;
    const looked = film.pointer.seen || film.time - sweepFrom.current > 5;
    if (looked && cz > tex.band.top && cz < tex.band.bottom && Math.abs(pos.current.x - S.uv) < SW / 2 && inChapter) {
      if (!film.controls.uvFound) { film.controls.uvFound = true; window.dispatchEvent(new Event("film:uv-found")); }
    }
  });

  return (
    <group ref={root}>
      <mesh position={[S.uv, 0.05, 0]} castShadow receiveShadow><boxGeometry args={[SW, 0.1, SH]} /><meshStandardMaterial color="#e8e8ec" /></mesh>
      <mesh position={[S.uv, 0.103, 0]} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[SW, SH]} />
        <shaderMaterial vertexShader={VS} fragmentShader={FS} uniforms={uniforms} />
      </mesh>
      {/* A magnifier: a thin rim, clear glass and a handle off to the lower right, which is where a hand would hold it. */}
      <group ref={lampObj}>
        <mesh castShadow rotation-x={Math.PI / 2}><torusGeometry args={[1.6, 0.055, 16, 96]} /><meshStandardMaterial color={METAL} metalness={1} roughness={0.22} /></mesh>
        <mesh rotation-x={-Math.PI / 2}><circleGeometry args={[1.58, 96]} /><meshStandardMaterial color="#ffffff" transparent opacity={0.06} roughness={0.05} depthWrite={false} /></mesh>
        <group rotation-y={-Math.PI / 4}>
          <mesh castShadow position={[1.6 + 0.35, 0, 0]} rotation-z={Math.PI / 2}><cylinderGeometry args={[0.06, 0.06, 0.7, 20]} /><meshStandardMaterial color={METAL} metalness={1} roughness={0.25} /></mesh>
          <mesh castShadow position={[1.6 + 1.6, 0, 0]} rotation-z={Math.PI / 2}><cylinderGeometry args={[0.13, 0.13, 1.9, 32]} /><meshStandardMaterial color="#1d1d1f" roughness={0.5} /></mesh>
        </group>
      </group>
    </group>
  );
}
