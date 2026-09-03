import {
  TILED_RAIN_GRID_SIZE,
  TILED_RAIN_TILE_SIZE,
  TILED_RAIN_WARP_HALO_SIZE,
} from './tiled-rain.js';
import {
  DOTS_BASE_RAIN_MAX_RADIUS_FRACTION,
  DOTS_STRONG_RAIN_ONSET_MMH,
  dotsStrongRainMmhToRadiusFraction,
  rainMmhToRadiusFraction,
} from './precipitation-mapping.js';

export const MOTION_PROBE_SCHEMA = 'dot-field-motion-probe-v1';
export const MOTION_PROBE_LARGE_VECTOR_CHANGE = 4;

const finite = (value) => Number.isFinite(value) ? value : null;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const key = (x, y) => `${x}:${y}`;
const tileFor = (value) => Math.floor(value / TILED_RAIN_TILE_SIZE);
const localFor = (value) => value - tileFor(value) * TILED_RAIN_TILE_SIZE;
const ownerFor = (gx, gy) => ({ tileX: tileFor(gx), tileY: tileFor(gy), tileKey: key(tileFor(gx), tileFor(gy)) });

export function sourceFrameForProbe(frameCount, time) {
  const position = clamp(Number.isFinite(time) ? time : 0, 0, 1) * (frameCount - 1);
  const frameA = Math.floor(position);
  const progress = position - frameA;
  return { frameA, frameB: progress === 0 ? frameA : Math.min(frameCount - 1, frameA + 1), progress };
}

export function rainCodeToMmh(code, physicalMaxMmh) {
  if (code === 0 || code === 1) return 0;
  return (code - 1) / 65534 * physicalMaxMmh;
}

function frameValue(store, gx, gy, frame, owner = ownerFor(gx, gy)) {
  const tileKey = owner.tileKey;
  const blockIndex = Math.floor(frame / store.manifest.temporal_block_size);
  const state = store.blocks.get(`${tileKey}:${blockIndex}`);
  if (state?.status !== 'ready' || !state.payload) return { available: false, reason: 'rain-block-not-resident', tileKey, blockIndex };
  const descriptor = state.descriptor;
  const layer = frame - descriptor.frame_start;
  if (layer < 0 || layer >= descriptor.frame_count) return { available: false, reason: 'rain-frame-not-in-resident-block', tileKey, blockIndex };
  const localX = gx - owner.tileX * TILED_RAIN_TILE_SIZE + (store.motionWarp ? TILED_RAIN_WARP_HALO_SIZE : 0);
  const localY = gy - owner.tileY * TILED_RAIN_TILE_SIZE + (store.motionWarp ? TILED_RAIN_WARP_HALO_SIZE : 0);
  const size = store.motionWarp ? TILED_RAIN_TILE_SIZE + 2 * TILED_RAIN_WARP_HALO_SIZE : TILED_RAIN_TILE_SIZE;
  if (!Number.isInteger(localX) || !Number.isInteger(localY) || localX < 0 || localX >= size || localY < 0 || localY >= size) return { available: false, reason: 'rain-coordinate-outside-owner-footprint', tileKey, blockIndex };
  const codes = new Uint16Array(state.payload);
  return { available: true, code: codes[layer * size * size + localY * size + localX], tileKey, blockIndex };
}

export function bilinearRain(store, gx, gy, frame, owner = ownerFor(gx, gy)) {
  const x0 = Math.floor(gx); const y0 = Math.floor(gy); const fx = gx - x0; const fy = gy - y0;
  const taps = [[x0, y0, (1 - fx) * (1 - fy)], [x0 + 1, y0, fx * (1 - fy)], [x0, y0 + 1, (1 - fx) * fy], [x0 + 1, y0 + 1, fx * fy]];
  let value = 0; let total = 0; const diagnostics = [];
  for (const [x, y, weight] of taps) {
    const tap = frameValue(store, x, y, frame, owner);
    const valid = tap.available && tap.code !== 0;
    if (valid) { value += weight * rainCodeToMmh(tap.code, store.manifest.encoding.physical_max_mmh); total += weight; }
    diagnostics.push({ x, y, code: tap.available ? tap.code : null, valid, weight, normalizedWeight: null });
  }
  for (const tap of diagnostics) tap.normalizedWeight = total > 0 && tap.valid ? tap.weight / total : 0;
  return { available: total > 0, value: total > 0 ? value / total : 0, taps: diagnostics, reason: total > 0 ? null : 'no-valid-rain-taps' };
}

