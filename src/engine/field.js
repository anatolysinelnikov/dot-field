import { clamp, mix, smoothstep } from './math.js';

function periodicPulse(t, phase, width = 1) {
  return 0.5 + 0.5 * Math.sin((t + phase) * Math.PI * 2 * width);
}

function gaussian(x, y, cx, cy, sx, sy, rotation = 0) {
  const dx = x - cx;
  const dy = y - cy;
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  const rx = dx * c + dy * s;
  const ry = -dx * s + dy * c;
  return Math.exp(-0.5 * ((rx * rx) / (sx * sx) + (ry * ry) / (sy * sy)));
}

function travelingGaussian(x, y, anchorX, offsetX, cy, sx, sy, rotation = 0) {
  return gaussian(x, y, anchorX + offsetX, cy, sx, sy, rotation);
}

// ── Intensity field generation ───────────────────────────────────────────
// The field travels beneath the fixed sampling grid. Component offsets stay
// locked together while amplitude, width, and rotation continue to evolve.
// Add or tune Gaussian components here to change the weather shapes.
export function intensityAt(x, y, t, travelX) {
  // Safe empty-space rejection: beyond this support even the widest Gaussian
  // is far below every visible radius threshold. The fixed lattice remains unbounded.
  if (Math.abs(x - travelX) > 0.92 || Math.abs(y - 0.5) > 0.76) {
    return { rain: 0, storm: 0, hail: 0 };
  }

  const waveA = periodicPulse(t, 0.02);
  const waveB = periodicPulse(t, 0.36);
  const waveC = periodicPulse(t, 0.68);
  // A smooth loop envelope lets the system restart without a sharp
  // appearance/disappearance at the timeline seam.
  const lifecycle = smoothstep(0, 0.12, t) * smoothstep(0, 0.12, 1 - t);

  const rainA = travelingGaussian(x, y, travelX, -0.05, 0.47,
    mix(0.17, 0.25, waveA), mix(0.12, 0.18, waveB), mix(-0.35, 0.18, waveC));
  const rainB = travelingGaussian(x, y, travelX, 0.16, 0.39,
    mix(0.10, 0.18, waveB), mix(0.09, 0.14, waveA), 0.62);
  const rainC = travelingGaussian(x, y, travelX, -0.13, 0.66,
    mix(0.07, 0.14, waveC), mix(0.11, 0.18, waveA), -0.46);
  const rainNotch = travelingGaussian(x, y, travelX, 0.02, 0.54,
    mix(0.05, 0.12, waveB), mix(0.04, 0.09, waveB), 0.15);

  let rain = rainA * mix(0.72, 1.05, waveA)
    + rainB * mix(0.22, 0.76, waveB)
    + rainC * mix(0.18, 0.65, waveC)
    - rainNotch * mix(0.02, 0.26, waveB);

  const stormA = travelingGaussian(x, y, travelX, 0, 0.47,
    mix(0.075, 0.125, waveB), mix(0.055, 0.095, waveC), -0.25);
  const stormB = travelingGaussian(x, y, travelX, 0.13, 0.40,
    mix(0.045, 0.085, waveC), mix(0.04, 0.07, waveA), 0.65);
  const stormC = travelingGaussian(x, y, travelX, -0.11, 0.60,
    mix(0.04, 0.075, waveA), mix(0.045, 0.09, waveB), -0.5);
  let storm = stormA * mix(0.42, 1.0, waveB)
    + stormB * mix(0.18, 0.88, waveC)
    + stormC * mix(0.10, 0.67, waveA);

  const hailA = travelingGaussian(x, y, travelX, 0.025, 0.445,
    mix(0.028, 0.052, waveC), mix(0.024, 0.046, waveA), -0.2);
  const hailB = travelingGaussian(x, y, travelX, 0.125, 0.39,
    mix(0.018, 0.040, waveA), mix(0.020, 0.045, waveB), 0.7);
  const hailC = travelingGaussian(x, y, travelX, -0.08, 0.585,
    mix(0.017, 0.034, waveB), mix(0.021, 0.043, waveC), -0.3);
  let hail = hailA * mix(0.16, 0.95, waveC)
    + hailB * mix(0.04, 0.73, waveA)
    + hailC * mix(0.02, 0.55, waveB);

  // Fine, deterministic structure becomes visible only where precipitation exists.
  // Keep fine structure continuous as it passes through each fixed grid point.
  // A wrapped coordinate here would create a visible intensity discontinuity.
  const localX = x - travelX;
  const detail = 0.91
    + 0.045 * Math.sin(localX * 47 + Math.sin(y * 31))
    + 0.035 * Math.sin(y * 59 - localX * 17);
  rain *= detail * lifecycle;
  storm *= (0.96 + 0.045 * Math.sin(localX * 41 + y * 33)) * lifecycle;
  hail *= (0.97 + 0.035 * Math.sin(localX * 53 - y * 47)) * lifecycle;

  return {
    rain: clamp(rain),
    storm: clamp(storm),
    hail: clamp(hail)
  };
}
