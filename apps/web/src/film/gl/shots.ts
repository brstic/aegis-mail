import type { ChapterId } from "../store";
import type { Key } from "../track";
import { RIDE, STATION as S } from "./layout";

type V3 = [number, number, number];
interface Shot { ch: ChapterId; t: number; p: V3; l: V3; fov: number; sx?: number; sy?: number }
const rad = (d: number) => (d * Math.PI) / 180;
/** A point on an orbit around `c`. Azimuth 0 looks along -z, positive swings to the viewer's right. */
const orbit = (c: V3, dist: number, az: number, el: number): V3 => [c[0] + dist * Math.sin(rad(az)) * Math.cos(rad(el)), c[1] + dist * Math.sin(rad(el)), c[2] + dist * Math.cos(rad(az)) * Math.cos(rad(el))];

/**
 * Every shot in the film. `sx` and `sy` slide the image without changing perspective, which leaves room for the copy.
 * A tall screen has the scene on top and the copy below, so it gets `sy` and a longer lens distance instead.
 */
export function buildShots(aspect: number): Key[] {
  const tall = aspect < 1.1;
  const far = tall ? Math.min(2.1, 1.25 / aspect) : 1;
  const side = tall ? 0 : 0.3;
  const up = tall ? 0.42 : 0;
  const o = (c: V3, d: number, az: number, el: number) => orbit(c, d * far, az, el);
  const shots: Shot[] = [];
  const add = (ch: ChapterId, t: number, c: V3, d: number, az: number, el: number, fov = 26, sx = side, sy = up) => shots.push({ ch, t, p: o(c, d, az, el), l: c, fov, sx, sy });

  // The flurry, seen from low down, so the letters fill the sky.
  add("flurry", 0, [1.5, 5.5, 1.5], 31, -8, 4, 28, tall ? 0 : 0.3);
  add("flurry", 0.6, [1.5, 5.5, 1.5], 31, 2, 6, 28, tall ? 0 : 0.3);
  add("flurry", 1, [2, 4.2, 0], 34, 10, 15, 28, tall ? 0 : 0.3);
  // It pours into three lanes, then one.
  add("stream", 0.35, [S.stream + 1.5, 0.8, 0], 44, -8, 30, 26, tall ? 0 : 0.5);
  add("stream", 1, [S.stream + 4, 0.8, 0], 41, -14, 28, 26, tall ? 0 : 0.5);
  // Along the line of arches, so they stack up in depth, and the letter comes towards the lens.
  add("seals", 0.06, [S.seals - 5, 0.9, 0], 19, -38, 30, 26, tall ? 0 : 0.44);
  add("seals", 0.34, [S.seals - 1.5, 0.9, 0], 18.5, -34, 31, 26, tall ? 0 : 0.44);
  add("seals", 0.62, [S.seals + 3, 0.9, 0], 18, -30, 32, 26, tall ? 0 : 0.44);
  add("seals", 0.96, [S.seals + 9, 0.3, 0], 11.5, 0, 62, 26, tall ? 0 : 0.42);
  // Round to the side as the letter comes apart.
  add("autopsy", 0.12, [S.autopsy, 1.4, 0], 14, 28, 34);
  add("autopsy", 0.5, [S.autopsy, 3, 0], 21, 52, 20, 26, tall ? 0 : 0.22);
  add("autopsy", 0.92, [S.autopsy, 3, 0], 21, 62, 16, 26, tall ? 0 : 0.22);
  // In front of the file and a little to its side, so the layers stack up in depth as it opens.
  add("xray", 0.08, [S.xray + 0.4, 2.4, -0.2], 15, 18, 8, 26, tall ? 0 : 0.42);
  add("xray", 0.55, [S.xray + 2.8, 3.1, -1.7], 21.5, 34, 10, 26, tall ? 0 : 0.38);
  add("xray", 0.95, [S.xray + 1.4, 2.2, 0.6], 18, 22, 14, 26, tall ? 0 : 0.42);
  // Straight down onto the page, for the lamp.
  add("uv", 0.12, [S.uv, 0, 0], 26, 0, 88, 26, tall ? 0 : 0.48, up);
  add("uv", 0.9, [S.uv, 0, 0], 25.5, 0, 88, 26, tall ? 0 : 0.48, up);
  add("scale", 0.1, [S.scale, 2.6, 0.8], 27, -8, 14, 26, tall ? 0 : 0.46);
  add("scale", 0.9, [S.scale, 2.6, 0.8], 26.5, 6, 16, 26, tall ? 0 : 0.46);
  add("case", 0.1, [S.case, 1.8, 0], 19, -24, 15, 26, tall ? 0 : 0.42);
  add("case", 0.9, [S.case, 1.8, 0], 18, 14, 17, 26, tall ? 0 : 0.42);
  add("focus", 0.08, [S.focus + 0.5, 3.4, 0], 31, -16, 12, 26, tall ? 0 : 0.42);
  add("focus", 0.92, [S.focus + 0.5, 3.4, 0], 30, 8, 14, 26, tall ? 0 : 0.42);
  add("glass", 0.1, [S.glass - 0.15, 1.7, 0], 19.5, -16, 14, 26, tall ? 0 : 0.44);
  add("glass", 0.9, [S.glass - 0.15, 1.7, 0], 18.5, 10, 16, 26, tall ? 0 : 0.44);
  add("vault", 0.1, [S.vault - 1.1, 1.5, 0], 35, 10, 22, 26, tall ? 0 : 0.42);
  add("vault", 0.9, [S.vault - 1.1, 1.5, 0], 33, -2, 24, 26, tall ? 0 : 0.42);
  add("calm", 0.1, [S.calm, 0.6, 1], 21, -6, 32, 26, 0, tall ? 0.3 : -0.5);
  add("calm", 0.62, [S.calm, 0.6, 1], 23, 0, 42, 26, 0, tall ? 0.3 : -0.5);

  return shots.map(s => ({ ch: s.ch, t: s.t, v: [...s.p, ...s.l, s.fov, s.sx ?? 0, s.sy ?? 0] }));
}

