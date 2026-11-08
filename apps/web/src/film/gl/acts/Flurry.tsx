"use client";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { ch, clamp, film, lerp, near, smooth, smoother } from "../../store";
import { envelopeTexture } from "../paper";
import { STATION } from "../layout";
import { HERO_PANEL as HP } from "./Hero";
import type { Quality } from "../quality";

const COLORS = ["#ffffff", "#ffffff", "#ffffff", "#ffffff", "#ffffff", "#fafafb", "#f5f5f7", "#f0f0f3"];
const LANES = [-4.2, 0, 4.2];

const m = new THREE.Matrix4(), pos = new THREE.Vector3(), scl = new THREE.Vector3(), tmbl = new THREE.Quaternion(), flat = new THREE.Quaternion(), e = new THREE.Euler(), q = new THREE.Quaternion();

/**
 * All the mail. Each envelope tumbles on its own orbit, and the pointer is a wind that pushes them about. Scrolling on, they
 * pour into three lanes, one per mail source, which close into a single stream at the sorter.
 */
export function Flurry({ q: quality }: { q: Quality }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const n = quality.flurry;
  const time = useRef({ value: 0 });
  const seeds = useMemo(() => {
    let s = 11;
    const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
    return Array.from({ length: n }, (_, i) => ({
      a: r() * Math.PI * 2, rad: 4 + Math.pow(r(), 0.72) * 13, h: 0.6 + r() * 11.5, w: (0.05 + r() * 0.11) * (r() > 0.5 ? 1 : -1),
      f: 0.35 + r() * 0.5, ph: r() * 7, rx: 0.2 + r() * 0.8, ry: 0.15 + r() * 0.6, rz: 0.1 + r() * 0.5, size: 0.62 + r() * 0.42,
      lane: i % 3, delay: r(), jitter: (r() - 0.5) * 1.5, slot: Math.floor(i / 24) / Math.max(1, Math.floor(n / 24)) + (i % 3) * 0.011, flows: i % 24 < 3, fall: 8 + r() * 26, ox: 0, oy: 0, oz: 0,
    }));
  }, [n]);

  const material = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({ map: envelopeTexture(), roughness: 0.95, side: THREE.DoubleSide });
    // Paper bends as it falls.
    mat.onBeforeCompile = shader => {
      shader.uniforms.uTime = time.current;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nuniform float uTime;")
        .replace("#include <begin_vertex>", `#include <begin_vertex>
          float seed = instanceMatrix[3][0] * 1.7 + instanceMatrix[3][2] * 2.3;
          transformed.z += sin(position.x * 2.6 + uTime * 2.2 + seed) * 0.05 + sin(position.y * 3.1 + uTime * 1.5 + seed) * 0.035;`);
    };
    return mat;
  }, []);

  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    let s = 3;
    const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) mesh.setColorAt(i, c.set(r() < 0.02 ? "#0071e3" : COLORS[Math.floor(r() * COLORS.length)]!));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    flat.setFromEuler(e.set(-Math.PI / 2, 0, 0));
  }, [n]);

  useFrame((_, dt) => {
    const mesh = ref.current;
    if (!mesh) return;
    const on = near("flurry", 1) || near("stream", 1);
    mesh.visible = on;
    if (!on) return;
    time.current.value = film.time;
    const t = film.time;
    const d = Math.min(dt, 0.05);
    const pour = ch("stream");
    const lift = smooth(0.55, 1, ch("flurry"));
    const p = film.pointer;
    const moved = Math.min(1.6, Math.hypot(p.wvx, p.wvy, p.wvz) * 3);
    const intro = smoother(0, 1, film.intro);
    const x0 = STATION.stream - 3;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const s = seeds[i]!;
      const a = s.a + t * s.w;
      let x = Math.cos(a) * s.rad, z = Math.sin(a) * s.rad * 0.72;
      let y = s.h + Math.sin(t * s.f + s.ph) * 0.9 - (1 - intro) * -s.fall;

      // Wind: pushed away from the pointer, in the direction it's moving, and drifting back.
      const dx = x + s.ox - p.wx, dy = y + s.oy - p.wy, dz = z + s.oz - p.wz, dd = dx * dx + dy * dy + dz * dz;
      if (dd < 42 && p.seen) {
        const f = (1 - dd / 42) * (1.4 + moved * 3) * d * 14 / Math.max(1.4, Math.sqrt(dd));
        s.ox += (dx + p.wvx * 18) * f; s.oy += (dy + p.wvy * 18) * f * 0.8; s.oz += (dz + p.wvz * 18) * f;
      }
      const back = Math.exp(-0.75 * d);
      s.ox *= back; s.oy *= back; s.oz *= back;
      x += s.ox; y += s.oy; z += s.oz;
      // In front of the product, a letter would hide it: anything that would pass across its face goes behind it instead.
      const hx = film.portrait ? 0 : HP.x;
      if (pour < 0.05 && Math.abs(x - hx) < HP.w / 2 + 0.6 && Math.abs(y - HP.y) < HP.h / 2 + 0.6 && z > HP.z - 1.2) z = HP.z - 1.2 - (z - HP.z + 1.2) * 0.6;
      peak = Math.max(peak, Math.abs(s.ox), Math.abs(s.oy), Math.abs(s.oz));

      // Tumbling, and lying flat as it joins a lane.
      tmbl.setFromEuler(e.set(t * s.rx + s.ph, t * s.ry + s.ph * 2, t * s.rz));
      const k = clamp(pour * 1.6 - s.delay * 0.6);
      let scale = s.size;
      if (k > 0) {
        // Everything comes down. Most of it drops into the lanes and is gone: a few keep flowing, evenly spaced, as the stream.
        const e2 = smoother(0, 1, clamp(k * 2.4));
        const laneOn = film.controls.sources[s.lane] !== false;
        const run = (s.slot + t * 0.055) % 1;
        const along = s.flows ? run : Math.min(1, run * 0.25 + clamp((k - 0.42) / 0.58));
        const close = smooth(0.5, 0.97, along);
        const lz = lerp(LANES[s.lane]!, 0, close);
        const lx = lerp(x0 - 3, STATION.stream + 9.2, along);
        x = lerp(x, lx, e2); z = lerp(z, lz, e2); y = lerp(y, 0.13 + (i % 7) * 0.012, e2);
        q.copy(tmbl).slerp(flat, smooth(0.35, 0.95, e2));
        const gone = (!s.flows && k >= 1) || along >= 0.995 || !laneOn;
        scale = gone ? 0 : s.size * lerp(1, 0.82, e2);
      } else q.copy(tmbl);
      m.compose(pos.set(x, y, z), q, scl.setScalar(scale));
      mesh.setMatrixAt(i, m);
    }
    film.windPeak = peak;
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, n]} frustumCulled={false} castShadow material={material}>
      <planeGeometry args={[1.24, 0.82, 6, 4]} />
    </instancedMesh>
  );
}
