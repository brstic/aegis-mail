/** Where everything stands on the desk. The film travels along +x, and every scene has its own station. */
export const STATION = {
  flurry: 0,
  stream: 16,
  seals: 44,
  autopsy: 70,
  xray: 96,
  uv: 122,
  scale: 148,
  case: 174,
  focus: 200,
  glass: 226,
  vault: 252,
  calm: 278,
} as const;

/** The letter's height above the desk when it's riding the tape. */
export const RIDE = 0.28;
/** Hero letter size. */
export const LETTER = { W: 3.3, D: 2.16, T: 0.05 };
export const SEAL_X = [STATION.seals - 4.2, STATION.seals, STATION.seals + 4.2];
/** Where on the letter each seal sits, across its width. The press over it is offset by the same amount, so it lands on it. */
export const SEAL_ON_LETTER = [-0.9, 0, 0.9];
