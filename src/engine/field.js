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
      preparedGaussian(travelX - 0.02, 0.42, mix(0.13, 0.19, waveB), mix(0.10, 0.145, waveC), -0.25, mix(0.42, 0.92, waveB)),
      preparedGaussian(travelX + 0.13, 0.35, mix(0.075, 0.125, waveC), mix(0.06, 0.10, waveA), 0.65, mix(0.18, 0.78, waveC)),
      preparedGaussian(travelX - 0.12, 0.55, mix(0.07, 0.115, waveA), mix(0.065, 0.115, waveB), -0.5, mix(0.10, 0.68, waveA))
    ],
    hail: [
      preparedGaussian(travelX - 0.015, 0.46, mix(0.085, 0.135, waveC), mix(0.065, 0.105, waveA), -0.2, mix(0.16, 0.95, waveC)),
      preparedGaussian(travelX + 0.08, 0.415, mix(0.055, 0.095, waveA), mix(0.045, 0.075, waveB), 0.7, mix(0.04, 0.73, waveA)),
      preparedGaussian(travelX - 0.07, 0.54, mix(0.05, 0.085, waveB), mix(0.045, 0.075, waveC), -0.3, mix(0.02, 0.55, waveB))
    ],
    // Prototype hazard family. These remain independent scalar channels; the
    // renderer assigns squall grades only after sampling the field.
    squall: [
      preparedGaussian(travelX - 0.015, 0.47, mix(0.060, 0.090, waveA), mix(0.050, 0.075, waveB), 0.18, mix(0.42, 0.58, waveA)),
      preparedGaussian(travelX + 0.025, 0.47, mix(0.040, 0.065, waveB), mix(0.034, 0.055, waveC), -0.25, mix(0.58, 0.76, waveB)),
      preparedGaussian(travelX + 0.045, 0.47, mix(0.026, 0.045, waveC), mix(0.024, 0.040, waveA), 0.34, mix(0.74, 0.98, waveC))
    ],
    hurricane: [
      preparedGaussian(travelX + 0.045, 0.47, mix(0.014, 0.024, waveB), mix(0.012, 0.021, waveA), -0.18, mix(0.80, 1.0, waveB))
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
    output.squall = 0;
    output.hurricane = 0;
    return output;
  }

  const localX = x - frame.travelX;
  const detail = 0.91
    + 0.045 * Math.sin(localX * 47 + Math.sin(y * 31))
    + 0.035 * Math.sin(y * 59 - localX * 17);

  output.rain = clamp((sumFirstComponents(frame.rain, 3, x, y) - evaluateGaussian(frame.rain[3], x, y)) * detail * frame.lifecycle);
  output.storm = clamp(sumComponents(frame.storm, x, y) * (0.96 + 0.045 * Math.sin(localX * 41 + y * 33)) * frame.lifecycle);
  output.hail = clamp(sumComponents(frame.hail, x, y) * (0.97 + 0.035 * Math.sin(localX * 53 - y * 47)) * frame.lifecycle);
  output.squall = clamp(sumComponents(frame.squall, x, y) * (0.97 + 0.035 * Math.sin(localX * 37 + y * 29)) * frame.lifecycle);
  output.hurricane = clamp(sumComponents(frame.hurricane, x, y) * (0.98 + 0.02 * Math.sin(localX * 31 - y * 23)) * frame.lifecycle);
  return output;
}

// Direct evaluation remains available for callers that do not use prepared
// frames; this allocation-heavy convenience path is not hot.
export function intensityAt(x, y, t, travelX) {
  return evaluatePreparedField(prepareFieldFrame(t, travelX), x, y);
}
