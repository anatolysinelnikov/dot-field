import assert from 'node:assert/strict';
import {
  buildMotionProbe,
  bilinearRain,
  evaluateTiledRainSample,
  interpolateMotion,
  sampleIdentityFromMercator,
  temporalDelta,
} from '../src/engine/tiled-rain-motion-probe.js';
import { deriveMotionGridContract, TiledRainTileStore } from '../src/engine/tiled-rain.js';

const size = 154;
const frameCount = 3;
const makeRain = (offset) => {
  const values = new Uint16Array(size * size * frameCount);
  values.fill(2);
  for (let frame = 0; frame < frameCount; frame++) values[frame * size * size + 77 * size + 77] = offset + frame;
  return values.buffer;
};
const rainManifest = { source_generation_id: 'generation-test', temporal_block_size: 4, encoding: { physical_max_mmh: 100 } };
const tile = { x: 0, y: 0, blocks: [{ index: 0, frame_start: 0, frame_count: 3 }] };
const motionManifest = { interval_count: 2, motion_grid: { node_spacing_l13_samples: 32, node_x_start: 0, node_y_start: 0 } };
const motionGrid = deriveMotionGridContract(motionManifest);
const motionValues = new Float32Array(2 * motionGrid.nodesPerTile ** 2 * 3);
for (let interval = 0; interval < 2; interval++) for (let node = 0; node < motionGrid.nodesPerTile ** 2; node++) {
  motionValues[(interval * motionGrid.nodesPerTile ** 2 + node) * 3] = interval + node + 1;
  motionValues[(interval * motionGrid.nodesPerTile ** 2 + node) * 3 + 1] = -2 - node;
  motionValues[(interval * motionGrid.nodesPerTile ** 2 + node) * 3 + 2] = 0.2 + node * 0.05;
}
const store = {
  motionWarp: true,
  motionWarpDebugMode: null,
  manifest: rainManifest,
  dataset: { rainManifestUrl: '/rain/manifest.json' },
  motionManifest,
  motionManifestUrl: '/motion/manifest.json',
  tiles: new Map([['0:0', tile]]),
  blocks: new Map([['0:0:0', { status: 'ready', descriptor: tile.blocks[0], payload: makeRain(2) }]]),
  motionGrid,
  motionTiles: new Map([['0:0', { node_x_start: 0, node_y_start: 0, node_width: 5, node_height: 5 }]]),
  motionTilesState: new Map([['0:0', { status: 'ready', descriptor: { node_x_start: 0, node_y_start: 0, node_width: 5, node_height: 5 }, payload: motionValues.buffer }]])
};

const uploadCalls = [];
const fakeGl = {
  TEXTURE_2D: 1, TEXTURE_MIN_FILTER: 2, TEXTURE_MAG_FILTER: 3, NEAREST: 4,
  TEXTURE_WRAP_S: 5, TEXTURE_WRAP_T: 6, CLAMP_TO_EDGE: 7, RGBA32F: 8,
  RGBA: 9, FLOAT: 10,
  createTexture: () => ({}), bindTexture: () => {}, texParameteri: () => {},
  pixelStorei: () => {}, texImage2D: (...args) => uploadCalls.push(args)
};
const runtimeStore = new TiledRainTileStore({
  manifest: { source_generation_id: 'generation-test', tiles: [] },
  tiles: new Map(),
  isMotionWarp: true,
  motionManifest,
  motionTiles: new Map([['0:0', { node_x_start: 0, node_y_start: 0, node_width: 5, node_height: 5 }]])
});
const uploadState = { status: 'ready', descriptor: { node_width: 5, node_height: 5 }, payload: motionValues.buffer, gpuTexture: null };
runtimeStore.motionTilesState = new Map([['0:0', uploadState]]);
runtimeStore.uploadMotionTile(fakeGl, uploadState);
assert.deepEqual(uploadCalls[0].slice(3, 5), [5, 10]);
assert.equal(runtimeStore.diagnostics().estimatedMotionGpuBytes, 5 * 10 * 4 * Float32Array.BYTES_PER_ELEMENT);

