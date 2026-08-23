export const LOOP_SECONDS = 18;         // Adjust animation loop length / speed here.
export const LOD_MORPH_SECONDS = 0.2;   // Adjust geometric split / merge duration here.
export const RAIN_MODERATE_MAX = 0.55;
export const RAIN_BLUE = '#0090FF';
export const STRONG_PRECIPITATION_BLUE = '#0000FF';
export const AREA_RAIN_CONTOUR_THRESHOLD = 0.027;
export const AREA_PRECIPITATION_BANDS = [
  { threshold: AREA_RAIN_CONTOUR_THRESHOLD, color: RAIN_BLUE },
  { threshold: 0.12, color: '#0078FF' },
  { threshold: 0.25, color: '#005EFF' },
  { threshold: 0.40, color: '#003CFF' },
  { threshold: RAIN_MODERATE_MAX, color: STRONG_PRECIPITATION_BLUE }
];
