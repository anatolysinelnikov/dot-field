import assert from 'node:assert/strict';
import { TiledRainLayer } from '../src/engine/tiled-rain.js';

const store = {
  hazardsAvailable: true,
  manifest: { frame_count: 8, temporal_block_size: 4 },
  tiles: new Map(),
  blocks: new Map(),
  diagnostics: () => ({})
};
const layer = new TiledRainLayer(store);
layer.viewportTileKeys = ['10:20'];
layer.requestedFrame = { frame0: 2, frame1: 3, progress: 0.25 };
layer.committedFrame = { frame0: 2, frame1: 3, progress: 0.25 };
const initialFrame = structuredClone(layer.committedFrame);
const initialViewport = [...layer.viewportTileKeys];
const initialBlocks = [...store.blocks.keys()];
let requestStateCalls = 0;
let repaintCalls = 0;
layer.requestState = () => { requestStateCalls++; };
layer.map = { triggerRepaint: () => { repaintCalls++; } };

for (const mode of ['squares', 'dots', 'squares', 'dots', 'squares']) {
  layer.setPresentationMode(mode);
  assert.equal(layer.presentationMode, mode);
  assert.deepEqual(layer.committedFrame, initialFrame);
  assert.deepEqual(layer.requestedFrame, initialFrame);
  assert.deepEqual(layer.viewportTileKeys, initialViewport);
  assert.deepEqual([...store.blocks.keys()], initialBlocks);
}

layer.setHazardsVisible(false);
layer.setHazardsVisible(true);
assert.equal(layer.hazardsVisible, true);
assert.equal(requestStateCalls, 0);
assert.equal(store.blocks.size, 0);
assert.ok(repaintCalls >= 6);

console.log('tiled rain presentation lifecycle verifier: PASS');