assert.deepEqual(sampleIdentityFromMercator(0.5, 0.5), { x: 4096, y: 4096 });
assert.equal(evaluateTiledRainSample(store, 64, 64, { frameA: 0, frameB: 1, progress: 0 }).endpointRain.codeA, 2);
const interpolated = interpolateMotion(store, 64, 64, 0);
assert.equal(interpolated.nodes.every((node) => node.dx !== null && node.dy !== null && node.confidence !== null), true);
const firstHalf = interpolateMotion(store, 16, 16, 0);
const secondHalf = interpolateMotion(store, 112, 112, 0);
assert.deepEqual(firstHalf.nodes.map((node) => [node.x, node.y]), [[0, 0], [32, 0], [0, 32], [32, 32]]);
assert.deepEqual(secondHalf.nodes.map((node) => [node.x, node.y]), [[96, 96], [128, 96], [96, 128], [128, 128]]);
const weightedExpected = (indices) => {
  let weightedDx = 0; let weightedDy = 0; let confidence = 0;
  for (const index of indices) { const c = 0.2 + index * 0.05; weightedDx += (index + 1) * c; weightedDy += (-2 - index) * c; confidence += c; }
  return { dx: weightedDx / confidence, dy: weightedDy / confidence, confidence: confidence / indices.length };
};
assert.ok(firstHalf.nodes.every((node, index) => Math.abs(node.confidence - [0.2, 0.25, 0.45, 0.5][index]) < 1e-6));
assert.ok(Math.abs(firstHalf.dx - weightedExpected([0, 1, 5, 6]).dx) < 1e-6);
assert.ok(Math.abs(secondHalf.dx - weightedExpected([18, 19, 23, 24]).dx) < 1e-6);
for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) {
  const subcell = interpolateMotion(store, column * 32 + 16, row * 32 + 16, 0);
  assert.deepEqual(subcell.nodes.map((node) => [node.x, node.y]), [
    [column * 32, row * 32], [column * 32 + 32, row * 32],
    [column * 32, row * 32 + 32], [column * 32 + 32, row * 32 + 32]
  ]);
}
const rightBoundary = interpolateMotion(store, 100, 64, 0);
const bottomBoundary = interpolateMotion(store, 64, 100, 0);
assert.ok(rightBoundary.confidence > 0);
assert.ok(bottomBoundary.confidence > 0);
const withAdjacentMotion = { ...store, motionTiles: new Map([...store.motionTiles, ['1:0', { node_x_start: 4, node_y_start: 0, node_width: 5, node_height: 5 }], ['0:1', { node_x_start: 0, node_y_start: 4, node_width: 5, node_height: 5 }]]), motionTilesState: new Map([...store.motionTilesState, ['1:0', { status: 'ready', descriptor: { node_x_start: 4, node_y_start: 0, node_width: 5, node_height: 5 }, payload: motionValues.buffer }], ['0:1', { status: 'ready', descriptor: { node_x_start: 0, node_y_start: 4, node_width: 5, node_height: 5 }, payload: motionValues.buffer }]]) };
assert.deepEqual(interpolateMotion(withAdjacentMotion, 100, 64, 0), rightBoundary);
assert.deepEqual(interpolateMotion(withAdjacentMotion, 64, 100, 0), bottomBoundary);
const owner = { tileX: 0, tileY: 0, tileKey: '0:0' };
const haloPayload = new Uint16Array(makeRain(2));
for (const row of [77, 78]) {
  haloPayload[row * size + 140] = 2;
  haloPayload[row * size + 141] = 100;
}
const haloStore = { ...store, blocks: new Map([['0:0:0', { status: 'ready', descriptor: tile.blocks[0], payload: haloPayload.buffer }]]) };
const crossingWarp = bilinearRain(haloStore, 127.75, 64, 0, owner);
assert.equal(crossingWarp.available, true);
assert.equal(crossingWarp.taps.every((tap) => tap.x <= 128), true);
assert.deepEqual(crossingWarp.taps.map((tap) => tap.code), [2, 100, 2, 100]);
const expectedCrossing = 0.25 * ((2 - 1) / 65534 * 100) + 0.75 * ((100 - 1) / 65534 * 100);
assert.ok(Math.abs(crossingWarp.value - expectedCrossing) < 1e-12);
assert.equal(bilinearRain(store, -14, 64, 0, owner).available, false);
const adjacentRain = { x: 1, y: 0, blocks: [{ index: 0, frame_start: 0, frame_count: 3 }] };
const boundaryStore = { ...withAdjacentMotion, blocks: new Map([...store.blocks, ['1:0:0', { status: 'ready', descriptor: adjacentRain.blocks[0], payload: makeRain(3) }]]), tiles: new Map([...store.tiles, ['1:0', adjacentRain]]) };
assert.equal(evaluateTiledRainSample(boundaryStore, 127, 64, { frameA: 0, frameB: 1, progress: 0 }).owner.tileX, 0);
assert.equal(evaluateTiledRainSample(boundaryStore, 128, 64, { frameA: 0, frameB: 1, progress: 0 }).owner.tileX, 1);
const endpoint = evaluateTiledRainSample(store, 64, 64, { frameA: 0, frameB: 1, progress: 0 });
assert.equal(endpoint.final.mmh, endpoint.endpointRain.decodedA);
assert.equal(endpoint.usedDirectFallback, true);
const full = evaluateTiledRainSample(store, 64, 64, { frameA: 0, frameB: 1, progress: 0.5 }, { debugMode: 'full' });
assert.equal(full.motionWarpDebug, 'full');
assert.equal(temporalDelta({ dx: 0, dy: 0, confidence: 0 }, { dx: 2, dy: 0, confidence: 1 }).flags.motionAppeared, true);
const probe = buildMotionProbe(store, { x: 64, y: 64 }, { frameA: 0, frameB: 1, progress: 0 }, { frameA: 0, frameB: 1, progress: 0.5 }, { timestamps: ['a', 'b', 'c'], selectedAtTimestamp: 'wall-clock', selectedAtWeatherTimestamp: 'a', currentTimestamp: 'midpoint' });
assert.equal(probe.temporalSweep.length, 21);
assert.equal(probe.temporalSweep[0].progress, 0);
assert.equal(probe.temporalSweep.at(-1).progress, 1);
assert.equal(probe.motionTrace.length, 2);
assert.equal(probe.motionTrace.every((interval) => interval.dx !== null && interval.dy !== null && interval.confidence !== null), true);
assert.equal(probe.neighborhood.length, 9);
assert.equal(probe.selectedAt.wallClock, 'wall-clock');
assert.equal(probe.selectedAt.weatherTimestamp, 'a');
assert.equal(probe.current.weatherTimestamp, 'midpoint');
const boundaryProbe = buildMotionProbe(store, { x: 128, y: 128 }, { frameA: 0, frameB: 1, progress: 0 }, { frameA: 0, frameB: 1, progress: 0.5 }, { timestamps: ['a', 'b', 'c'] });
assert.deepEqual(boundaryProbe.sample.owningRainTile, { x: 1, y: 1 });
assert.deepEqual(boundaryProbe.sample.tileLocalCore, { x: 0, y: 0 });
assert.equal(JSON.stringify(probe).includes('NaN'), false);
assert.equal(JSON.stringify(probe).includes('Infinity'), false);
console.log('tiled rain motion probe verifier: PASS');
