"use client";
import { useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import { film } from "../store";
import { Track } from "../track";
import { buildShots } from "./shots";

export const view = { camera: null as THREE.PerspectiveCamera | null, look: new THREE.Vector3(), w: 1, h: 1 };

const P = new THREE.Vector3(), L = new THREE.Vector3(), R = new THREE.Vector3(), U = new THREE.Vector3(), F = new THREE.Vector3();
// Reused every frame: allocating here would leave garbage behind 60 times a second, and a collection shows up as a stutter.
const NDC = new THREE.Vector3(), TO = new THREE.Vector3();

export function CameraDirector() {
  const camera = useThree(s => s.camera) as THREE.PerspectiveCamera;
  const size = useThree(s => s.size);
  const track = useRef(new Track(11));
  const builtFor = useRef({ layout: -1, w: 0, h: 0 });
  useFrame(() => {
    if (!film.ready) return;
    if (film.layout !== builtFor.current.layout || size.width !== builtFor.current.w || size.height !== builtFor.current.h) { builtFor.current = { layout: film.layout, w: size.width, h: size.height }; track.current.compile(buildShots(size.width / size.height)); }
    view.camera = camera; view.w = size.width; view.h = size.height;

    const v = track.current.at(film.y);
    P.set(v[0]! + film.camShift, v[1]!, v[2]!); L.set(v[3]! + film.camShift, v[4]!, v[5]!);
    const d = P.distanceTo(L);
    // A held shot still breathes, and leans a little towards the pointer.
    if (!film.frozen) { P.x += Math.sin(film.time * 0.31) * d * 0.002; P.y += Math.sin(film.time * 0.23 + 1.3) * d * 0.0015; }
    F.subVectors(L, P).normalize(); R.crossVectors(F, camera.up).normalize(); U.crossVectors(R, F);
    P.addScaledVector(R, film.pointer.sx * d * 0.012).addScaledVector(U, -film.pointer.sy * d * 0.008);
    camera.position.copy(P);
    camera.lookAt(L);
    camera.fov = v[6]!;
    camera.near = Math.max(0.1, d * 0.05);
    camera.far = d * 30;
    const W = size.width, H = size.height;
    camera.setViewOffset(W, H, (-v[7]! * W) / 2, (v[8]! * H) / 2, W, H);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    view.look.copy(L);

    // Where the pointer is, on a plane through what the camera is looking at. Wind and the lamp use this.
    const p = film.pointer;
    const prev = [p.wx, p.wy, p.wz] as const;
    const ndc = NDC.set(p.sx, -p.sy, 0.5).unproject(camera).sub(camera.position).normalize();
    const n = F;
    const t = TO.copy(L).sub(camera.position).dot(n) / Math.max(1e-4, ndc.dot(n));
    p.wx = camera.position.x + ndc.x * t; p.wy = camera.position.y + ndc.y * t; p.wz = camera.position.z + ndc.z * t;
    p.wvx = p.wx - prev[0]; p.wvy = p.wy - prev[1]; p.wvz = p.wz - prev[2];
  }, -90);
  return null;
}
