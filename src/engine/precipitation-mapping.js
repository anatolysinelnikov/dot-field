import {
  RAIN_BASE_RADIUS_ANCHORS,
  RAIN_STRONG_RADIUS_ANCHORS
} from './config.js';
import { clamp, smoothstep } from './math.js';

export const INTENSITY_THRESHOLDS = Object.freeze({ storm: 0.075, hail: 0.11 });
export const DOTS_STRONG_RAIN_ONSET_MMH = 1.6;
// Fixed Dots-only presentation anchor. It is not mutable UI/runtime state.
export const DOTS_STRONG_RAIN_FULL_MMH = 35;
export const DOTS_STRONG_RAIN_SHAPE_ANCHORS = Object.freeze([
  { progress: 0.00, radius: 0.00 },
  { progress: 0.03, radius: 0.12 },
  { progress: 0.10, radius: 0.25 },
  { progress: 0.25, radius: 0.42 },
  { progress: 0.55, radius: 0.65 },
  { progress: 1.00, radius: 0.86 }
]);
export const DOTS_BASE_RAIN_MAX_RADIUS_FRACTION = RAIN_BASE_RADIUS_ANCHORS[RAIN_BASE_RADIUS_ANCHORS.length - 1].radius;

function interpolateSquaredRadius(progress, lower, upper) {
  const area = lower.radius * lower.radius + (upper.radius * upper.radius - lower.radius * lower.radius) * clamp(progress, 0, 1);
  return Math.sqrt(area);
}

function interpolateRadiusFraction(rainMmh, anchors) {
  const mmh = Math.max(0, Number(rainMmh));
  if (mmh <= anchors[0].mmh) return anchors[0].radius;
  for (let index = 1; index < anchors.length; index++) {
    const upper = anchors[index];
    if (mmh <= upper.mmh) {
      const lower = anchors[index - 1];
      const progress = (mmh - lower.mmh) / (upper.mmh - lower.mmh);
      return interpolateSquaredRadius(progress, lower, upper);
    }
  }
  return anchors[anchors.length - 1].radius;
}

function interpolateShapeRadius(progress, anchors) {
  const clamped = clamp(progress, 0, 1);
  for (let index = 1; index < anchors.length; index++) {
    const upper = anchors[index];
    if (clamped <= upper.progress) {
      const lower = anchors[index - 1];
      const span = upper.progress - lower.progress;
      const localProgress = span > 0 ? (clamped - lower.progress) / span : 0;
      return interpolateSquaredRadius(localProgress, lower, upper);
    }
  }
  return anchors[anchors.length - 1].radius;
}

export function rainMmhToRadiusFraction(rainMmh) {
  return interpolateRadiusFraction(rainMmh, RAIN_BASE_RADIUS_ANCHORS);
}

export function rainMmhToRadius(rainMmh, spacing) {
  return spacing * rainMmhToRadiusFraction(rainMmh);
}

export function dotsStrongRainMmhToRadiusFraction(rainMmh) {
  const mmh = Math.max(0, Number(rainMmh));
  const full = DOTS_STRONG_RAIN_FULL_MMH;
  if (mmh <= DOTS_STRONG_RAIN_ONSET_MMH) return 0;
  if (mmh >= full) return DOTS_STRONG_RAIN_SHAPE_ANCHORS[DOTS_STRONG_RAIN_SHAPE_ANCHORS.length - 1].radius;
  const progress = (mmh - DOTS_STRONG_RAIN_ONSET_MMH) / (full - DOTS_STRONG_RAIN_ONSET_MMH);
  return interpolateShapeRadius(progress, DOTS_STRONG_RAIN_SHAPE_ANCHORS);
}

export function dotsStrongRainMmhToRadius(rainMmh, spacing) {
  return spacing * dotsStrongRainMmhToRadiusFraction(rainMmh);
}

function transferShader(name, anchors, maximumRadius) {
  const lines = [`float ${name}(float value) {`];
  lines.push(`  if (value <= ${anchors[0].mmh.toFixed(6)}) return ${(anchors[0].radius / maximumRadius).toFixed(6)};`);
  for (let index = 1; index < anchors.length; index++) {
    const lower = anchors[index - 1];
    const upper = anchors[index];
    const lowerValue = lower.mmh;
    const upperValue = upper.mmh;
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
  if (layer === 'rain') return spacing * rainMmhToRadiusFraction(intensity);
  // Hazard glyphs retain their existing normalized transfer semantics.
  const normalized = intensityToStrength(intensity, layer, INTENSITY_THRESHOLDS);
  const overlap = layer === 'storm' ? 0.72 : 0.59;
  return spacing * overlap * Math.pow(normalized, 0.56);
}
