import {
  RAIN_BASE_RADIUS_ANCHORS,
  RAIN_FULL_SCALE_MMH,
  RAIN_STRONG_RADIUS_ANCHORS,
  RAIN_VISIBILITY_FLOOR_MMH,
  normalizedRainAnchor
} from './config.js';
import { clamp, smoothstep } from './math.js';

export const INTENSITY_THRESHOLDS = Object.freeze({ rain: normalizedRainAnchor(RAIN_VISIBILITY_FLOOR_MMH), storm: 0.075, hail: 0.11 });

function normalizedToMmh(intensity) {
  return clamp(intensity, 0, 1) * RAIN_FULL_SCALE_MMH;
}

function interpolateRadiusFraction(intensity, anchors) {
  const mmh = normalizedToMmh(intensity);
  if (mmh <= anchors[0].mmh) return anchors[0].radius;
  for (let index = 1; index < anchors.length; index++) {
    const upper = anchors[index];
    if (mmh <= upper.mmh) {
      const lower = anchors[index - 1];
      const progress = (mmh - lower.mmh) / (upper.mmh - lower.mmh);
      const area = lower.radius * lower.radius + (upper.radius * upper.radius - lower.radius * lower.radius) * progress;
      return Math.sqrt(area);
    }
  }
  return anchors[anchors.length - 1].radius;
}

export function rainRadiusFraction(intensity) {
  return interpolateRadiusFraction(intensity, RAIN_BASE_RADIUS_ANCHORS);
}

export function strongRainRadiusFraction(intensity) {
  return interpolateRadiusFraction(intensity, RAIN_STRONG_RADIUS_ANCHORS);
}

export function strongRainIntensityToRadius(intensity, spacing) {
  return spacing * strongRainRadiusFraction(intensity);
}

function transferShader(name, anchors, maximumRadius) {
  const lines = [`float ${name}(float value) {`];
  lines.push(`  if (value <= ${normalizedRainAnchor(anchors[0].mmh).toFixed(6)}) return ${(anchors[0].radius / maximumRadius).toFixed(6)};`);
  for (let index = 1; index < anchors.length; index++) {
    const lower = anchors[index - 1];
    const upper = anchors[index];
    const lowerValue = normalizedRainAnchor(lower.mmh);
    const upperValue = normalizedRainAnchor(upper.mmh);
    const lowerArea = (lower.radius * lower.radius).toFixed(6);
    const upperArea = (upper.radius * upper.radius).toFixed(6);
    lines.push(`  if (value <= ${upperValue.toFixed(6)}) { float t = (value - ${lowerValue.toFixed(6)}) / ${(upperValue - lowerValue).toFixed(6)}; return sqrt(mix(${lowerArea}, ${upperArea}, clamp(t, 0.0, 1.0))) / ${maximumRadius.toFixed(6)}; }`);
  }
  lines.push('  return 1.0;');
  lines.push('}');
  return lines.join('\n');
}

export const RAIN_VISIBILITY_SHADER = transferShader('rainVisibility', RAIN_BASE_RADIUS_ANCHORS, RAIN_BASE_RADIUS_ANCHORS[RAIN_BASE_RADIUS_ANCHORS.length - 1].radius);
export const STRONG_RAIN_SHADER = transferShader('strongRain', RAIN_STRONG_RADIUS_ANCHORS, RAIN_STRONG_RADIUS_ANCHORS[RAIN_STRONG_RADIUS_ANCHORS.length - 1].radius);

export function intensityToStrength(intensity, layer, thresholds = INTENSITY_THRESHOLDS) {
  return smoothstep(thresholds[layer] * 0.45, 0.93, intensity);
}

export function intensityToRadius(intensity, spacing, layer) {
  if (layer === 'rain') return spacing * rainRadiusFraction(intensity);
  // Hazard glyphs retain their existing normalized transfer semantics.
  const normalized = intensityToStrength(intensity, layer, INTENSITY_THRESHOLDS);
  const overlap = layer === 'rain' ? 0.86 : layer === 'storm' ? 0.72 : 0.59;
  return spacing * overlap * Math.pow(normalized, layer === 'rain' ? 0.47 : 0.56);
}
