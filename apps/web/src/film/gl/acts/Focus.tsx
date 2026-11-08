"use client";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { FOCUS_MESSAGES } from "@/components/marketing/demo-data";
import { ch, clamp, damp, film, near, smoother } from "../../store";
import { view } from "../Camera";
import { STATION as S } from "../layout";
import { ACCENT, METAL, canvas, DANGER, fonts, grain, INK, PAPER, plaqueTexture, texture } from "../paper";

/** Top to bottom, in the order the product's Focus view uses. Security review is apart from these, on its own tray. */
export const SHELVES = [
  { key: "needs_attention", label: "Needs your attention" },
  { key: "todays_commitments", label: "Today's commitments" },
  { key: "important_people", label: "Important people" },
  { key: "low_priority", label: "Low priority" },
] as const;

const CARD_W = 2.25, CARD_H = 1.36, SHELF_W = 10.4;
const shelfY = (i: number) => 6.1 - i * 1.95;
const shelfZ = (i: number) => -1.5 + i * 0.75;

function cardTexture(from: string, subject: string, flagged: boolean, reason: string) {
  const W = 640, H = 384;
  const { c, g } = canvas(W, H);
  const f = fonts();
  g.fillStyle = PAPER; g.fillRect(0, 0, W, H);
  g.fillStyle = flagged ? DANGER : ACCENT; g.fillRect(0, 0, 10, H);
  g.fillStyle = INK; g.font = `600 36px ${f.sans}`; g.fillText(from.slice(0, 24), 36, 66, W - 60);
  g.font = `400 44px ${f.display}`;
  const words = subject.split(" "); let line = "", y = 138, n = 0;
  for (const w of words) { const t = line ? `${line} ${w}` : w; if (g.measureText(t).width > W - 70 && line) { g.fillText(line, 36, y); y += 56; line = w; n++; if (n >= 3) { line = ""; break; } } else line = t; }
  if (line) g.fillText(line, 36, y);
  // The slip that says why it's here.
  g.fillStyle = flagged ? "#fdecec" : "#e8f1fb"; g.fillRect(10, H - 68, W - 10, 68);
  g.fillStyle = flagged ? DANGER : ACCENT; g.font = `500 27px ${f.sans}`; g.fillText(reason.slice(0, 44), 36, H - 24, W - 60);
  g.strokeStyle = "rgba(30,30,35,.14)"; g.lineWidth = 3; g.strokeRect(1, 1, W - 2, H - 2);
  grain(g, W, H);
  return texture(c);
}

const plane = new THREE.Plane(), ray = new THREE.Raycaster(), hit = new THREE.Vector3(), ndc = new THREE.Vector2(), Z = new THREE.Vector3(0, 0, 1), AT = new THREE.Vector3(0, 0, 3);

