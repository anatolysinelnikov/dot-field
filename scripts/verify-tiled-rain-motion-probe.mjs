import assert from 'node:assert/strict';
import {
  buildMotionProbe,
  bilinearRain,
  evaluateTiledRainSample,
  interpolateMotion,
  sampleIdentityFromMercator,
  temporalDelta,
} from '../src/engine/tiled-rain-motion-probe.js';

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
const motionManifest = { interval_count: 2 };
const motionValues = new Float32Array(2 * 9 * 3);
for (let interval = 0; interval < 2; interval++) for (let node = 0; node < 9; node++) {
  motionValues[(interval * 9 + node) * 3] = interval + 1;
  motionValues[(interval * 9 + node) * 3 + 1] = -2;
  motionValues[(interval * 9 + node) * 3 + 2] = 1;
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
  motionTilesState: new Map([['0:0', { status: 'ready', descriptor: { node_x_start: 0, node_y_start: 0, node_width: 3, node_height: 3 }, payload: motionValues.buffer }]])
};

assert.deepEqual(sampleIdentityFromMercator(0.5, 0.5), { x: 4096, y: 4096 });
assert.equal(evaluateTiledRainSample(store, 64, 64, { frameA: 0, frameB: 1, progress: 0 }).endpointRain.codeA, 2);
const interpolated = interpolateMotion(store, 64, 64, 0);
assert.equal(interpolated.dx, 1);
assert.equal(interpolated.dy, -2);
assert.equal(interpolated.confidence, 1);
const rightBoundary = interpolateMotion(store, 100, 64, 0);
const bottomBoundary = interpolateMotion(store, 64, 100, 0);
assert.equal(rightBoundary.confidence, 1);
assert.equal(bottomBoundary.confidence, 1);
const withAdjacentMotion = { ...store, motionTilesState: new Map([...store.motionTilesState, ['1:0', { status: 'ready', descriptor: { node_x_start: 2, node_y_start: 0, node_width: 3, node_height: 3 }, payload: motionValues.buffer }], ['0:1', { status: 'ready', descriptor: { node_x_start: 0, node_y_start: 2, node_width: 3, node_height: 3 }, payload: motionValues.buffer }]]) };
assert.deepEqual(interpolateMotion(withAdjacentMotion, 100, 64, 0), rightBoundary);
assert.deepEqual(interpolateMotion(withAdjacentMotion, 64, 100, 0), bottomBoundary);
const owner = { tileX: 0, tileY: 0, tileKey: '0:0' };
const crossingWarp = bilinearRain(store, 127.75, 64, 0, owner);
assert.equal(crossingWarp.available, true);
assert.equal(crossingWarp.taps.every((tap) => tap.x <= 128), true);
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
