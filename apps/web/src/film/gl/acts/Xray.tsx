"use client";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { EVIDENCE, RISK_LABEL, XRAY_STAGES } from "../../data/content";
import { ch, clamp, damp, film, near, smooth } from "../../store";
import { STATION as S } from "../layout";
import { ACCENT, canvas, DANGER, fonts, INK, plaqueTexture, texture } from "../paper";

const BLUE_C = new THREE.Color(ACCENT), RED_C = new THREE.Color(DANGER);
const W = 3.2, H = 4.3, BASE = 0.16, GAP = 1.1, SIDE = 1.55, LIFT = 0.5;

/** The four layers the inspector reads, drawn as sheets: the page you'd see, the objects behind it, its decoded streams, the script. */
function layerTexture(kind: "page" | "objects" | "streams" | "script") {
  const CW = 1024, CH = Math.round(1024 * (H / W));
  const { c, g } = canvas(CW, CH);
  const f = fonts();
  const dark = kind === "script";
  g.fillStyle = dark ? "#16161a" : "#ffffff"; g.fillRect(0, 0, CW, CH);
  g.textBaseline = "top";
  const head = (t: string, sub: string) => {
    g.fillStyle = dark ? "#ff6b6b" : ACCENT; g.font = `600 30px ${f.sans}`; g.fillText(sub.toUpperCase(), 64, 60);
    g.fillStyle = dark ? "#f5f5f7" : INK; g.font = `600 58px ${f.display}`; g.fillText(t, 64, 104);
  };
  if (kind === "page") {
    g.fillStyle = "#d70015"; g.beginPath(); g.roundRect(CW - 200, 60, 136, 64, 14); g.fill();
    g.fillStyle = "#fff"; g.font = `700 34px ${f.sans}`; g.fillText("PDF", CW - 166, 76);
    g.fillStyle = INK; g.font = `600 64px ${f.display}`; g.fillText("Invoice 8841", 64, 70);
    g.fillStyle = "#636368"; g.font = `400 30px ${f.sans}`; g.fillText("Aldgate Supplies · November", 64, 156);
    for (let i = 0; i < 7; i++) {
      const y = 300 + i * 92;
      g.fillStyle = "#e8e8ed"; g.fillRect(64, y, 520 - (i % 3) * 90, 22);
      g.fillStyle = "#d2d2d7"; g.fillRect(CW - 240, y, 176, 22);
    }
    g.fillStyle = "#1d1d1f"; g.fillRect(64, 990, CW - 128, 3);
    g.font = `600 44px ${f.sans}`; g.fillText("Total", 64, 1024); g.textAlign = "right"; g.fillText("£4,180.00", CW - 64, 1024); g.textAlign = "left";
    g.fillStyle = "#86868b"; g.font = `400 28px ${f.sans}`; g.fillText("What you'd see when you open it.", 64, CH - 96);
  } else if (kind === "objects") {
    head("Objects", "Layer 2");
    const rows: [string, boolean][] = [["1 0 obj  /Catalog", false], ["   /Pages 2 0 R", false], ["   /OpenAction 5 0 R", true], ["3 0 obj  /Page", false], ["   /Annots  /URI", false], ["5 0 obj  /S /JavaScript", true], ["   /JS 6 0 R", true]];
    g.font = `500 38px ${f.mono}`;
    rows.forEach(([t, hot], i) => {
      const y = 260 + i * 104;
      if (hot) { g.fillStyle = "#fdecec"; g.beginPath(); g.roundRect(48, y - 18, CW - 96, 80, 16); g.fill(); }
      g.fillStyle = hot ? DANGER : INK; g.fillText(t, 72, y);
    });
    g.fillStyle = "#636368"; g.font = `400 30px ${f.sans}`; g.fillText("Runs a script the moment it opens.", 64, CH - 96);
  } else if (kind === "streams") {
    head("Streams, decoded", "Layer 3");
    g.font = `500 34px ${f.mono}`;
    const rows = ["4 0 obj  FlateDecode  page text", "6 0 obj  FlateDecode  script, 132 bytes"];
    rows.forEach((t, i) => { const y = 270 + i * 110; g.fillStyle = i ? DANGER : INK; g.fillText(t, 64, y); });
    // A strip of compressed bytes, then the same strip unpacked.
    g.fillStyle = "#f2f2f4"; g.beginPath(); g.roundRect(48, 520, CW - 96, 220, 20); g.fill();
    g.fillStyle = "#86868b"; g.font = `500 26px ${f.mono}`;
    const noise = "x\u009c­\u0091M«Â@\u0010\u0086ïý\u0015";
    for (let r = 0; r < 4; r++) g.fillText(Array.from({ length: 30 }, (_, k) => noise[(k * 7 + r * 3) % noise.length]!.charCodeAt(0).toString(16).padStart(2, "0")).join(" ").slice(0, 52), 72, 548 + r * 44);
    g.fillStyle = ACCENT; g.font = `600 30px ${f.sans}`; g.fillText("↓  inflated", 72, 770);
    g.fillStyle = INK; g.font = `500 32px ${f.mono}`; g.fillText("var p = unescape(\"%u9090…", 72, 830);
    g.fillStyle = "#636368"; g.font = `400 30px ${f.sans}`; g.fillText("Packed so a quick scan can't read it.", 64, CH - 96);
  } else {
    head("The script", "Layer 4");
    const code = ["var p = unescape(", "  \"%u9090%u9090%u4141…\");", "while (p.length < 0x40000)", "  p += p;", "util.printf(\"%45000f\", 1.2);"];
    const hot = [0, 1, 2, 4];
    g.font = `500 38px ${f.mono}`;
    code.forEach((t, i) => {
      const y = 280 + i * 92;
      if (hot.includes(i)) { g.fillStyle = "rgba(255,69,58,.16)"; g.fillRect(40, y - 16, CW - 80, 76); }
      g.fillStyle = hot.includes(i) ? "#ff6b6b" : "#c7c7cc"; g.fillText(t, 64, y);
    });
    const tags = ["Encoded machine code", "Memory spraying", "Known reader flaw"];
    g.font = `600 30px ${f.sans}`;
    let x = 64;
    tags.forEach(t => { const w = g.measureText(t).width + 44; g.fillStyle = "rgba(255,69,58,.18)"; g.beginPath(); g.roundRect(x, 830, w, 58, 29); g.fill(); g.fillStyle = "#ff8a80"; g.fillText(t, x + 22, 844); x += w + 16; });
    g.fillStyle = "#a1a1a6"; g.font = `400 30px ${f.sans}`; g.fillText("Inert here. Built to take over a PDF reader.", 64, CH - 96);
  }
  return texture(c);
}

