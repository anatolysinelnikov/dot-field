import assert from 'node:assert/strict';
import { TiledRainDotsLayer, TiledRainTileStore } from '../src/engine/tiled-rain.js';

const frameCount = 2;
const rainBytes = 128 * 128 * frameCount * Uint16Array.BYTES_PER_ELEMENT;
const hazardBytes = 128 * 128 * frameCount;
const block = {
  index: 0, frame_start: 0, frame_count: frameCount,
  asset: 'rain.u16', sample_count: 128 * 128, byte_length: rainBytes,
  storm: { asset: 'storm.u8', sample_count: 128 * 128, byte_length: hazardBytes, gzip_byte_length: 1 },
  hail: null
};
const manifest = {
  source_generation_id: 'generation-test',
  manifestUrl: '/tiled/manifest.json',
  tile_index_bounds: { min_x: 0, max_x: 0, min_y: 0, max_y: 0 },
  encoding: { physical_max_mmh: 10 },
  hazardsAvailable: true,
  hazards: { available: true, channels: ['storm', 'hail'] },
  tiles: [{ x: 0, y: 0, blocks: [block] }]
};
const dataset = { manifest, manifestUrl: '/tiled/manifest.json', tiles: new Map([['0:0', manifest.tiles[0]]]) };
const store = new TiledRainTileStore(dataset);
const state = {
  key: '0:0:0', tileKey: '0:0', blockIndex: 0, descriptor: block, kind: 'rain', status: 'ready',
  payload: new ArrayBuffer(rainBytes), hazardPayloads: { storm: new ArrayBuffer(hazardBytes), hail: null },
  gpuTexture: null, hazardTextures: { storm: null, hail: null }
};
store.blocks.set(state.key, state);
store.updateMemoryDiagnostics();
assert.equal(store.diagnostics().logicalUInt16ResidentBytes, rainBytes);
assert.equal(store.diagnostics().logicalHazardResidentBytes, hazardBytes);

const layer = new TiledRainDotsLayer(store);
const beforeBlocks = [...store.blocks.keys()];
const beforeRequests = store.diagnosticsState.tileRequestCount;
layer.setHazardsVisible(false);
assert.equal(layer.hazardsVisible, false);
assert.deepEqual([...store.blocks.keys()], beforeBlocks);
assert.equal(store.diagnosticsState.tileRequestCount, beforeRequests);
layer.setHazardsVisible(true);
assert.equal(layer.hazardsVisible, true);

const uploadCalls = [];
const fakeGl = {
  TEXTURE_2D_ARRAY: 1, TEXTURE_MIN_FILTER: 2, TEXTURE_MAG_FILTER: 3, NEAREST: 4,
  TEXTURE_WRAP_S: 5, TEXTURE_WRAP_T: 6, CLAMP_TO_EDGE: 7, R8: 8, RED: 9, UNSIGNED_BYTE: 10,
  createTexture: () => ({}), bindTexture: () => {}, texParameteri: () => {}, pixelStorei: () => {},
  texImage3D: (...args) => uploadCalls.push(args)
};
store.uploadHazardBlock(fakeGl, state, 'storm');
assert.deepEqual(uploadCalls[0].slice(2, 9), [8, 128, 128, frameCount, 0, 9, 10]);
assert.equal(store.diagnostics().estimatedHazardGpuBytes, hazardBytes);

const motionStore = new TiledRainTileStore({
  ...dataset, isMotionWarp: true,
  motionManifest: {
    source_tiled_rain_manifest_sha256: 'rain', source_generation_id: 'generation-test',
    motion_grid: { node_spacing_l13_samples: 32, node_x_start: 0, node_y_start: 0 }, interval_count: 1
  }, motionTiles: new Map(), motionManifestUrl: '/motion/manifest.json'
});
assert.equal(motionStore.hazardsAvailable, false);
console.log('tiled rain phenomena runtime verifier: PASS');