function motionNode(store, nodeX, nodeY, interval, owner) {
  const tileKey = owner.tileKey;
  const state = store.motionTilesState?.get(tileKey);
  if (state?.status !== 'ready' || !state.payload) return { x: nodeX, y: nodeY, dx: null, dy: null, confidence: null, reason: 'motion-tile-not-resident' };
  const descriptor = state.descriptor; const localNodeX = Math.round(nodeX / 64) - descriptor.node_x_start;
  const localNodeY = Math.round(nodeY / 64) - descriptor.node_y_start;
  if (localNodeX < 0 || localNodeX >= descriptor.node_width || localNodeY < 0 || localNodeY >= descriptor.node_height) return { x: nodeX, y: nodeY, dx: null, dy: null, confidence: null, reason: 'motion-node-outside-tile' };
  const values = new Float32Array(state.payload);
  const offset = (interval * 9 + localNodeY * 3 + localNodeX) * 3;
  return { x: nodeX, y: nodeY, dx: finite(values[offset]), dy: finite(values[offset + 1]), confidence: finite(values[offset + 2]) };
}

export function interpolateMotion(store, gx, gy, interval, owner = ownerFor(gx, gy)) {
  const localX = gx - owner.tileX * TILED_RAIN_TILE_SIZE; const localY = gy - owner.tileY * TILED_RAIN_TILE_SIZE;
  const lowerX = clamp(Math.floor(localX / 64), 0, 1); const lowerY = clamp(Math.floor(localY / 64), 0, 1);
  const fx = localX / 64 - lowerX; const fy = localY / 64 - lowerY;
  const nodes = []; let flowX = 0; let flowY = 0; let confidence = 0;
  for (let row = 0; row < 2; row++) for (let column = 0; column < 2; column++) {
    const weight = (column ? fx : 1 - fx) * (row ? fy : 1 - fy);
    const node = motionNode(store, (owner.tileX * 2 + lowerX + column) * 64, (owner.tileY * 2 + lowerY + row) * 64, interval, owner);
    nodes.push({ ...node, weight });
    const c = node.confidence || 0;
    flowX += weight * c * (node.dx || 0); flowY += weight * c * (node.dy || 0); confidence += weight * c;
  }
  return { dx: confidence > 0.000001 ? flowX / confidence : 0, dy: confidence > 0.000001 ? flowY / confidence : 0, confidence, nodes };
}

function directRain(store, gx, gy, frameA, frameB, progress, owner) {
  const a = frameValue(store, gx, gy, frameA, owner); const b = frameValue(store, gx, gy, frameB, owner);
  const validA = a.available && a.code !== 0; const validB = b.available && b.code !== 0;
  const rainA = validA ? rainCodeToMmh(a.code, store.manifest.encoding.physical_max_mmh) : 0;
  const rainB = validB ? rainCodeToMmh(b.code, store.manifest.encoding.physical_max_mmh) : 0;
  return { value: validA && validB ? rainA * (1 - progress) + rainB * progress : validA ? rainA : validB ? rainB : 0, a, b, validA, validB, rainA, rainB };
}