/**
 * An invoice PDF, opened the way the inspector opens it. The scroll walks through four stages, and choosing one goes straight to it:
 * the file as it looks, its objects, its decoded streams, the script inside. A scan passes through each layer as it's read, and at the
 * end the script is pulled out with the verdict the real engine gave it.
 */
export function Xray() {
  const root = useRef<THREE.Group>(null);
  const sheets = useRef<(THREE.Group | null)[]>([]);
  const frames = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const scan = useRef<THREE.Group>(null);
  const scanMat = useRef<THREE.MeshBasicMaterial>(null);
  const scanEdge = useRef<THREE.MeshBasicMaterial>(null);
  const scanLine = useRef<THREE.LineBasicMaterial>(null);
  const edges = useMemo(() => new THREE.EdgesGeometry(new THREE.PlaneGeometry(W + 0.9, H + 0.9)), []);
  const verdict = useRef<THREE.Mesh>(null);
  const verdictMat = useRef<THREE.MeshBasicMaterial>(null);
  const maps = useMemo(() => (["page", "objects", "streams", "script"] as const).map(layerTexture), []);
  const verdictMap = useMemo(() => plaqueTexture([`${RISK_LABEL[EVIDENCE.xray.label] ?? EVIDENCE.xray.label} · Held`], { w: 720, h: 130, size: 58, ink: DANGER }), []);
  const state = useRef({ stage: 0, auto: -1 });

  useFrame((_, dt) => {
    const g = root.current;
    if (!g) return;
    const on = near("xray", 0.5);
    g.visible = on;
    if (!on) return;
    const d = Math.min(dt, 0.05), p = ch("xray"), st = state.current;
    // The scroll walks the stages; a button press goes straight to one.
    const q = Math.min(3, Math.floor(smooth(0.05, 0.95, p) * 4));
    if (q !== st.auto) { st.auto = q; window.dispatchEvent(new CustomEvent("film:xray", { detail: XRAY_STAGES[q]!.id })); }
    const chosen = Math.max(0, XRAY_STAGES.findIndex(s => film.controls.inspect === `xray-${s.id}`));
    st.stage = film.frozen ? chosen : damp(st.stage, chosen, 3.2, d);
    const s = st.stage;
    // 0: one closed file. 1..2: the layers fan out in depth. 3: they close up behind the script, which comes forward.
    const open = clamp(s) * (1 - smooth(2.4, 3, s) * 0.55);
    const pull = smooth(2.3, 3, s);
    // The scan: a plane of light that travels back through the stack while it's open, reading each layer as it passes.
    const travel = smooth(0.15, 2.2, s);
    const red = smooth(1.5, 1.9, s);
    for (let i = 0; i < 4; i++) {
      const sh = sheets.current[i];
      if (!sh) continue;
      const isScript = i === 3;
      // Closed, the page is in front and the rest sit just behind it.
      sh.position.set(i * SIDE * open + (isScript ? pull * -0.4 : 0), BASE + H / 2 + i * LIFT * open * (1 - pull * (isScript ? 1 : 0)) + (isScript ? pull * 0.2 : 0), -i * (0.05 + GAP * open) + (isScript ? pull * (3 * (0.05 + GAP * open) + 1.4) : 0));
      sh.rotation.set(0, isScript ? -pull * 0.12 : 0, 0);
      const read = smooth(i / 3 - 0.06, i / 3 + 0.06, travel);
      const fm = frames.current[i];
      if (fm) {
        fm.color.copy(isScript && red > 0.5 ? RED_C : BLUE_C);
        fm.opacity = isScript ? Math.max(read * 0.55, red * 0.95) : read * 0.5 * (1 - smooth(2.3, 2.8, s) * 0.7);
      }
    }
    if (scan.current && scanMat.current && scanEdge.current && scanLine.current) {
      scan.current.position.set(travel * 3 * SIDE * open, BASE + H / 2 + travel * 3 * LIFT * open, 0.3 - travel * (3 * (0.05 + GAP * open) + 0.6));
      const vis = smooth(0.1, 0.35, s) * (1 - smooth(2.1, 2.5, s));
      scanMat.current.opacity = 0.12 * vis;
      scanEdge.current.opacity = 0.9 * vis;
      scanLine.current.opacity = 0.8 * vis;
      scan.current.visible = vis > 0.01;
    }
    if (verdict.current && verdictMat.current) {
      const v = film.frozen ? (chosen === 3 ? 1 : 0) : smooth(2.5, 3, s);
      verdict.current.position.set(1.7, 0.16 - (1 - v) * 0.2, 3.2);
      verdictMat.current.opacity = v;
      verdict.current.visible = v > 0.01;
    }
  });

  return (
    <group ref={root} position={[S.xray, 0, 0]}>
      {/* A small stand, so the file reads as an object on the desk. */}
      <mesh position={[1.6, 0.07, -1.7]} receiveShadow><boxGeometry args={[W + 4.4, 0.14, 5.6]} /><meshStandardMaterial color="#fbfbfd" roughness={0.55} /></mesh>
      {maps.map((m, i) => (
        <group key={i} ref={el => { sheets.current[i] = el; }}>
          <mesh castShadow>
            <boxGeometry args={[W, H, 0.03]} />
            <meshStandardMaterial attach="material-0" color="#e5e5ea" />
            <meshStandardMaterial attach="material-1" color="#e5e5ea" />
            <meshStandardMaterial attach="material-2" color="#e5e5ea" />
            <meshStandardMaterial attach="material-3" color="#e5e5ea" />
            <meshBasicMaterial attach="material-4" map={m} toneMapped={false} />
            <meshStandardMaterial attach="material-5" color="#f2f2f5" />
          </mesh>
          {/* Outline that lights when the layer has been read. */}
          <mesh position={[0, 0, -0.03]}>
            <planeGeometry args={[W + 0.16, H + 0.16]} />
            <meshBasicMaterial ref={el => { frames.current[i] = el; }} color={ACCENT} transparent opacity={0} depthWrite={false} toneMapped={false} />
          </mesh>
        </group>
      ))}
      <group ref={scan}>
        <mesh><planeGeometry args={[W + 0.9, H + 0.9]} /><meshBasicMaterial ref={scanMat} color={ACCENT} transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} toneMapped={false} /></mesh>
        <lineSegments>
          <primitive object={edges} attach="geometry" />
          <lineBasicMaterial ref={scanLine} color={ACCENT} transparent opacity={0} toneMapped={false} />
        </lineSegments>
        <mesh position={[0, -(H + 0.9) / 2 - 0.02, 0]}><boxGeometry args={[W + 0.9, 0.04, 0.04]} /><meshBasicMaterial ref={scanEdge} color={ACCENT} transparent opacity={0} toneMapped={false} /></mesh>
      </group>
      <mesh ref={verdict} rotation-x={-1.05}><planeGeometry args={[3.6, 0.65]} /><meshBasicMaterial ref={verdictMat} map={verdictMap} transparent opacity={0} toneMapped={false} depthWrite={false} /></mesh>
    </group>
  );
}
