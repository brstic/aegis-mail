"use client";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import * as THREE from "three";
import { damp } from "../store";
import { buildEnvironment } from "../gl/paper";

function isDark() {
  const stored = document.documentElement.dataset.theme;
  return stored === "dark" || (stored !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
}

function Room() {
  const { scene, gl } = useThree();
  const sun = useRef<THREE.DirectionalLight>(null);
  const hemi = useRef<THREE.HemisphereLight>(null);
  useEffect(() => { scene.environment = buildEnvironment(gl); return () => { scene.environment?.dispose(); scene.environment = null; }; }, [scene, gl]);
  useLayoutEffect(() => {
    const s = sun.current;
    if (!s) return;
    const c = s.shadow.camera;
    c.left = -13; c.right = 13; c.top = 13; c.bottom = -13; c.near = 1; c.far = 60; c.updateProjectionMatrix();
    s.shadow.bias = -0.0004; s.shadow.normalBias = 0.02; s.shadow.radius = 2.5;
  }, []);
  useFrame(() => {
    const dark = isDark();
    scene.environmentIntensity = dark ? 0.26 : 0.5;
    if (sun.current) { sun.current.intensity = dark ? 2.6 : 1.5; sun.current.color.set(dark ? "#eef1ff" : "#ffffff"); }
    if (hemi.current) { hemi.current.intensity = dark ? 0.34 : 0.84; hemi.current.color.set(dark ? "#23252c" : "#ffffff"); hemi.current.groundColor.set(dark ? "#060607" : "#f4f4f6"); }
  });
  return (
    <>
      <hemisphereLight ref={hemi} />
      <directionalLight ref={sun} position={[-11, 15, 9]} castShadow shadow-mapSize-width={2048} shadow-mapSize-height={2048} />
      <mesh rotation-x={-Math.PI / 2} receiveShadow position={[0, 0, 0]}>
        <planeGeometry args={[80, 80]} />
        <shadowMaterial color="#101014" transparent opacity={0.13} />
      </mesh>
    </>
  );
}

/** Leans the whole scene a little towards the pointer, so it reads as an object on the page and not a picture of one. */
function Lean({ children, amount }: { children: ReactNode; amount: number }) {
  const g = useRef<THREE.Group>(null);
  const p = useRef({ x: 0, y: 0 });
  const { gl } = useThree();
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const r = gl.domElement.getBoundingClientRect();
      // Only while the pointer is over the scene: elsewhere on the page it settles back, so it never seems to move by itself.
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      p.current.x = inside ? ((e.clientX - r.left) / r.width) * 2 - 1 : 0;
      p.current.y = inside ? ((e.clientY - r.top) / r.height) * 2 - 1 : 0;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [gl]);
  useFrame((_, dt) => {
    if (!g.current) return;
    const d = Math.min(dt, 0.05);
    g.current.rotation.y = damp(g.current.rotation.y, p.current.x * amount, 4, d);
    g.current.rotation.x = damp(g.current.rotation.x, p.current.y * amount * 0.4, 4, d);
  });
  return <group ref={g}>{children}</group>;
}

/**
 * Keeps the whole scene in frame on a narrow screen: each scene is framed for a wide box, so when the box is narrower than `aspect`,
 * the camera backs away along its line of sight by the difference instead of cropping the sides.
 */
function Fit({ camera: start, look, aspect }: { camera: [number, number, number]; look: THREE.Vector3; aspect: number }) {
  const { camera, size } = useThree();
  useLayoutEffect(() => {
    const k = Math.max(1, aspect / Math.max(0.3, size.width / Math.max(1, size.height)));
    camera.position.set(look.x + (start[0] - look.x) * k, look.y + (start[1] - look.y) * k, look.z + (start[2] - look.z) * k);
    camera.lookAt(look);
  }, [camera, size.width, size.height, start, look, aspect]);
  return null;
}

export function MiniStage({ children, active, camera, fov = 26, look = [0, 1, 0], lean = 0.1, aspect = 1.6 }: { children: ReactNode; active: boolean; camera: [number, number, number]; fov?: number; look?: [number, number, number]; lean?: number; aspect?: number }) {
  const lookAt = useMemo(() => new THREE.Vector3(...look), [look]);
  return (
    <Canvas
      flat
      frameloop={active ? "always" : "never"}
      dpr={[1, 1.75]}
      shadows="percentage"
      camera={{ position: camera, fov, near: 0.5, far: 200 }}
      gl={{ antialias: true, alpha: true, powerPreference: "default" }}
      onCreated={({ camera: c }) => c.lookAt(lookAt)}
      style={{ position: "absolute", inset: 0 }}
    >
      <Room />
      <Fit camera={camera} look={lookAt} aspect={aspect} />
      <Lean amount={lean}>{children}</Lean>
    </Canvas>
  );
}