/** The letter's path: x y z, rotation x y z, scale, and how far the flap is open. */
export function buildLetterPath(): Key[] {
  const ride = (x: number): number[] => [x, RIDE, 0, 0, 0, 0, 1, 0];
  const keys: { ch: ChapterId; t: number; v: number[] }[] = [
    { ch: "stream", t: 0.72, v: [S.stream + 8, RIDE, 0, 0, 0, 0, 0.35, 0] },
    { ch: "stream", t: 0.88, v: ride(S.stream + 11) },
    { ch: "seals", t: 0, v: ride(S.seals - 11) },
    { ch: "seals", t: 0.92, v: ride(S.seals + 9) },
    { ch: "seals", t: 1, v: ride(S.seals + 9) },
    { ch: "autopsy", t: 0.06, v: ride(S.autopsy - 1) },
    { ch: "autopsy", t: 0.16, v: [S.autopsy, RIDE + 0.4, 0, 0, 0, 0, 1, 1] },
    { ch: "autopsy", t: 1, v: [S.autopsy, RIDE + 0.4, 0, 0, 0, 0, 1, 1] },
    { ch: "uv", t: 0, v: [S.uv - 14, RIDE, 0, 0, 0, 0, 1, 0] },
    { ch: "scale", t: 0, v: ride(S.scale - 14) },
    { ch: "scale", t: 1, v: ride(S.scale + 12) },
    { ch: "case", t: 0.1, v: ride(S.case - 6) },
    { ch: "case", t: 0.5, v: [S.case, 1.2, 0, 0, 0, 0, 1, 0] },
    { ch: "case", t: 1, v: [S.case, 1.2, 0, 0, 0, 0, 1, 0] },
  ];
  return keys;
}
