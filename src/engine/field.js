import { clamp, mix, smoothstep } from './math.js';

function periodicPulse(t, phase, width = 1) {
  return 0.5 + 0.5 * Math.sin((t + phase) * Math.PI * 2 * width);
}

function preparedGaussian(cx, cy, sx, sy, rotation, amplitude) {
  return {
    cx,
    cy,
    inverseSxSquared: 1 / (sx * sx),
    inverseSySquared: 1 / (sy * sy),
    cosine: Math.cos(rotation),
    sine: Math.sin(rotation),
    amplitude
  };
}

function evaluateGaussian(component, x, y) {
  const dx = x - component.cx;
  const dy = y - component.cy;
  const rx = dx * component.cosine + dy * component.sine;
  const ry = -dx * component.sine + dy * component.cosine;
  return Math.exp(-0.5 * (rx * rx * component.inverseSxSquared + ry * ry * component.inverseSySquared)) * component.amplitude;
}

// ── Intensity field generation ───────────────────────────────────────────
// Time-only values are prepared once per keyframe. The field continues to
// travel beneath a fixed sampling lattice; component offsets stay locked
// together while amplitude, width, and rotation evolve deterministically.
export function prepareFieldFrame(t, travelX) {
  const waveA = periodicPulse(t, 0.02);
  const waveB = periodicPulse(t, 0.36);
  const waveC = periodicPulse(t, 0.68);
  const lifecycle = smoothstep(0, 0.12, t) * smoothstep(0, 0.12, 1 - t);

  return {
    t,
    travelX,
    lifecycle,
    rain: [
      preparedGaussian(travelX - 0.05, 0.47, mix(0.17, 0.25, waveA), mix(0.12, 0.18, waveB), mix(-0.35, 0.18, waveC), mix(0.72, 1.05, waveA)),
      preparedGaussian(travelX + 0.16, 0.39, mix(0.10, 0.18, waveB), mix(0.09, 0.14, waveA), 0.62, mix(0.22, 0.76, waveB)),
      preparedGaussian(travelX - 0.13, 0.66, mix(0.07, 0.14, waveC), mix(0.11, 0.18, waveA), -0.46, mix(0.18, 0.65, waveC)),
      preparedGaussian(travelX + 0.02, 0.54, mix(0.05, 0.12, waveB), mix(0.04, 0.09, waveB), 0.15, mix(0.02, 0.26, waveB))
    ],
    storm: [
      preparedGaussian(travelX, 0.47, mix(0.075, 0.125, waveB), mix(0.055, 0.095, waveC), -0.25, mix(0.42, 1.0, waveB)),
      preparedGaussian(travelX + 0.13, 0.40, mix(0.045, 0.085, waveC), mix(0.04, 0.07, waveA), 0.65, mix(0.18, 0.88, waveC)),
      preparedGaussian(travelX - 0.11, 0.60, mix(0.04, 0.075, waveA), mix(0.045, 0.09, waveB), -0.5, mix(0.10, 0.67, waveA))
    ],
    hail: [
      preparedGaussian(travelX + 0.025, 0.445, mix(0.028, 0.052, waveC), mix(0.024, 0.046, waveA), -0.2, mix(0.16, 0.95, waveC)),
      preparedGaussian(travelX + 0.125, 0.39, mix(0.018, 0.040, waveA), mix(0.020, 0.045, waveB), 0.7, mix(0.04, 0.73, waveA)),
      preparedGaussian(travelX - 0.08, 0.585, mix(0.017, 0.034, waveB), mix(0.021, 0.043, waveC), -0.3, mix(0.02, 0.55, waveB))
    ]
  };
}

function sumComponents(components, x, y) {
  let value = 0;
  for (const component of components) value += evaluateGaussian(component, x, y);
  return value;
}

function sumFirstComponents(components, count, x, y) {
  let value = 0;
  for (let index = 0; index < count; index++) value += evaluateGaussian(components[index], x, y);
  return value;
}

export function evaluatePreparedField(frame, x, y, output = {}) {
  if (Math.abs(x - frame.travelX) > 0.92 || Math.abs(y - 0.5) > 0.76) {
    output.rain = 0;
    output.storm = 0;
    output.hail = 0;
    return output;
  }

  const localX = x - frame.travelX;
  const detail = 0.91
    + 0.045 * Math.sin(localX * 47 + Math.sin(y * 31))
    + 0.035 * Math.sin(y * 59 - localX * 17);

  output.rain = clamp((sumFirstComponents(frame.rain, 3, x, y) - evaluateGaussian(frame.rain[3], x, y)) * detail * frame.lifecycle);
  output.storm = clamp(sumComponents(frame.storm, x, y) * (0.96 + 0.045 * Math.sin(localX * 41 + y * 33)) * frame.lifecycle);
  output.hail = clamp(sumComponents(frame.hail, x, y) * (0.97 + 0.035 * Math.sin(localX * 53 - y * 47)) * frame.lifecycle);
  return output;
}

// Preserve the legacy public API for older renderers. Geographic Dots uses
// prepared frames so this allocation-heavy convenience path is not hot.
export function intensityAt(x, y, t, travelX) {
  return evaluatePreparedField(prepareFieldFrame(t, travelX), x, y);
}
