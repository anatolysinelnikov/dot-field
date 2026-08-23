import { RAIN_MODERATE_MAX } from './config.js';
import { clamp, smoothstep } from './math.js';

export const INTENSITY_THRESHOLDS = Object.freeze({ rain: 0.045, storm: 0.075, hail: 0.11 });

export function intensityToStrength(intensity, layer, thresholds = INTENSITY_THRESHOLDS) {
  return smoothstep(thresholds[layer] * 0.45, 0.93, intensity);
}

export function intensityToRadius(intensity, spacing, layer) {
  // Adjust thresholds and radius mapping here. Rain intentionally overlaps most.
  // Ease through the visibility floor instead of switching a dot on abruptly.
  const normalized = intensityToStrength(intensity, layer, INTENSITY_THRESHOLDS);
  const overlap = layer === 'rain' ? 0.86 : layer === 'storm' ? 0.72 : 0.59;
  return spacing * overlap * Math.pow(normalized, layer === 'rain' ? 0.47 : 0.56);
}

export function strongPrecipitationIntensity(rainIntensity) {
  return clamp((rainIntensity - RAIN_MODERATE_MAX) / (1 - RAIN_MODERATE_MAX));
}
