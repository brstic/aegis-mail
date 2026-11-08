"use client";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { ch, clamp, damp, film, near, smooth, smoother } from "../../store";
import { STATION as S } from "../layout";
import { ACCENT, canvas, DANGER, envelopeTexture, fonts, INK, PAPER, texture } from "../paper";

const DRAFT = "Hi Priya, thanks for the signed statement of work. The start date on page 3 looks right to me. I'll confirm the rest by Thursday. Morgan";
const W = 4.4, H = 2.9, D = 2.5, BASE = 0.34;
/** Where the card stands inside the case, and how big it is. */
const CARD = { x: -0.15, y: BASE + 1.35, z: -0.25, w: 2.7, h: 2.02 };
const BTN_X = W / 2 + 1.55;

/** Words appear on the page as the model drafts them. Only redrawn when another word has been reached. Returns where the last word ended. */
function useDraft() {
  return useMemo(() => {
    const CW = 768, CH = 576;
    const { c, g } = canvas(CW, CH);
    const t = texture(c);
    let shown = -1;
    const at = { x: 0, y: 0 };
    const draw = (n: number) => {
      if (n === shown) return at;
      shown = n;
      const f = fonts();
      g.fillStyle = PAPER; g.beginPath(); g.roundRect(0, 0, CW, CH, 28); g.fill();
      g.fillStyle = ACCENT; g.font = `600 26px ${f.sans}`; g.fillText("AI DRAFT", 48, 64);
      g.fillStyle = "#86868b"; g.font = `400 26px ${f.sans}`; g.fillText("Waiting for your approval", 190, 64);
      g.fillStyle = "#e5e5ea"; g.fillRect(48, 88, CW - 96, 2);
      g.fillStyle = INK; g.font = `400 40px ${f.display}`;
      const words = DRAFT.split(" ").slice(0, n);
      let line = "", y = 156;
      for (const w of words) { const s = line ? `${line} ${w}` : w; if (g.measureText(s).width > CW - 96 && line) { g.fillText(line, 48, y); y += 58; line = w; } else line = s; }
      g.fillText(line, 48, y);
      at.x = (48 + g.measureText(line).width) / CW; at.y = (y - 14) / CH;
      t.needsUpdate = true;
      return at;
    };
    return { t, draw, count: DRAFT.split(" ").length };
  }, []);
}

function haloTexture() {
  const { c, g } = canvas(256, 256);
  const r = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  r.addColorStop(0, "rgba(41,151,255,.85)"); r.addColorStop(0.25, "rgba(41,151,255,.35)"); r.addColorStop(1, "rgba(41,151,255,0)");
  g.fillStyle = r; g.fillRect(0, 0, 256, 256);
  return texture(c);
}

function labelTexture(text: string) {
  const { c, g } = canvas(1024, 160);
  const f = fonts();
  g.clearRect(0, 0, 1024, 160);
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillStyle = "#6e6e73"; g.font = `500 64px ${f.display}`; g.fillText(text, 512, 84);
  return texture(c);
}

function sentTexture() {
  const { c, g } = canvas(768, 200);
  const f = fonts();
  g.clearRect(0, 0, 768, 200);
  g.fillStyle = "#ffffff"; g.beginPath(); g.roundRect(4, 4, 760, 192, 96); g.fill();
  g.fillStyle = ACCENT; g.beginPath(); g.arc(100, 100, 52, 0, 7); g.fill();
  g.strokeStyle = "#ffffff"; g.lineWidth = 12; g.lineCap = "round"; g.lineJoin = "round"; g.beginPath(); g.moveTo(76, 102); g.lineTo(94, 120); g.lineTo(126, 82); g.stroke();
  g.fillStyle = INK; g.font = `600 64px ${f.display}`; g.textBaseline = "middle"; g.fillText("Sent by you", 180, 104);
  return texture(c);
}

function capTexture() {
  const { c, g } = canvas(512, 512);
  const f = fonts();
  g.fillStyle = "#0071e3"; g.fillRect(0, 0, 512, 512);
  g.fillStyle = "#ffffff"; g.font = `600 112px ${f.display}`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("Send", 256, 262);
  return texture(c);
}

const RED = new THREE.Color(DANGER), CLEAR = new THREE.Color("#eaf2fb");

/**
 * The model works inside a sealed glass case: a point of light that writes the draft. Asked to send, it can only run into the glass. The
 * Send button is outside, on your side. Press it and the case opens, the draft becomes a letter, and it goes.
 */
