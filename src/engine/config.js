export const LOOP_SECONDS = 18;         // Adjust animation loop length / speed here.
export const LOD_MORPH_SECONDS = 0.2;   // Adjust geometric split / merge duration here.
// Presentation-only anchor: physical rain values are not capped at this value.
export const RAIN_PRESENTATION_MAX_MMH = 50;
export const RAIN_VISIBILITY_FLOOR_MMH = 0.05;
export const RAIN_BASE_RADIUS_ANCHORS = Object.freeze([
  { mmh: RAIN_VISIBILITY_FLOOR_MMH, radius: 0.00 },
  { mmh: 0.10, radius: 0.07 },
  { mmh: 0.30, radius: 0.24 },
  { mmh: 1.00, radius: 0.47 },
  { mmh: 2.50, radius: 0.68 },
  { mmh: 10.0, radius: 0.86 },
  { mmh: RAIN_PRESENTATION_MAX_MMH, radius: 0.86 }
]);
export const RAIN_STRONG_RADIUS_ANCHORS = Object.freeze([
  { mmh: 2.50, radius: 0.00 },
  { mmh: 5.00, radius: 0.16 },
  { mmh: 10.0, radius: 0.32 },
  { mmh: 25.0, radius: 0.55 },
  { mmh: RAIN_PRESENTATION_MAX_MMH, radius: 0.72 }
]);
export const RAIN_AREA_BAND_MMH = Object.freeze([0.10, 0.30, 1.00, 2.50, 10.0]);

export const RAIN_BLUE = '#0090FF';
export const STRONG_PRECIPITATION_BLUE = '#0000FF';
export const AREA_PRECIPITATION_BANDS = [
  { threshold: RAIN_AREA_BAND_MMH[0], color: RAIN_BLUE },
  { threshold: RAIN_AREA_BAND_MMH[1], color: '#0078FF' },
  { threshold: RAIN_AREA_BAND_MMH[2], color: '#005EFF' },
  { threshold: RAIN_AREA_BAND_MMH[3], color: '#003CFF' },
  { threshold: RAIN_AREA_BAND_MMH[4], color: STRONG_PRECIPITATION_BLUE }
];