export function evaluateTiledRainSample(store, gx, gy, frame, { debugMode = store.motionWarpDebugMode } = {}) {
  const frameA = frame.frameA ?? frame.frame0; const frameB = frame.frameB ?? frame.frame1; const progress = frame.progress;
  const owner = ownerFor(gx, gy);
  const direct = directRain(store, gx, gy, frameA, frameB, progress, owner);
  const interval = Math.min(frameA, (store.motionManifest?.interval_count || 1) - 1);
  const motion = store.motionWarp ? interpolateMotion(store, gx, gy, interval, owner) : { dx: 0, dy: 0, confidence: 0, nodes: [] };
  const canWarp = store.motionWarp && frameA !== frameB && progress > 0 && progress < 1 && motion.confidence > 0.000001 && (direct.validA || direct.validB);
  const warpedA = canWarp ? bilinearRain(store, gx - motion.dx * progress, gy - motion.dy * progress, frameA, owner) : { available: false, value: 0, taps: [], reason: 'warp-not-evaluated' };
  const warpedB = canWarp ? bilinearRain(store, gx + motion.dx * (1 - progress), gy + motion.dy * (1 - progress), frameB, owner) : { available: false, value: 0, taps: [], reason: 'warp-not-evaluated' };
  const warpedAvailable = warpedA.available || warpedB.available;
  const warped = warpedA.available && warpedB.available ? warpedA.value * (1 - progress) + warpedB.value * progress : warpedA.available ? warpedA.value : warpedB.available ? warpedB.value : 0;
  const fallbackReason = !store.motionWarp ? 'motion-warp-disabled' : frameA === frameB ? 'same-frame-endpoint' : progress === 0 || progress === 1 ? 'exact-endpoint' : motion.confidence <= 0.000001 ? 'zero-motion-confidence' : !warpedAvailable ? 'warp-no-valid-support' : null;
  const usedFallback = Boolean(fallbackReason);
  const final = usedFallback ? direct.value : (debugMode === 'full' ? warped : direct.value * (1 - motion.confidence) + warped * motion.confidence);
  const present = (value) => ({ mmh: value, radiusFraction: rainMmhToRadiusFraction(value), visibility: value > 0, strongRadiusFraction: dotsStrongRainMmhToRadiusFraction(value), strongVisibility: value > DOTS_STRONG_RAIN_ONSET_MMH });
  return { frameA, frameB, progress, interval, owner: { tileX: owner.tileX, tileY: owner.tileY }, endpointRain: { codeA: direct.a.available ? direct.a.code : null, codeB: direct.b.available ? direct.b.code : null, validA: direct.validA, validB: direct.validB, decodedA: direct.rainA, decodedB: direct.rainB, direct: direct.value }, motion, warpA: { coordinate: [gx - motion.dx * progress, gy - motion.dy * progress], ...warpedA }, warpB: { coordinate: [gx + motion.dx * (1 - progress), gy + motion.dy * (1 - progress)], ...warpedB }, warpedTemporal: warpedAvailable ? warped : null, final: present(final), usedDirectFallback: usedFallback, fallbackReason, motionWarpDebug: debugMode || null, presentation: { base: present(final), strong: { radiusFraction: dotsStrongRainMmhToRadiusFraction(final), visibility: final > DOTS_STRONG_RAIN_ONSET_MMH }, baseMaxRadiusFraction: DOTS_BASE_RAIN_MAX_RADIUS_FRACTION } };
}

export function temporalDelta(previous, current) {
  const magnitude = (sample) => Math.hypot(sample.dx, sample.dy);
  const previousMagnitude = magnitude(previous); const currentMagnitude = magnitude(current);
  const previousNonzero = previousMagnitude > 0; const currentNonzero = currentMagnitude > 0;
  const angle = previousNonzero && currentNonzero ? Math.acos(clamp((previous.dx * current.dx + previous.dy * current.dy) / (previousMagnitude * currentMagnitude), -1, 1)) : null;
  return { deltaDx: current.dx - previous.dx, deltaDy: current.dy - previous.dy, deltaMagnitude: currentMagnitude - previousMagnitude, deltaConfidence: current.confidence - previous.confidence, angularChangeRadians: angle, flags: { motionAppeared: !previousNonzero && currentNonzero, motionDisappeared: previousNonzero && !currentNonzero, confidenceDroppedToZero: previous.confidence > 0 && current.confidence === 0, confidenceRecoveredFromZero: previous.confidence === 0 && current.confidence > 0, largeVectorChange: Math.hypot(current.dx - previous.dx, current.dy - previous.dy) >= MOTION_PROBE_LARGE_VECTOR_CHANGE } };
}

export function finiteJson(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(finiteJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, finiteJson(item)]));
  return value;
}

export function sampleIdentityFromMercator(x, y) {
  return { x: clamp(Math.round(x * TILED_RAIN_GRID_SIZE), 0, TILED_RAIN_GRID_SIZE - 1), y: clamp(Math.round(y * TILED_RAIN_GRID_SIZE), 0, TILED_RAIN_GRID_SIZE - 1) };
}

function timestampAt(timestamps, frame) {
  return timestamps?.[frame] ?? null;
}

function stateObject(store, frame, timestamps) {
  return { frameA: frame.frameA ?? frame.frame0, frameB: frame.frameB ?? frame.frame1, progress: frame.progress, timestampA: timestampAt(timestamps, frame.frameA ?? frame.frame0), timestampB: timestampAt(timestamps, frame.frameB ?? frame.frame1) };
}

function motionTrace(store, gx, gy, timestamps) {
  const trace = [];
  for (let interval = 0; interval < (store.motionManifest?.interval_count || 0); interval++) {
    const motion = interpolateMotion(store, gx, gy, interval);
    const item = { interval, frameA: interval, frameB: interval + 1, timestampA: timestampAt(timestamps, interval), timestampB: timestampAt(timestamps, interval + 1), dx: motion.dx, dy: motion.dy, confidence: motion.confidence, magnitude: Math.hypot(motion.dx, motion.dy), directionRadians: Math.atan2(motion.dy, motion.dx), nodes: motion.nodes };
    if (trace.length) Object.assign(item, temporalDelta(trace[trace.length - 1], item));
    trace.push(item);
  }
  return trace;
}