export function Glass() {
  const root = useRef<THREE.Group>(null);
  const card = useRef<THREE.Mesh>(null);
  const orb = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Mesh>(null);
  const ripple = useRef<THREE.Mesh>(null);
  const rippleMat = useRef<THREE.MeshBasicMaterial>(null);
  const wallMat = useRef<THREE.MeshBasicMaterial>(null);
  const cap = useRef<THREE.Group>(null);
  const out = useRef<THREE.Mesh>(null);
  const sent = useRef<THREE.Mesh>(null);
  const sentMat = useRef<THREE.MeshBasicMaterial>(null);
  const draft = useDraft();
  const geo = useMemo(() => ({
    plinth: new RoundedBoxGeometry(W + 0.5, BASE, D + 0.5, 4, 0.12),
    glass: new RoundedBoxGeometry(W, H, D, 6, 0.16),
    pad: new RoundedBoxGeometry(1.5, 0.3, 1.5, 4, 0.14),
  }), []);
  const maps = useMemo(() => ({ halo: haloTexture(), cap: capTexture(), env: envelopeTexture(), sent: sentTexture(), ai: labelTexture("The AI writes in here"), you: labelTexture("Only you") }), []);
  const state = useRef({ knock: 0, press: 0, send: 0 });

  useFrame(({ camera }, dt) => {
    const g = root.current;
    if (!g) return;
    const on = near("glass", 0.5);
    g.visible = on;
    if (!on) return;
    const d = Math.min(dt, 0.05), p = ch("glass"), c = film.controls, s = state.current, t = film.time;
    const writing = smooth(0.12, 0.5, p);
    const at = draft.draw(Math.floor(writing * draft.count));

    // The light rests by the end of the words it's writing, then hovers beside the page.
    const done = writing >= 1;
    const wx = CARD.x - CARD.w / 2 + at.x * CARD.w, wy = CARD.y + CARD.h / 2 - at.y * CARD.h;
    let ox = done ? CARD.x - CARD.w / 2 - 0.35 : wx + 0.18, oy = done ? CARD.y + 0.5 + Math.sin(t * 1.4) * 0.08 : wy + Math.sin(t * 9) * 0.03;
    let oz = CARD.z + 0.32;
    // Asked to send, it darts for your button and meets the glass.
    const since = t - c.glassKnock;
    const k = c.glassKnock > 0 && since < 1.7 ? clamp(since / 1.7) : 0;
    const dash = k ? Math.sin(Math.min(k / 0.45, 1) * Math.PI * 0.5) * (1 - smooth(0.45, 1, k)) : 0;
    s.knock = film.frozen ? dash : damp(s.knock, dash, 18, d);
    const wallX = W / 2 - 0.2;
    ox += (wallX - ox) * s.knock; oy += (BASE + 1.5 - oy) * s.knock; oz += (0.2 - oz) * s.knock;
    if (orb.current) orb.current.position.set(ox, oy, oz);
    if (halo.current) { halo.current.quaternion.copy(camera.quaternion); halo.current.scale.setScalar(1 + Math.sin(t * 2.2) * 0.06 + s.knock * 0.3); }
    // Where it hits, the glass answers with a ring.
    const r = k > 0.4 ? clamp((k - 0.4) / 0.6) : 0;
    if (ripple.current && rippleMat.current) { ripple.current.scale.setScalar(0.4 + r * 5); rippleMat.current.opacity = r > 0 ? (1 - r) * 0.9 : 0; ripple.current.visible = r > 0 && r < 1; }
    if (wallMat.current) { const hit = r > 0 ? (1 - r) : 0; wallMat.current.color.copy(CLEAR).lerp(RED, hit); wallMat.current.opacity = 0.06 + hit * 0.22; }

    // Your button: it goes down, the case lifts, the draft folds into a letter and leaves.
    s.press = film.frozen ? (c.leverPulled ? 1 : 0) : damp(s.press, c.leverPulled ? 1 : 0, 9, d);
    if (cap.current) cap.current.position.y = 0.36 - s.press * 0.07;
    s.send = film.frozen ? (c.leverPulled ? 1 : 0) : damp(s.send, c.leverPulled ? 1 : 0, 1.2, d);
    // The case stays shut: the draft goes down through the plinth and comes out on your side, by the button, as a letter.
    const sink = smoother(0.1, 0.5, s.send), emerge = smoother(0.48, 0.64, s.send), fly = smoother(0.64, 1, s.send);
    if (card.current) {
      card.current.position.set(CARD.x, CARD.y - sink * (CARD.h + 0.5), CARD.z);
      card.current.visible = sink < 0.99;
    }
    if (out.current) {
      out.current.position.set(BTN_X + fly * 3, 0.55 + emerge * 0.7 + fly * 2.6, 0.6 - fly * 8);
      out.current.rotation.set(-0.5 - fly * 0.3, fly * 0.6, -fly * 0.25);
      out.current.scale.setScalar(Math.max(0.001, emerge * (1 - fly * 0.6)));
      out.current.visible = emerge > 0.01 && fly < 0.98;
    }
    if (sent.current && sentMat.current) { const v = smoother(0.88, 1, s.send); sentMat.current.opacity = v; sent.current.visible = v > 0.01; sent.current.position.y = CARD.y - 0.2 + v * 0.2; }
  });

  return (
    <group ref={root} position={[S.glass - 1.6, 0, 0]}>
      {/* The plinth. */}
      <mesh geometry={geo.plinth} position={[0, BASE / 2, 0]} castShadow receiveShadow><meshStandardMaterial color="#fbfbfd" roughness={0.5} /></mesh>
      <mesh position={[0, BASE / 2, D / 2 + 0.252]}><planeGeometry args={[2.2, 0.344]} /><meshBasicMaterial map={maps.ai} transparent toneMapped={false} depthWrite={false} /></mesh>

      {/* The draft, standing on a thin stand. */}
      <mesh position={[CARD.x, BASE + 0.03, CARD.z - 0.12]} receiveShadow><boxGeometry args={[1.2, 0.06, 0.4]} /><meshStandardMaterial color="#e8e8ed" roughness={0.4} /></mesh>
      <mesh ref={card} position={[CARD.x, CARD.y, CARD.z]} castShadow>
        <planeGeometry args={[CARD.w, CARD.h]} />
        <meshBasicMaterial map={draft.t} transparent toneMapped={false} side={THREE.DoubleSide} />
      </mesh>

      {/* The model: a point of light. */}
      <group ref={orb}>
        <mesh><sphereGeometry args={[0.13, 32, 16]} /><meshBasicMaterial color="#5ab0ff" toneMapped={false} /></mesh>
        <mesh ref={halo} renderOrder={4}><planeGeometry args={[1.1, 1.1]} /><meshBasicMaterial map={maps.halo} transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} /></mesh>
      </group>

      {/* The glass, drawn back faces first so the near side reads as a pane in front of everything inside. */}
      <group>
        <mesh geometry={geo.glass} position={[0, BASE + H / 2 + 0.001, 0]} renderOrder={2}>
          <meshPhysicalMaterial color="#e8f1fb" transparent opacity={0.07} roughness={0.04} metalness={0} clearcoat={1} clearcoatRoughness={0.05} envMapIntensity={1.6} side={THREE.BackSide} depthWrite={false} />
        </mesh>
        <mesh geometry={geo.glass} position={[0, BASE + H / 2 + 0.001, 0]} renderOrder={5}>
          <meshPhysicalMaterial color="#eef5fd" transparent opacity={0.05} roughness={0.03} metalness={0} clearcoat={1} clearcoatRoughness={0.04} envMapIntensity={2} side={THREE.FrontSide} depthWrite={false} />
        </mesh>
        {/* The wall it meets, which tints when hit, and the ring that spreads from the spot. */}
        <mesh position={[W / 2 - 0.02, BASE + H / 2, 0]} rotation-y={-Math.PI / 2} renderOrder={3}>
          <planeGeometry args={[D - 0.3, H - 0.3]} />
          <meshBasicMaterial ref={wallMat} color="#eaf2fb" transparent opacity={0.06} depthWrite={false} toneMapped={false} />
        </mesh>
        <mesh ref={ripple} position={[W / 2 - 0.03, BASE + 1.5, 0.2]} rotation-y={-Math.PI / 2} renderOrder={6} visible={false}>
          <ringGeometry args={[0.1, 0.13, 48]} />
          <meshBasicMaterial ref={rippleMat} color={DANGER} transparent opacity={0} depthWrite={false} toneMapped={false} side={THREE.DoubleSide} />
        </mesh>
      </group>

      {/* Your side: one button. */}
      <group position={[BTN_X, 0, 0.6]}>
        <mesh geometry={geo.pad} position={[0, 0.15, 0]} castShadow receiveShadow><meshStandardMaterial color="#fbfbfd" roughness={0.5} /></mesh>
        <group ref={cap} position={[0, 0.36, 0]}>
          <mesh castShadow rotation-y={Math.PI / 2}>
            <cylinderGeometry args={[0.5, 0.52, 0.16, 64]} />
            <meshStandardMaterial attach="material-0" color={ACCENT} roughness={0.32} />
            <meshBasicMaterial attach="material-1" map={maps.cap} toneMapped={false} />
            <meshStandardMaterial attach="material-2" color={ACCENT} />
          </mesh>
        </group>
        <mesh position={[0, 0.15, 0.752]}><planeGeometry args={[1.4, 0.219]} /><meshBasicMaterial map={maps.you} transparent toneMapped={false} depthWrite={false} /></mesh>
      </group>

      <mesh ref={sent} position={[CARD.x, CARD.y, CARD.z]} visible={false}><planeGeometry args={[2.3, 0.6]} /><meshBasicMaterial ref={sentMat} map={maps.sent} transparent opacity={0} toneMapped={false} depthWrite={false} /></mesh>
      <mesh ref={out} castShadow visible={false}><planeGeometry args={[1.2, 0.79]} /><meshStandardMaterial map={maps.env} side={THREE.DoubleSide} roughness={0.9} /></mesh>
    </group>
  );
}
