"use client";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { damp, smooth } from "../../store";

/**
 * Beside the sign-in form: the AI as a shield around your inbox. Mail flies in from all sides. Ordinary letters pass through and are taken
 * in by the core. A threat meets the shield, sends a ring across it, and comes apart. Decorative: the form beside it is the page.
 * The labels it announces are kinds of attack the engine checks for, shown as examples, not live data.
 */
export const THREATS = ["Exploit PDF", "Fake sign-in page", "Lookalike domain", "Payment-change scam", "Malicious script", "HTML smuggling", "Hidden AI instructions"];

const R = 2.7, COUNT = 18, HITS = 4, BURST = 260;
const BLUE = new THREE.Color("#2997ff"), RED = new THREE.Color("#ff453a");

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d")!;
  draw(g);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

function envelopeTex(threat: boolean) {
  return canvasTex(256, 168, g => {
    g.clearRect(0, 0, 256, 168);
    g.fillStyle = threat ? "#ffe8e6" : "#f5f7fb"; g.beginPath(); g.roundRect(4, 4, 248, 160, 16); g.fill();
    g.strokeStyle = threat ? "#ff6b61" : "#c5cbd6"; g.lineWidth = 6; g.lineJoin = "round";
    g.beginPath(); g.moveTo(16, 18); g.lineTo(128, 96); g.lineTo(240, 18); g.stroke();
    if (threat) { g.fillStyle = "#ff453a"; g.beginPath(); g.arc(214, 128, 18, 0, 7); g.fill(); g.fillStyle = "#fff"; g.font = "700 26px system-ui"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("!", 214, 130); }
  });
}

function dotTex() {
  return canvasTex(64, 64, g => {
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.35, "rgba(255,255,255,.55)"); r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  });
}

