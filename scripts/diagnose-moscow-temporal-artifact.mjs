import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { decodePackedWeatherSupport, RealWeatherSequence } from '../src/engine/real-weather.js';

// Diagnostic-only dense physical-field trajectory. The current pointer is
// resolved once so a generation refresh cannot mix source and motion assets.
const currentRoot = resolve(new URL('../data/generated/current/', import.meta.url).pathname);
const currentMetadata = JSON.parse(await readFile(resolve(currentRoot, 'metadata.json'), 'utf8'));
const generationId = process.env.DOT_FIELD_GENERATION || currentMetadata.generation_id;
const generationRoot = resolve(currentRoot, '..', generationId);
const metadataPath = resolve(generationRoot, 'metadata.json');
const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
if (metadata.generation_id !== generationId) throw new Error('generation metadata mismatch');
const grid = metadata.spatial_grid; const W = grid.width; const H = grid.height; const N = W * H;
const root = dirname(metadataPath);
const frames = await Promise.all(metadata.rain.frame_assets.map(async (asset) => {
  const b = await readFile(resolve(root, asset));
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}));
const motions = await Promise.all(metadata.motion.interval_assets.map(async (asset) => {
  const b = await readFile(resolve(root, asset));
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}));
const supportBuffer = await readFile(resolve(root, metadata.support_mask.asset));
const support = decodePackedWeatherSupport(supportBuffer.buffer.slice(supportBuffer.byteOffset, supportBuffer.byteOffset + supportBuffer.byteLength), N);
const longitudes = Float64Array.from({ length: W }, (_, x) => grid.longitude_start + x * grid.longitude_spacing);
const latitudes = Float64Array.from({ length: H }, (_, y) => grid.latitude_start + y * grid.latitude_spacing);
const motion = { width: metadata.motion.grid_width, height: metadata.motion.grid_height, spacing: metadata.motion.grid_spacing_source_nodes, intervals: motions };
const makeSequence = (temporalMode) => new RealWeatherSequence({
  longitudes, latitudes, sourceFrames: new Map(frames.map((values, index) => [index, values])),
  frameCount: metadata.time.count, longitudeSpacing: grid.longitude_spacing, latitudeSpacing: grid.latitude_spacing,
  weatherSupport: grid.weather_support, timestamps: metadata.time.timestamps, potentialWeatherMask: support,
  motion, temporalMode, generationId, sourceFrameCacheLimit: metadata.time.count, retainAllSourceFrames: true
});

const corridor = { west: 37, east: 42, south: 54.5, north: 57.5 };
const x0 = Math.max(0, Math.floor((corridor.west - grid.longitude_start) / grid.longitude_spacing));
const x1 = Math.min(W - 1, Math.ceil((corridor.east - grid.longitude_start) / grid.longitude_spacing));
const y0 = Math.max(0, Math.floor((corridor.south - grid.latitude_start) / grid.latitude_spacing));
const y1 = Math.min(H - 1, Math.ceil((corridor.north - grid.latitude_start) / grid.latitude_spacing));
const candidates = [];
for (let frame = 0; frame < frames.length; frame++) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const value = frames[frame][y * W + x];
    if (value > 0) candidates.push({ frame, x, y, value });
  }
}
candidates.sort((a, b) => b.value - a.value);
const patches = [];
for (const candidate of candidates) {
  if (patches.every((patch) => Math.hypot(candidate.x - patch.x, candidate.y - patch.y) > 32)) {
    patches.push(candidate);
    if (patches.length === 3) break;
  }
}
if (!patches.length) throw new Error('No positive Moscow-area precipitation candidates in the frozen generation.');