/** The mail that's left, on shelves, in order. Each card says why it's there. Pick one up and put it on another shelf. */
export function Focus() {
  const root = useRef<THREE.Group>(null);
  const cards = useRef<(THREE.Group | null)[]>([]);
  const messages = FOCUS_MESSAGES;
  const maps = useMemo(() => messages.map(m => cardTexture(m.fromName, m.subject, m.section === "security_review", m.reasons[0] ?? "")), [messages]);
  const labels = useMemo(() => SHELVES.map(s => plaqueTexture([s.label], { w: 768, h: 128, size: 62 })), []);
  const tray = useMemo(() => plaqueTexture(["Security review"], { w: 640, h: 128, size: 62, ink: DANGER }), []);
  const drag = useRef<{ i: number } | null>(null);
  const places = useRef(messages.map(() => ({ x: 0, y: 0, z: 0, lift: 0 })));

  useFrame((_, dt) => {
    const g = root.current;
    if (!g) return;
    const on = near("focus", 0.5);
    g.visible = on;
    if (!on) return;
    const p = ch("focus"), d = Math.min(dt, 0.05);
    const c = film.controls;
    // Who's on which shelf, after anything the visitor moved.
    const counts = [0, 0, 0, 0];
    let trayCount = 0;
    const cam = view.camera;
    messages.forEach((m, i) => {
      const card = cards.current[i], place = places.current[i]!;
      if (!card) return;
      const shelfIndex = m.section === "security_review" ? -1 : c.shelfOf[m.id] ?? SHELVES.findIndex(s => s.key === m.section);
      let x: number, y: number, z: number;
      if (shelfIndex < 0) { x = S.focus + 3.1 + trayCount * 0.32; y = 1.06 + trayCount * 0.03; z = 3 + trayCount * 0.14; trayCount++; }
      else { const n = counts[shelfIndex]!++; x = S.focus - SHELF_W / 2 + 1.7 + n * (CARD_W + 0.28); y = shelfY(shelfIndex) + CARD_H / 2 + 0.12; z = shelfZ(shelfIndex); }
      const arrive = smoother(0, 1, clamp((p - 0.1 - i * 0.022) / 0.2));
      const sel = c.inspect === `focus-${m.id}` ? 1 : 0;
      if (drag.current?.i === i && cam) {
        // The card follows the pointer, on a plane facing the camera, until it's let go.
        ndc.set((film.pointer.px / film.vw) * 2 - 1, -(film.pointer.py / film.vh) * 2 + 1);
        ray.setFromCamera(ndc, cam);
        plane.setFromNormalAndCoplanarPoint(Z, AT);
        if (ray.ray.intersectPlane(plane, hit)) { place.x = damp(place.x, hit.x, 22, d); place.y = damp(place.y, hit.y, 22, d); place.z = damp(place.z, 3, 22, d); }
      } else {
        place.x = damp(place.x, x, 7, d); place.y = damp(place.y, y, 7, d); place.z = damp(place.z, z, 7, d);
      }
      place.lift = damp(place.lift, sel, 8, d);
      const fx = S.focus + 15, fy = 0.2, fz = 0;
      card.position.set(fx + (place.x - fx) * arrive, fy + (place.y - fy) * arrive + place.lift * 0.14, fz + (place.z - fz) * arrive + place.lift * 0.4);
      card.rotation.set(-0.16 + place.lift * 0.14, (1 - arrive) * -1.2, 0);
      card.scale.setScalar(arrive < 0.001 ? 0.001 : 1 + place.lift * 0.1);
      const an = (film.anchors[`card-${m.id}`] ??= { x: 0, y: 0, z: 0, on: 0 });
      an.x = card.position.x; an.y = card.position.y; an.z = card.position.z; an.on = arrive;
    });
  });

  const down = (i: number) => (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    drag.current = { i };
    document.documentElement.style.cursor = "grabbing";
    window.dispatchEvent(new CustomEvent("film:inspect", { detail: `focus-${messages[i]!.id}` }));
    const up = () => {
      window.removeEventListener("pointerup", up);
      document.documentElement.style.cursor = "";
      const place = places.current[i]!;
      const m = messages[i]!;
      drag.current = null;
      if (m.section === "security_review") return; // Security comes first, and a held message can't be ranked up.
      let best = 0, bd = Infinity;
      SHELVES.forEach((_, s) => { const dd = Math.abs(place.y - (shelfY(s) + CARD_H / 2)); if (dd < bd) { bd = dd; best = s; } });
      window.dispatchEvent(new CustomEvent("film:shelf", { detail: { id: m.id, shelf: best } }));
    };
    window.addEventListener("pointerup", up);
  };

  return (
    <group ref={root}>
      {SHELVES.map((s, i) => (
        <group key={s.key} position={[S.focus, shelfY(i), shelfZ(i)]}>
          <mesh castShadow receiveShadow><boxGeometry args={[SHELF_W, 0.12, 1.1]} /><meshStandardMaterial color="#f7f7f9" roughness={0.9} /></mesh>
          <mesh position={[0, 0.03, 0.56]} castShadow><boxGeometry args={[SHELF_W, 0.1, 0.03]} /><meshStandardMaterial color={METAL} metalness={1} roughness={0.3} /></mesh>
          <mesh position={[-SHELF_W / 2 + 1.5, -0.2, 0.59]}><planeGeometry args={[2.8, 0.34]} /><meshBasicMaterial map={labels[i]} transparent toneMapped={false} /></mesh>
          <mesh position={[-SHELF_W / 2 + 0.1, -shelfY(i) / 2, -0.3]} castShadow><cylinderGeometry args={[0.04, 0.04, shelfY(i), 10]} /><meshStandardMaterial color={METAL} metalness={1} roughness={0.3} /></mesh>
          <mesh position={[SHELF_W / 2 - 0.1, -shelfY(i) / 2, -0.3]} castShadow><cylinderGeometry args={[0.04, 0.04, shelfY(i), 10]} /><meshStandardMaterial color={METAL} metalness={1} roughness={0.3} /></mesh>
        </group>
      ))}
      {/* Security review is apart: flagged mail doesn't get a place in the order at all. */}
      <group position={[S.focus + 3.4, 0, 2.7]}>
        <mesh position={[0, 0.3, 0]} castShadow receiveShadow><boxGeometry args={[3.5, 0.6, 2.3]} /><meshStandardMaterial color="#f1e6dc" roughness={0.9} /></mesh>
        <mesh position={[0, 0.3, 1.16]}><planeGeometry args={[2.8, 0.42]} /><meshBasicMaterial map={tray} transparent toneMapped={false} /></mesh>
      </group>
      {messages.map((m, i) => (
        <group key={m.id} ref={c => { cards.current[i] = c; }} scale={0.001}>
          <mesh castShadow onPointerDown={down(i)} onPointerOver={() => { document.documentElement.style.cursor = "grab"; }} onPointerOut={() => { if (!drag.current) document.documentElement.style.cursor = ""; }}>
            <boxGeometry args={[CARD_W, CARD_H, 0.03]} />
            <meshStandardMaterial attach="material-0" color="#e8e8ec" />
            <meshStandardMaterial attach="material-1" color="#e8e8ec" />
            <meshStandardMaterial attach="material-2" color="#e8e8ec" />
            <meshStandardMaterial attach="material-3" color="#e8e8ec" />
            <meshStandardMaterial attach="material-4" map={maps[i]} roughness={0.88} />
            <meshStandardMaterial attach="material-5" color="#f2f2f5" />
          </mesh>
        </group>
      ))}
    </group>
  );
}