const shieldVert = /* glsl */ `
  varying vec3 vN; varying vec3 vV; varying vec3 vP;
  void main() {
    vP = normalize(position);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vN = normalize(mat3(modelMatrix) * normal);
    vV = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;
const shieldFrag = /* glsl */ `
  uniform float uTime; uniform float uPulse; uniform float uSoft; uniform float uRing; uniform vec3 uBlue; uniform vec3 uRed;
  uniform vec3 uHit[${HITS}]; uniform float uAge[${HITS}];
  varying vec3 vN; varying vec3 vV; varying vec3 vP;
  void main() {
    float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 3.2);
    // A fine grid of latitude and longitude, like a field.
    float lat = asin(clamp(vP.y, -1.0, 1.0)) * 18.0 / 3.14159;
    float lon = atan(vP.z, vP.x) * 24.0 / 3.14159;
    float grid = max(1.0 - smoothstep(0.0, 0.06, abs(fract(lat) - 0.5) - 0.44), 1.0 - smoothstep(0.0, 0.06, abs(fract(lon) - 0.5) - 0.44));
    // A scan that sweeps up the shield.
    float scan = exp(-pow((vP.y - (fract(uTime * 0.18) * 2.4 - 1.2)) * 7.0, 2.0));
    float ring = 0.0;
    for (int i = 0; i < ${HITS}; i++) {
      float a = uAge[i];
      if (a < 0.0 || a > 1.0) continue;
      float d = distance(vP, uHit[i]);
      ring += exp(-pow((d - a * 0.9) * 11.0, 2.0)) * (1.0 - a) * 1.1 + exp(-d * 11.0) * (1.0 - a) * 0.6;
    }
    ring = clamp(ring, 0.0, 1.0) * uRing;
    float a = f * (0.6 + uPulse * 0.5) + grid * (0.07 + f * 0.4) + scan * 0.14 + ring;
    vec3 col = mix(uBlue, uRed, ring);
    gl_FragColor = vec4(col * (1.0 + f * 0.6), clamp(a * uSoft, 0.0, 1.0));
  }`;

interface Letter { dir: THREE.Vector3; axis: THREE.Vector3; t: number; dur: number; threat: boolean; wait: number; spin: number; label: number }

function Scene({ busy, open, onBlock }: { busy: boolean; open: boolean; onBlock?: (label: string) => void }) {
  const { camera, gl } = useThree();
  const world = useRef<THREE.Group>(null);
  const shield = useRef<THREE.Mesh>(null);
  const rings = useRef<THREE.Group>(null);
  const core = useRef<THREE.Mesh>(null);
  const coreGlow = useRef<THREE.Mesh>(null);
  const stars = useRef<THREE.Points>(null);
  const meshes = useRef<(THREE.Mesh | null)[]>([]);
  const mats = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const burst = useRef<THREE.Points>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const [light, setLight] = useState(false);
  useEffect(() => {
    const read = () => { const t = document.documentElement.dataset.theme; setLight(t === "light" || (t !== "dark" && !matchMedia("(prefers-color-scheme: dark)").matches)); };
    read();
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", read); window.addEventListener("aegis:theme", read);
    return () => { mq.removeEventListener("change", read); window.removeEventListener("aegis:theme", read); };
  }, []);
  const st = useRef({ open: 0, busy: 0, hit: 0, labelAt: 0 });
  const tex = useMemo(() => ({ safe: envelopeTex(false), threat: envelopeTex(true), dot: dotTex() }), []);
  const uniforms = useMemo(() => ({
    uTime: { value: 0 }, uPulse: { value: 0 }, uSoft: { value: 1 }, uRing: { value: 1 }, uBlue: { value: BLUE.clone() }, uRed: { value: RED.clone() },
    uHit: { value: Array.from({ length: HITS }, () => new THREE.Vector3(0, 1, 0)) }, uAge: { value: Array.from({ length: HITS }, () => -1) },
  }), []);
  // On a light page a solid rim reads as a hard blue edge around the card, so it is fainter and paler there.
  useEffect(() => { uniforms.uBlue.value.set(light ? "#6aa6ee" : "#2997ff"); uniforms.uSoft.value = light ? 0.26 : 1; uniforms.uRing.value = light ? 0.45 : 1; }, [light, uniforms]);
  const letters = useMemo<Letter[]>(() => Array.from({ length: COUNT }, (_, i) => spawn({} as Letter, i, true)), []);
  const starGeo = useMemo(() => {
    const n = 700, p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const v = new THREE.Vector3().randomDirection().multiplyScalar(12 + Math.random() * 22); p.set([v.x, v.y, v.z], i * 3); }
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(p, 3)); return g;
  }, []);
  const pool = useMemo(() => {
    const pos = new Float32Array(BURST * 3), vel = new Float32Array(BURST * 3), life = new Float32Array(BURST);
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return { g, pos, vel, life, next: 0 };
  }, []);

  function spawn(l: Letter, i: number, first = false): Letter {
    l.dir = new THREE.Vector3().randomDirection();
    l.dir.z = l.dir.z * 0.45; l.dir.y = Math.min(l.dir.y, 0.35) * 0.8; l.dir.normalize();
    l.axis = new THREE.Vector3().randomDirection();
    l.dur = 3.2 + Math.random() * 2.4;
    l.t = first ? -Math.random() * 0.5 - i * 0.07 : -Math.random() * 0.6;
    l.threat = Math.random() < 0.34;
    l.spin = (Math.random() - 0.5) * 2;
    l.label = Math.floor(Math.random() * THREATS.length);
    l.wait = 0;
    return l;
  }

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const r = gl.domElement.getBoundingClientRect();
      pointer.current.x = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
      pointer.current.y = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [gl]);

  useFrame(({ clock }, dt) => {
    const d = Math.min(dt, 0.05), t = clock.elapsedTime, s = st.current;
    s.open = damp(s.open, open ? 1 : 0, 3.4, d);
    s.busy = damp(s.busy, busy ? 1 : 0, 5, d);
    uniforms.uTime.value = t;
    uniforms.uPulse.value = s.busy * (0.5 + 0.5 * Math.sin(t * 7)) + s.open;
    for (let i = 0; i < HITS; i++) if (uniforms.uAge.value[i]! >= 0) { uniforms.uAge.value[i]! += d / 1.1; if (uniforms.uAge.value[i]! > 1) uniforms.uAge.value[i] = -1; }

    if (world.current) {
      world.current.rotation.y = damp(world.current.rotation.y, pointer.current.x * 0.35, 2.5, d);
      world.current.rotation.x = damp(world.current.rotation.x, pointer.current.y * 0.18, 2.5, d);
    }
    if (shield.current) { shield.current.rotation.y = t * 0.05; shield.current.scale.setScalar(1 + s.open * 0.6 + Math.sin(t * 1.3) * 0.006); }
    const beat = 1 + Math.sin(t * (busy ? 7 : 2)) * (0.04 + s.busy * 0.08);
    if (core.current) { core.current.scale.setScalar(0.17 * beat * (1 - s.open * 0.6)); core.current.visible = s.open < 0.6; }
    if (coreGlow.current) { coreGlow.current.quaternion.copy(camera.quaternion); coreGlow.current.scale.setScalar((1.6 + s.open * 6 + s.busy * 0.8) * beat); }
    if (stars.current) stars.current.rotation.y = t * 0.012;
    if (rings.current) { rings.current.children[0]!.rotation.z = t * 0.25; rings.current.children[1]!.rotation.z = -t * 0.18; rings.current.scale.setScalar(1 + s.open * 0.8); rings.current.visible = s.open < 0.2; }
    // Signed in: the camera goes into the shield.
    camera.position.z = 10.5 - smooth(0, 1, s.open) * 7.5;

    letters.forEach((l, i) => {
      const m = meshes.current[i], mat = mats.current[i];
      if (!m || !mat) return;
      l.t += d / l.dur;
      if (l.t < 0) { m.visible = false; return; }
      // Fly in from far away, curving a little, to the surface.
      const k = Math.min(l.t, 1);
      const r = THREE.MathUtils.lerp(8.5, R, smooth(0, 1, k) * 0.15 + k * 0.85);
      const swirl = (1 - k) * 1.2;
      m.position.copy(l.dir).applyAxisAngle(l.axis, swirl).multiplyScalar(r);
      m.quaternion.copy(camera.quaternion);
      m.rotateZ(l.spin * (1 - k) + Math.sin(t + i) * 0.1);
      let scale = 0.56, alpha = smooth(0, 0.12, l.t);
      if (l.t >= 1) {
        if (l.threat) {
          // It meets the shield and comes apart.
          if (l.wait === 0) {
            l.wait = 0.001;
            const h = s.hit++ % HITS;
            uniforms.uHit.value[h]!.copy(m.position).applyMatrix4(new THREE.Matrix4().copy(shield.current!.matrix).invert()).normalize();
            uniforms.uAge.value[h] = 0;
            for (let b = 0; b < 26; b++) {
              const j = pool.next++ % BURST, v = new THREE.Vector3().randomDirection().multiplyScalar(0.8 + Math.random() * 2.2).addScaledVector(l.dir, 1.4);
              pool.pos.set([m.position.x, m.position.y, m.position.z], j * 3); pool.vel.set([v.x, v.y, v.z], j * 3); pool.life[j] = 1;
            }
            if (t - s.labelAt > 1.2) { s.labelAt = t; onBlock?.(THREATS[l.label]!); }
          }
          l.wait += d;
          scale *= Math.max(0.001, 1 - l.wait * 4); alpha *= Math.max(0, 1 - l.wait * 4);
          if (l.wait > 0.5) spawn(l, i);
        } else {
          // It passes through and is taken in by the core.
          const q = Math.min(1, (l.t - 1) * l.dur / 0.9);
          m.position.multiplyScalar(1 - q * 0.9);
          scale *= 1 - q * 0.85; alpha *= 1 - smooth(0.5, 1, q);
          if (q >= 1) spawn(l, i);
        }
      }
      if (mat.map !== (l.threat ? tex.threat : tex.safe)) { mat.map = l.threat ? tex.threat : tex.safe; mat.needsUpdate = true; }
      mat.opacity = alpha;
      m.scale.setScalar(scale);
      m.visible = alpha > 0.01;
    });

    // The pieces of each threat drift out and fade.
    for (let j = 0; j < BURST; j++) {
      if (pool.life[j]! <= 0) { pool.pos[j * 3 + 1] = 9999; continue; }
      pool.life[j]! -= d * 1.1;
      pool.pos[j * 3]! += pool.vel[j * 3]! * d; pool.pos[j * 3 + 1]! += pool.vel[j * 3 + 1]! * d; pool.pos[j * 3 + 2]! += pool.vel[j * 3 + 2]! * d;
      pool.vel[j * 3]! *= 0.96; pool.vel[j * 3 + 1]! *= 0.96; pool.vel[j * 3 + 2]! *= 0.96;
    }
    (pool.g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  });

  return (
    <group ref={world} position={[0, -0.1, 0]}>
      <points ref={stars} geometry={starGeo}><pointsMaterial map={tex.dot} size={0.09} sizeAttenuation transparent opacity={light ? 0.35 : 0.55} depthWrite={false} color={light ? "#7d93bd" : "#9fb8ff"} /></points>
      <mesh ref={shield} renderOrder={2}>
        <icosahedronGeometry args={[R, 24]} />
        <shaderMaterial vertexShader={shieldVert} fragmentShader={shieldFrag} uniforms={uniforms} transparent depthWrite={false} blending={light ? THREE.NormalBlending : THREE.AdditiveBlending} side={THREE.DoubleSide} />
      </mesh>
      <group ref={rings}>
        <mesh rotation={[1.25, 0.2, 0]}><torusGeometry args={[R * 1.32, 0.006, 8, 160]} /><meshBasicMaterial color={light ? "#0071e3" : "#5ab0ff"} transparent opacity={light ? 0.3 : 0.45} depthWrite={false} toneMapped={false} /></mesh>
        <mesh rotation={[1.9, -0.5, 0]}><torusGeometry args={[R * 1.55, 0.004, 8, 160]} /><meshBasicMaterial color={light ? "#0071e3" : "#5ab0ff"} transparent opacity={light ? 0.18 : 0.25} depthWrite={false} toneMapped={false} /></mesh>
      </group>
      <mesh ref={core}><sphereGeometry args={[1, 48, 24]} /><meshBasicMaterial color={light ? "#8fbaf3" : "#cfe6ff"} toneMapped={false} /></mesh>
      <mesh ref={coreGlow} renderOrder={3}><planeGeometry args={[1, 1]} /><meshBasicMaterial map={tex.dot} color="#2997ff" transparent opacity={light ? 0.55 : 1} blending={light ? THREE.NormalBlending : THREE.AdditiveBlending} depthWrite={false} toneMapped={false} /></mesh>
      {letters.map((_, i) => (
        <mesh key={i} ref={m => { meshes.current[i] = m; }} visible={false} renderOrder={4}>
          <planeGeometry args={[1, 0.66]} />
          <meshBasicMaterial ref={m => { mats.current[i] = m; }} map={tex.safe} transparent depthWrite={false} toneMapped={false} />
        </mesh>
      ))}
      <points ref={burst} geometry={pool.g} renderOrder={5}><pointsMaterial map={tex.dot} size={0.14} sizeAttenuation transparent depthWrite={false} blending={THREE.AdditiveBlending} color="#ff6b61" /></points>
    </group>
  );
}

export default function ShieldMini({ busy = false, open = false, onBlock, active = true }: { busy?: boolean; open?: boolean; onBlock?: (label: string) => void; active?: boolean }) {
  return (
    <Canvas
      flat
      frameloop={active ? "always" : "never"}
      dpr={[1, 1.75]}
      camera={{ position: [0, 0.2, 10.5], fov: 38, near: 0.1, far: 120 }}
      gl={{ antialias: true, alpha: true, powerPreference: "default" }}
      style={{ position: "absolute", inset: 0 }}
    >
      <Scene busy={busy} open={open} onBlock={onBlock} />
    </Canvas>
  );
}