export function buildMotionProbe(store, sample, selectedFrame, currentFrame, { timestamps = [], longitude = null, latitude = null, selectedAtTimestamp = null, selectedAtWeatherTimestamp = null, currentTimestamp = null } = {}) {
  const evaluate = (frame) => evaluateTiledRainSample(store, sample.x, sample.y, frame);
  const current = evaluate(currentFrame);
  const neighborhood = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = sample.x + dx; const y = sample.y + dy;
    if (x < 0 || x >= TILED_RAIN_GRID_SIZE || y < 0 || y >= TILED_RAIN_GRID_SIZE) continue;
    const result = evaluateTiledRainSample(store, x, y, currentFrame);
    neighborhood.push({ globalX: x, globalY: y, finalMmh: result.final.mmh, directMmh: result.endpointRain.direct, warpedMmh: result.warpedTemporal, dx: result.motion.dx, dy: result.motion.dy, confidence: result.motion.confidence, baseRadiusFraction: result.presentation.base.radiusFraction, baseVisible: result.presentation.base.visibility, strongRadiusFraction: result.presentation.strong.radiusFraction, strongVisible: result.presentation.strong.visibility, fallbackReason: result.fallbackReason });
  }
  const sweep = [];
  for (let index = 0; index <= 20; index++) {
    const progress = index / 20;
    const result = evaluate({ frameA: currentFrame.frameA, frameB: currentFrame.frameB, progress });
    sweep.push({ progress, directMmh: result.endpointRain.direct, dx: result.motion.dx, dy: result.motion.dy, confidence: result.motion.confidence, warpedAMmh: result.warpA.available ? result.warpA.value : null, warpedBMmh: result.warpB.available ? result.warpB.value : null, warpedMmh: result.warpedTemporal, finalMmh: result.final.mmh, fallback: result.usedDirectFallback, fallbackReason: result.fallbackReason, baseRadiusFraction: result.presentation.base.radiusFraction, baseVisible: result.presentation.base.visibility, strongRadiusFraction: result.presentation.strong.radiusFraction, strongVisible: result.presentation.strong.visibility });
  }
  return finiteJson({ schema: MOTION_PROBE_SCHEMA, dataset: { sourceGenerationId: store.manifest.source_generation_id, rainManifest: store.dataset?.rainManifestUrl || (store.motionWarp ? null : store.dataset?.manifestUrl) || null, rainManifestSha256: store.dataset?.sourceTiledRainManifestSha256 || null, motionManifest: store.motionManifestUrl || null, motionManifestSha256: store.dataset?.sourceMotionManifestSha256 || null, warpManifest: store.motionWarp ? store.dataset?.manifestUrl || null : null, warpSourceRainManifest: store.motionWarp ? store.manifest.source_tiled_rain_manifest || null : null, warpSourceMotionManifest: store.motionWarp ? store.manifest.source_motion_manifest || null : null, warpSourceRainManifestSha256: store.motionWarp ? store.manifest.source_tiled_rain_manifest_sha256 || null : null, warpSourceMotionManifestSha256: store.motionWarp ? store.manifest.source_motion_manifest_sha256 || null : null }, sample: { globalL13: { x: sample.x, y: sample.y }, owningRainTile: { x: tileFor(sample.x), y: tileFor(sample.y) }, tileLocalCore: { x: localFor(sample.x), y: localFor(sample.y) }, longitude, latitude }, selectedAt: { ...stateObject(store, selectedFrame, timestamps), wallClock: selectedAtTimestamp, weatherTimestamp: selectedAtWeatherTimestamp, evaluation: evaluate(selectedFrame) }, current: { ...stateObject(store, currentFrame, timestamps), weatherTimestamp: currentTimestamp, evaluation: current }, motionTrace: motionTrace(store, sample.x, sample.y, timestamps), temporalSweep: sweep, neighborhood, diagnosticConstants: { motionGridNodeSpacingL13Samples: 64, motionDisplacementBoundL13Samples: 12, largeVectorChangeThresholdSamples: MOTION_PROBE_LARGE_VECTOR_CHANGE, sweepSteps: 21, nodataCode: 0, dryCode: 1, physicalMaxMmh: store.manifest.encoding.physical_max_mmh } });
}
