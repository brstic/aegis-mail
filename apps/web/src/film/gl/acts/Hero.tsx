"use client";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { FOCUS_MESSAGES } from "@/components/marketing/demo-data";
import { ch, damp, film, near, smooth, smoother } from "../../store";
import { canvas, fonts } from "../paper";

export const HERO_PANEL = { x: 4.9, y: 5.4, z: 3, w: 8.4, h: 5.58 };

/**
 * The product itself, in the middle of the mess: Focus, with what needs you at the top and the reason under each one, and the scam held
 * apart. Drawn from the same synthetic messages as the demo on this page.
 */
function panelTexture() {
  const W = 2080, H = 1380;
  const { c, g } = canvas(W, H);
  const f = fonts();
  g.clearRect(0, 0, W, H);
  g.fillStyle = "#ffffff"; g.beginPath(); g.roundRect(0, 0, W, H, 60); g.fill();
  // Title bar.
  g.fillStyle = "#1d1d1f"; g.font = `600 58px ${f.display}`; g.textBaseline = "middle"; g.fillText("Focus", 80, 100);
  g.fillStyle = "#f2f2f4"; g.beginPath(); g.roundRect(400, 62, 900, 76, 38); g.fill();
  g.fillStyle = "#86868b"; g.font = `400 34px ${f.sans}`; g.fillText("Search mail", 460, 100);
  // The AI is on, and says what it's done.
  g.fillStyle = "#e8f1fd"; g.beginPath(); g.roundRect(1340, 62, 520, 76, 38); g.fill();
  g.fillStyle = "#0071e3"; g.beginPath(); g.arc(1384, 100, 11, 0, 7); g.fill();
  g.font = `600 32px ${f.sans}`; g.fillText("AI protection on", 1412, 101);
  g.fillStyle = "#0071e3"; g.beginPath(); g.arc(W - 110, 100, 34, 0, 7); g.fill();
  g.fillStyle = "#ffffff"; g.font = `600 32px ${f.sans}`; g.textAlign = "center"; g.fillText("M", W - 110, 101); g.textAlign = "left";
  const section = (y: number, label: string, red = false) => {
    g.fillStyle = red ? "#d70015" : "#1d1d1f"; g.font = `600 34px ${f.sans}`; g.fillText(label, 80, y);
    g.fillStyle = "#e5e5ea"; g.fillRect(80, y + 34, W - 160, 2);
  };
  const row = (y: number, from: string, subject: string, why: string, hue: number, chip?: string) => {
    g.fillStyle = `hsl(${hue} 32% 46%)`; g.beginPath(); g.arc(122, y + 44, 38, 0, 7); g.fill();
    g.fillStyle = "#ffffff"; g.font = `600 30px ${f.sans}`; g.textAlign = "center"; g.fillText(from.split(" ").map(w => w[0]).slice(0, 2).join(""), 122, y + 45); g.textAlign = "left";
    g.fillStyle = "#1d1d1f"; g.font = `600 36px ${f.sans}`; g.fillText(from, 196, y + 24, 420);
    g.font = `600 36px ${f.sans}`; g.fillText(subject, 640, y + 24, 1080);
    g.fillStyle = "#636368"; g.font = `400 30px ${f.sans}`; g.fillText(why, 640, y + 70, 1240);
    if (chip) {
      g.font = `600 28px ${f.sans}`; const w = g.measureText(chip).width + 44;
      g.fillStyle = "#fdecec"; g.beginPath(); g.roundRect(W - 120 - w, y + 2, w, 50, 25); g.fill();
      g.fillStyle = "#d70015"; g.fillText(chip, W - 98 - w, y + 28);
    }
    g.fillStyle = "#f0f0f2"; g.fillRect(196, y + 112, W - 276, 2);
  };
  const need = FOCUS_MESSAGES.filter(m => m.section === "needs_attention" || m.section === "todays_commitments").slice(0, 3);
  const held = FOCUS_MESSAGES.find(m => m.section === "security_review")!;
  section(220, "Stopped by AI", true);
  row(290, "Aldgate Supplies", "Invoice 8841", "Invoice_8841.pdf runs a script built to exploit your PDF reader.", 10, "Exploit · Held");
  row(422, held.fromName, held.subject, held.reasons[0] ?? "Held apart from your priorities.", 350, "Malicious · Held");
  section(640, "Needs your attention");
  need.forEach((m, i) => row(710 + i * 132, m.fromName, m.subject, m.reasons[0] ?? "", 200 + i * 47));
  g.fillStyle = "#636368"; g.font = `400 28px ${f.sans}`; g.fillText("Synthetic messages", 80, H - 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

/** Floats in the middle of the hero, leans a little towards the pointer, and lifts away as the mail starts to pour. */
export function Hero() {
  const root = useRef<THREE.Group>(null);
  const face = useRef<THREE.MeshBasicMaterial>(null);
  const map = useMemo(panelTexture, []);
  const lean = useRef({ x: 0, y: 0 });
  useFrame((_, dt) => {
    const g = root.current;
    if (!g) return;
    const on = near("flurry", 0.6);
    g.visible = on;
    if (!on) return;
    const d = Math.min(dt, 0.05), p = ch("flurry");
    const away = smoother(0.5, 0.9, p);
    const intro = smooth(0, 1, film.intro);
    lean.current.x = damp(lean.current.x, film.pointer.sy * 0.06, 4, d);
    lean.current.y = damp(lean.current.y, film.pointer.sx * 0.1, 4, d);
    // On a tall screen the copy is below, so the panel is centred above it.
    const px = film.portrait ? 0 : HERO_PANEL.x, py = film.portrait ? HERO_PANEL.y + 1.2 : HERO_PANEL.y;
    g.position.set(px, py + away * 9 + (1 - intro) * -1.5 + Math.sin(film.time * 0.6) * 0.06, HERO_PANEL.z - away * 6);
    g.rotation.set(-0.04 + lean.current.x - away * 0.3, -0.18 + lean.current.y, 0);
    const s = 1 - away * 0.25;
    g.scale.setScalar(s);
    if (face.current) face.current.opacity = intro * (1 - smooth(0.75, 0.9, p));
  });
  return (
    <group ref={root}>
      <mesh castShadow position={[0, 0, -0.06]}><boxGeometry args={[HERO_PANEL.w - 0.25, HERO_PANEL.h - 0.25, 0.1]} /><meshStandardMaterial color="#ffffff" roughness={0.4} /></mesh>
      <mesh>
        <planeGeometry args={[HERO_PANEL.w, HERO_PANEL.h]} />
        <meshBasicMaterial ref={face} map={map} transparent toneMapped={false} />
      </mesh>
    </group>
  );
}
