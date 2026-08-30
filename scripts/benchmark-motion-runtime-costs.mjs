// Diagnostic-only: compare the production temporal implementation without changing runtime behavior.
import { performance } from 'node:perf_hooks';
import { loadRealWeatherFixture } from './real-weather-fixture.mjs';
import { prepareGeographicSamplingGeometry, setActiveWeatherField } from '../src/engine/geography.js';
import { GeographicLodTopology, lodRangeForStableLevel } from '../src/engine/geographic-lod.js';
import { GeographicWeatherPyramid } from '../src/engine/geographic-weather-pyramid.js';

const { metadata, weather } = await loadRealWeatherFixture({ retainAllSourceFrames: true });
setActiveWeatherField(weather);
const midpointOfFirstInterval = 0.5 / (weather.frameCount - 1);
const levels = [10, 12, 13, 14];
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); const p = (q) => s[Math.floor((s.length - 1) * q)]; return { medianMs: p(.5), p95Ms: p(.95), p99Ms: p(.99) }; };
const time = (fn, warm = 3, repeats = 15) => { for (let i = 0; i < warm; i++) fn(); const xs = []; for (let i = 0; i < repeats; i++) { const t = performance.now(); fn(); xs.push(performance.now() - t); } return stats(xs); };
function topology(level) { return new GeographicLodTopology(undefined, lodRangeForStableLevel(level)); }
function geometryFor(level) { const t = topology(level); const data = t.levels.get(level); const frame = weather.prepareFrame(midpointOfFirstInterval); return { frame, geometry: prepareGeographicSamplingGeometry(frame, data) }; }
function temporalRun(frame, geometry, kind) {
  if (kind === 'linear') weather.setTemporalMode('linear');
  else weather.setTemporalMode('motion');
  const sample = frame.prepareTemporalSampling(geometry); let sum = 0;
  for (let i = 0; i < geometry.potentialActiveIndices.length; i++) sum += sample(i);
  if (!Number.isFinite(sum)) throw new Error('non-finite temporal sum');
}
const rows = [];
for (const level of levels) {
  const { frame, geometry } = geometryFor(level); const count = geometry.potentialActiveIndices.length;
  const linear = time(() => temporalRun(frame, geometry, 'linear'));
  const motion = time(() => temporalRun(frame, geometry, 'motion'));
  const generic = time(() => { weather.setTemporalMode('motion'); let sum = 0; const out = {}; for (const index of geometry.potentialActiveIndices) sum += frame.samplePrepared(geometry, index, out).rainMmh; if (!Number.isFinite(sum)) throw new Error('non-finite generic sum'); }, 2, 7);
  const prefixedLinear = time(() => { weather.setTemporalMode('linear'); const a = frame.preparedSourceFrame(geometry, frame.frame0), b = frame.preparedSourceFrame(geometry, frame.frame1), active = geometry.potentialActiveIndices; let sum = 0; for (const index of active) { let lo = 0, hi = active.length - 1; while (lo <= hi) { const mid = (lo + hi) >>> 1; if (active[mid] < index) lo = mid + 1; else if (active[mid] > index) hi = mid - 1; else { sum += a[mid] + (b[mid] - a[mid]) * frame.progress; break; } } } if (!Number.isFinite(sum)) throw new Error('non-finite linear sum'); }, 2, 7);
  rows.push({ level, activeCandidates: count, preparedStateBytes: weather.motionPreparedBytes(geometry), linear: { ...linear, usPerActive: linear.medianMs * 1000 / count }, motion: { ...motion, usPerActive: motion.medianMs * 1000 / count }, genericPreparedMotion: generic, preFixGenericLinear: prefixedLinear });
}
const full = [];
for (const level of levels) {
  const linearPyramid = new GeographicWeatherPyramid(Float32Array, topology(level));
  const motionPyramid = new GeographicWeatherPyramid(Float32Array, topology(level));
  const frame = weather.prepareFrame(midpointOfFirstInterval); let linearState = null; let motionState = null;
  const linear = time(() => { weather.setTemporalMode('linear'); linearState = linearPyramid.evaluate([level], frame, linearState); });
  const motion = time(() => { weather.setTemporalMode('motion'); motionState = motionPyramid.evaluate([level], frame, motionState); });
  full.push({ level, actualEvaluation: level <= 12 ? 'fused L13 temporal sampling plus aggregation' : `direct L${level}`, linear, motion, pyramidTypedArrayBytes: { linear: linearPyramid.snapshot().knownTypedArrayBytes, motion: motionPyramid.snapshot().knownTypedArrayBytes } });
}
console.log(JSON.stringify({ frozenGeneration: { id: metadata.generation_id, sourceNetcdf: metadata.source.filename, sourceGrid: [metadata.spatial_grid.width, metadata.spatial_grid.height], motionGrid: [metadata.motion.grid_width, metadata.motion.grid_height] }, methodology: 'Desktop Node.js timings; production RealWeatherSequence and GeographicWeatherPyramid, midpoint of the first source interval. No WebGL context.', temporalOnly: rows, pyramid: full }, null, 2));
