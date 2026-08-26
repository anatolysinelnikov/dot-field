export const LOOP_SECONDS = 18;         // Adjust animation loop length / speed here.
export const LOD_MORPH_SECONDS = 0.2;   // Adjust geometric split / merge duration here.
export const RAIN_FULL_SCALE_MMH = 50;
export const RAIN_VISIBILITY_FLOOR_MMH = 0.05;
export const RAIN_BASE_RADIUS_ANCHORS = Object.freeze([
  { mmh: 0.05, radius: 0.00 },
  { mmh: 0.10, radius: 0.07 },
  { mmh: 0.30, radius: 0.24 },
  { mmh: 1.00, radius: 0.47 },
  { mmh: 2.50, radius: 0.68 },
  { mmh: 10.0, radius: 0.86 },
  { mmh: 50.0, radius: 0.86 }
]);
export const RAIN_STRONG_RADIUS_ANCHORS = Object.freeze([
  { mmh: 2.50, radius: 0.00 },
  { mmh: 5.00, radius: 0.16 },
  { mmh: 10.0, radius: 0.32 },
  { mmh: 25.0, radius: 0.55 },
  { mmh: 50.0, radius: 0.72 }
]);
export const RAIN_AREA_BAND_MMH = Object.freeze([0.10, 0.30, 1.00, 2.50, 10.0]);

export function normalizedRainAnchor(mmh) {
  return Math.max(0, Math.min(1, mmh / RAIN_FULL_SCALE_MMH));
}

export const RAIN_BLUE = '#0090FF';
export const STRONG_PRECIPITATION_BLUE = '#0000FF';
export const AREA_PRECIPITATION_BANDS = [
  { threshold: normalizedRainAnchor(RAIN_AREA_BAND_MMH[0]), color: RAIN_BLUE },
  { threshold: normalizedRainAnchor(RAIN_AREA_BAND_MMH[1]), color: '#0078FF' },
  { threshold: normalizedRainAnchor(RAIN_AREA_BAND_MMH[2]), color: '#005EFF' },
  { threshold: normalizedRainAnchor(RAIN_AREA_BAND_MMH[3]), color: '#003CFF' },
  { threshold: normalizedRainAnchor(RAIN_AREA_BAND_MMH[4]), color: STRONG_PRECIPITATION_BLUE }
];
