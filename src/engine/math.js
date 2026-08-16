export const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
export const mix = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
        const t = clamp((x - a) / (b - a));
        return t * t * (3 - 2 * t);
      };

export function periodicPulse(t, phase, width = 1) {
  return 0.5 + 0.5 * Math.sin((t + phase) * Math.PI * 2 * width);
}

export function gaussian(x, y, cx, cy, sx, sy, rotation = 0) {
  const dx = x - cx;
  const dy = y - cy;
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  const rx = dx * c + dy * s;
  const ry = -dx * s + dy * c;
  return Math.exp(-0.5 * ((rx * rx) / (sx * sx) + (ry * ry) / (sy * sy)));
}

export function travelingGaussian(x, y, anchorX, offsetX, cy, sx, sy, rotation = 0) {
  return gaussian(x, y, anchorX + offsetX, cy, sx, sy, rotation);
}