const samplesPerInterval = 50;
const radius = 24;
const thresholds = [0.1, 1, 5];
function trajectory(sequence, patch, threshold) {
  const minX = Math.max(0, patch.x - radius); const maxX = Math.min(W - 1, patch.x + radius);
  const minY = Math.max(0, patch.y - radius); const maxY = Math.min(H - 1, patch.y + radius);
  const axisX = Float64Array.from({ length: maxX - minX + 1 }, (_, i) => longitudes[minX + i]);
  const axisY = Float64Array.from({ length: maxY - minY + 1 }, (_, i) => latitudes[minY + i]);
  const geometry = sequence.prepareRectangularSamplingGeometry(axisX, axisY, axisX.length, axisY.length);
  const values = [];
  for (let sample = 0; sample <= (frames.length - 1) * samplesPerInterval; sample++) {
    const time = sample / ((frames.length - 1) * samplesPerInterval);
    const frame = sequence.prepareFrame(time);
    const rain = frame.samplePreparedBatch(geometry);
    let weight = 0; let sx = 0; let sy = 0; let peak = 0;
    for (let row = 0; row < axisY.length; row++) for (let col = 0; col < axisX.length; col++) {
      const value = rain[row * axisX.length + col]; const w = Math.max(0, value - threshold);
      weight += w; sx += (minX + col) * w; sy += (minY + row) * w; peak = Math.max(peak, value);
    }
    values.push({ sample, sourceInterval: frame.frame0, progress: frame.progress, x: weight ? sx / weight : null, y: weight ? sy / weight : null, peak, weight });
  }
  const steps = []; let backwardSteps = 0; let stalls = 0; let directionChanges = 0; let maxBackward = 0; let previousVector = null;
  for (let i = 1; i < values.length; i++) {
    const a = values[i - 1]; const b = values[i];
    if (a.x === null || b.x === null) continue;
    const dx = b.x - a.x; const dy = b.y - a.y; const magnitude = Math.hypot(dx, dy);
    const projection = previousVector && Math.hypot(...previousVector) > 1e-6 ? (dx * previousVector[0] + dy * previousVector[1]) / Math.hypot(...previousVector) : magnitude;
    if (projection < -1e-4) { backwardSteps++; maxBackward = Math.min(maxBackward, projection); }
    if (magnitude < 0.002) stalls++;
    if (previousVector && magnitude > 1e-5 && (dx * previousVector[0] + dy * previousVector[1]) < 0) directionChanges++;
    if (magnitude > 1e-5) previousVector = [dx, dy];
    steps.push({ sample: b.sample, sourceInterval: b.sourceInterval, progress: b.progress, dx, dy, magnitude, projectedStep: projection });
  }
  const boundary = [];
  for (let interval = 0; interval < frames.length - 2; interval++) {
    const center = (interval + 1) * samplesPerInterval;
    const before = values[center - 1]; const exact = values[center]; const after = values[center + 1];
    boundary.push({ interval, before, exact, after, beforeToExact: [exact.x - before.x, exact.y - before.y], exactToAfter: [after.x - exact.x, after.y - exact.y] });
  }
  return { threshold, window: { sourceX: [minX, maxX], sourceY: [minY, maxY], radius }, samples: values.length, values, steps, metrics: { backwardSteps, stalls, directionChanges, maxBackwardStep: maxBackward }, boundaries: boundary };
}

const reports = patches.map((patch, index) => ({
  patch: { index, selectedFrame: patch.frame, source: [patch.x, patch.y], lonLat: [longitudes[patch.x], latitudes[patch.y]], peakMmh: patch.value },
  motion: thresholds.map((threshold) => trajectory(makeSequence('motion'), patch, threshold)),
  linear: thresholds.map((threshold) => trajectory(makeSequence('linear'), patch, threshold))
}));
const compact = reports.map((report) => ({
  patch: report.patch,
  motion: report.motion.map(({ threshold, metrics, boundaries }) => ({ threshold, metrics, boundaries })),
  linear: report.linear.map(({ threshold, metrics, boundaries }) => ({ threshold, metrics, boundaries }))
}));
if (process.env.DOT_FIELD_SUMMARY === '1') {
  const summarize = (entry) => ({ threshold: entry.threshold, metrics: entry.metrics, worstSteps: [...entry.steps].filter((step) => step.projectedStep < -1e-4).sort((a, b) => a.projectedStep - b.projectedStep).slice(0, 5), backwardByLocation: {
    withinInterval: entry.steps.filter((step, i) => step.projectedStep < -1e-4 && i > 0 && entry.steps[i - 1].sourceInterval === step.sourceInterval).length,
    atBoundary: entry.steps.filter((step, i) => step.projectedStep < -1e-4 && i > 0 && entry.steps[i - 1].sourceInterval !== step.sourceInterval).length,
    maxWithinInterval: Math.min(0, ...entry.steps.filter((step, i) => i > 0 && entry.steps[i - 1].sourceInterval === step.sourceInterval).map((step) => step.projectedStep)),
    maxAtBoundary: Math.min(0, ...entry.steps.filter((step, i) => i > 0 && entry.steps[i - 1].sourceInterval !== step.sourceInterval).map((step) => step.projectedStep))
  } });
  console.log(JSON.stringify({
    frozenGeneration: { id: generationId, sequence: [metadata.time.timestamps[0], metadata.time.timestamps.at(-1)], frameCount: frames.length, sourceGrid: [W, H], motionGrid: [motion.width, motion.height] },
    patches: reports.map((report) => ({ patch: report.patch, motion: report.motion.map(summarize), linear: report.linear.map(summarize) }))
  }, null, 2));
  process.exit(0);
}
console.log(JSON.stringify({ frozenGeneration: { id: generationId, path: generationRoot, source: metadata.source?.filename || null, sequence: [metadata.time.timestamps[0], metadata.time.timestamps.at(-1)], frameCount: frames.length, sourceGrid: [W, H], motionGrid: [motion.width, motion.height], motionSpacingSourceNodes: motion.spacing }, corridor, method: { samplesPerInterval, temporalSamples: (frames.length - 1) * samplesPerInterval + 1, fixedWindowRadiusSourceNodes: radius, thresholds, centroidWeight: 'max(rain - threshold, 0)' }, reports: compact }, null, 2));
