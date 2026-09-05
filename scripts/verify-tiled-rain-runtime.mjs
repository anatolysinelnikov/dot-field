import assert from 'node:assert/strict';
import {
  aggregateDotsRadiusFractions,
  aggregateDotsTemporalRadius,
  aggregateSquaresInputs,
  adjacentTiledRainLod,
  automaticTiledRainLod,
  automaticTiledRainLodWithHysteresis,
  initialTiledRainLod,
  selectTiledRainLod,
  tiledRainCoarseLocalForFineSample,
  tiledRainCoarseTileForFineTile,
  tiledRainDotsMorphRadius,
  sourceFrameForTime,
  tiledRainProgramCacheKey,
  TiledRainLayer,
  TiledRainTileStore,
  validateTiledRainLodManifest
} from '../src/engine/tiled-rain.js';
import { mercatorGridLevelBoundary } from '../src/engine/geographic-lod.js';
import { dotsStrongRainMmhToRadiusFraction, rainMmhToRadiusFraction } from '../src/engine/precipitation-mapping.js';
import { geographicHazardRadiusForSeverity } from '../src/engine/hazard-renderer.js';

const TILE_SIZE = 128;
const FRAME_COUNT = 2;
const descriptor = (dtype, components, frameCount, asset) => ({
  asset, gzip_asset: `${asset}.gz`, dtype, component_count: components,
  sample_count: TILE_SIZE ** 2, frame_count: frameCount,
  byte_length: TILE_SIZE ** 2 * frameCount * components * (dtype === 'UInt8' ? 1 : 2),
  gzip_byte_length: 1,
  layout: 'frame-major; each frame is row-major y then x; components interleaved within each sample'
});

function block(level, index) {
  const frameCount = Math.min(1, FRAME_COUNT - index);
  if (level < 13) return {
    index, frame_start: index, frame_count: frameCount,
    summary_a: descriptor('Float16', 4, frameCount, `L${level}-a-${index}.f16`),
    summary_b: index === 0 ? descriptor('Float16', 4, frameCount, `L${level}-b-${index}.f16`) : null
  };
  return {
    index, frame_start: index, frame_count: frameCount,
    rain: descriptor('UInt16', 1, frameCount, `L${level}-rain-${index}.u16`),
    storm: index === 0 ? descriptor('UInt8', 1, frameCount, `L${level}-storm-${index}.u8`) : null,
    hail: null
  };
}

function fixtureManifest() {
  return {
    schema: 'dot-field-tiled-rain-lod-v1', version: 1, reference_level: 13,
    level_range: { min: 11, max: 14 }, source_generation_id: 'fixture',
    source_metadata_asset: 'metadata.json', frame_count: FRAME_COUNT,
    timestamps: ['a', 'b'], temporal_block_size: 1, tile_size: TILE_SIZE,
    physical_units: 'mm/h', byte_order: 'little-endian',
    levels: [11, 12, 13, 14].map((level) => {
      const kind = level < 13 ? 'aggregate-summary' : 'direct';
      const blocks = [block(level, 0), block(level, 1)];
      return {
        level, kind, tile_size: TILE_SIZE,
        grid: {
          grid_size: 2 ** level, width: TILE_SIZE, height: TILE_SIZE, count: TILE_SIZE ** 2,
          generated_sample_bounds: { min_i: 0, max_i: 127, min_j: 0, max_j: 127 },
          support_sample_bounds: { min_i: 0, max_i: 127, min_j: 0, max_j: 127 }
        },
        tile_index_bounds: { min_x: 0, max_x: 0, min_y: 0, max_y: 0 },
        tiles: [{ x: 0, y: 0, blocks }], tile_count: 1,
        encoding: kind === 'aggregate-summary' ? {
          plane_a: { dtype: 'Float16', components: ['rainWetMeanMmh', 'rainMaxMmh', 'rainCoverage', 'strongCoverage'], nodata_sentinel: { component: 'rainCoverage', value: -1 } },
          plane_b: { dtype: 'Float16', components: ['stormCoverage', 'stormMaxSeverity', 'hailCoverage', 'hailMaxSeverity'], optional: true, absent_meaning: 'all hazard summary values are zero' }
        } : {
          rain: { dtype: 'UInt16', nodata_code: 0, dry_code: 1, positive_code_min: 2, positive_code_max: 65535, positive_quantized_range: 65534, physical_max_mmh: level },
          hazards: { dtype: 'UInt8', decode: 'code / 255' }
        }
      };
    })
  };
}

function fakeGl() {
  const uploads = [];
  const draws = [];
  const uniform1fCalls = [];
  return {
    uploads, draws, uniform1fCalls,
    TEXTURE_2D_ARRAY: 1, TEXTURE_MIN_FILTER: 2, TEXTURE_MAG_FILTER: 3, NEAREST: 4,
    TEXTURE_WRAP_S: 5, TEXTURE_WRAP_T: 6, CLAMP_TO_EDGE: 7,
    R16UI: 8, RED_INTEGER: 9, UNSIGNED_SHORT: 10, RGBA16F: 11, RGBA: 12, HALF_FLOAT: 13,
    TEXTURE0: 14, ARRAY_BUFFER: 15, FLOAT: 16, TRIANGLES: 17, BLEND: 18, DEPTH_TEST: 19,
    SRC_ALPHA: 20, ONE_MINUS_SRC_ALPHA: 21, POLYGON_OFFSET_FILL: 22,
    createTexture: () => ({}), bindTexture: () => {}, texParameteri: () => {}, pixelStorei: () => {},
    texImage3D: (...args) => uploads.push(args), useProgram: () => {}, uniform2f: () => {},
    uniform1f: (...args) => uniform1fCalls.push(args), uniform1i: () => {}, uniform2i: () => {}, uniform4fv: () => {}, activeTexture: () => {}, bindBuffer: () => {},
    enableVertexAttribArray: () => {}, vertexAttribPointer: () => {},
    drawArraysInstanced: (...args) => draws.push(args), enable: () => {}, disable: () => {}, blendFunc: () => {},
    depthMask: () => {}, polygonOffset: () => {}
  };
}

const manifest = fixtureManifest();
const validated = validateTiledRainLodManifest(manifest);
assert.deepEqual(validated.levels.map((level) => level.level), [11, 12, 13, 14]);
assert.equal(validated.levels[0].kind, 'aggregate-summary');
assert.equal(validated.levels[2].kind, 'direct');
assert.throws(() => validateTiledRainLodManifest({ ...manifest, levels: manifest.levels.map((level) => level.level === 11 ? { ...level, kind: 'direct' } : level) }));
assert.throws(() => validateTiledRainLodManifest({ ...manifest, levels: manifest.levels.map((level) => level.level === 12 ? { ...level, encoding: { ...level.encoding, plane_a: { ...level.encoding.plane_a, components: ['bad'] } } } : level) }));
assert.deepEqual([11, 12, 13, 14].map((value) => selectTiledRainLod(String(value))), [11, 12, 13, 14]);
assert.equal(selectTiledRainLod(undefined), 13);
assert.throws(() => selectTiledRainLod('10'));
assert.throws(() => selectTiledRainLod('13.5'));
assert.deepEqual([0, 5, 10, 20].map((zoom) => automaticTiledRainLod(zoom)), [11, 11, 14, 14]);
for (const level of [11, 12, 13]) {
  const boundary = mercatorGridLevelBoundary(level);
  assert.equal(automaticTiledRainLodWithHysteresis(boundary, level), level, `L${level} holds at its normal boundary`);
  assert.equal(automaticTiledRainLodWithHysteresis(boundary + 0.079, level), level, `L${level} holds inside refinement dead band`);
  assert.equal(automaticTiledRainLodWithHysteresis(boundary + 0.08, level), level + 1, `L${level} refines at +0.08`);
  assert.equal(automaticTiledRainLodWithHysteresis(boundary - 0.079, level + 1), level + 1, `L${level + 1} holds inside coarsening dead band`);
  assert.equal(automaticTiledRainLodWithHysteresis(boundary - 0.08, level + 1), level, `L${level + 1} coarsens at -0.08`);
}
let hysteresisLevel = 12;
const middleBoundary = mercatorGridLevelBoundary(12);
for (const delta of [-0.04, 0.04, -0.06, 0.06, -0.07, 0.07]) hysteresisLevel = automaticTiledRainLodWithHysteresis(middleBoundary + delta, hysteresisLevel);
assert.equal(hysteresisLevel, 12, 'tiny alternating zoom changes do not ping-pong');
assert.equal(automaticTiledRainLodWithHysteresis(100, 11), 14, 'rapid refinement chains to the clamped maximum');
assert.equal(automaticTiledRainLodWithHysteresis(-100, 14), 11, 'rapid coarsening chains to the clamped minimum');
assert.equal(initialTiledRainLod(5.8), 12);
assert.equal(initialTiledRainLod(5.8, 11), 11);
assert.equal(initialTiledRainLod(5.8, 14), 14);
assert.equal(initialTiledRainLod(5.8, 14, true), 13);
assert.deepEqual([11, 12, 13].map((level) => adjacentTiledRainLod(level, 14)), [12, 13, 14]);
assert.equal(adjacentTiledRainLod(14, 11), 13);
assert.throws(() => adjacentTiledRainLod(10, 11));
assert.deepEqual(sourceFrameForTime(19, 0.5), { frame0: 9, frame1: 9, progress: 0 });
assert.deepEqual(sourceFrameForTime(19, 0.525), { frame0: 9, frame1: 10, progress: 0.45000000000000107 });

for (const tileX of [0, 1]) for (const tileY of [0, 1]) {
  assert.deepEqual(tiledRainCoarseTileForFineTile(tileX, tileY), { x: 0, y: 0 }, `fine parity ${tileX},${tileY} maps to its deterministic coarse tile`);
  const shared = tiledRainCoarseLocalForFineSample(tileX, tileY, 126, 0);
  assert.deepEqual(shared, { shared: true, x: (tileX & 1) * 64 + 63, y: (tileY & 1) * 64 }, `fine tile parity ${tileX},${tileY} maps shared edge texels exactly`);
  assert.equal(tiledRainCoarseLocalForFineSample(tileX, tileY, 127, 126).shared, false, `fine tile parity ${tileX},${tileY} classifies odd fine samples as fine-only`);
}
assert.equal(tiledRainDotsMorphRadius(2, 4, 0), 2, 'morph p=0 is exact coarse endpoint');
assert.equal(tiledRainDotsMorphRadius(2, 4, 1), 4, 'morph p=1 is exact fine endpoint');
assert.equal(tiledRainDotsMorphRadius(2, 4, 0.5), Math.sqrt(10), 'morph midpoint preserves area');
assert.equal(tiledRainDotsMorphRadius(0, 4, 0.5), Math.sqrt(8), 'fine-only samples grow from zero');
assert.equal(tiledRainDotsMorphRadius(4, 0, 0.5), Math.sqrt(8), 'fine-only samples shrink to zero');
assert.equal(tiledRainDotsMorphRadius(2, 4, 0.37), tiledRainDotsMorphRadius(4, 2, 0.63), 'reversal radius is complementary');

for (const level of validated.levels) {
  const dataset = { manifest: validated, level, manifestUrl: '/lod/manifest.json', tiles: new Map([['0:0', level.tiles[0]]]), isMultiLod: true };
  const store = new TiledRainTileStore(dataset);
  assert.equal(store.lodLevel, level.level);
  assert.equal(store.gridSize, 2 ** level.level);
  const layer = new TiledRainLayer(store);
  const center = { minX: 64 / store.gridSize, maxX: 64 / store.gridSize, minY: 64 / store.gridSize, maxY: 64 / store.gridSize };
  assert.deepEqual(layer.tileKeysForBounds(center), ['0:0']);
  const payloadName = level.kind === 'aggregate-summary' ? 'summary_a' : 'rain';
  const sourceBlock = level.tiles[0].blocks[0];
  const state = {
    descriptor: sourceBlock, status: 'ready', payload: new ArrayBuffer(sourceBlock[payloadName].byte_length),
    aggregateSummary: level.kind === 'aggregate-summary',
    hazardsAvailable: level.hasHazardPayload === true,
    payloads: { primary: null, secondary: null }, hazardPayloads: { storm: null, hail: null },
    gpuTexture: null, summaryTexture: null, hazardTextures: {}
  };
  state.payloads.primary = state.payload;
  if (level.kind === 'aggregate-summary') {
    state.payloads.secondary = new ArrayBuffer(sourceBlock.summary_b.byte_length);
    const gl = fakeGl();
    store.uploadBlock(gl, state);
    store.uploadSummaryBlock(gl, state);
    assert.equal(gl.uploads[0][2], 11);
    assert.equal(gl.uploads[0][7], 12);
    assert.equal(gl.uploads[0][8], 13);
    assert.equal(gl.uploads[1][2], 11);
  } else {
    const gl = fakeGl();
    store.uploadBlock(gl, state);
    assert.equal(gl.uploads[0][2], 8);
    assert.equal(gl.uploads[0][7], 9);
    assert.equal(gl.uploads[0][8], 10);
  }
}

// Rendering must resolve level-qualified ready states into the upload/draw path.
// This specifically guards the fixed direct-level paths that previously produced
// ready CPU blocks but NaN render block indexes, preventing every upload.
for (const level of [validated.levels[1], validated.levels[2], validated.levels[3]]) {
  const dataset = { manifest: validated, level, manifestUrl: '/lod/manifest.json', tiles: new Map([['0:0', level.tiles[0]]]), isMultiLod: true };
  const store = new TiledRainTileStore(dataset);
  const layer = new TiledRainLayer(store);
  const sourceBlock = level.tiles[0].blocks[0];
  const aggregateSummary = level.kind === 'aggregate-summary';
  const state = {
    key: `${level.level}:0:0:0`, level: level.level, tileKey: '0:0', blockIndex: 0, descriptor: sourceBlock,
    status: 'ready', aggregateSummary, hazardsAvailable: false,
    payload: new ArrayBuffer((aggregateSummary ? sourceBlock.summary_a : sourceBlock.rain).byte_length),
    payloads: { primary: null, secondary: null }, hazardPayloads: {}, hazardTextures: {}, gpuTexture: null, summaryTexture: null
  };
  state.payloads.primary = state.payload;
  if (aggregateSummary) state.payloads.secondary = new ArrayBuffer(sourceBlock.summary_b.byte_length);
  store.blocks.set(state.key, state);
  layer.hazardsAvailable = false;
  layer.viewportBounds = { minX: 64 / store.gridSize, maxX: 64 / store.gridSize, minY: 64 / store.gridSize, maxY: 64 / store.gridSize };
  layer.viewportTileKeys = ['0:0'];
  layer.committedFrame = { frame0: 0, frame1: 0, progress: 0 };
  layer.programsFor = () => ({ program: {}, locations: { physicalMaxMmh: 'physicalMaxMmh' } });
  layer.vertexBuffer = {}; layer.squareVertexBuffer = {}; layer.hazardVertexBuffers = { storm: {}, hail: {} };
  const gl = fakeGl();
  layer.render(gl, { shaderData: { variantName: 'fixture', vertexShaderPrelude: '' }, defaultProjectionData: {} });
  assert.ok(gl.uploads.length >= (aggregateSummary ? 2 : 1), `fixed L${level.level} ready blocks reach GPU texture upload`);
  assert.ok(gl.draws.length > 0, `fixed L${level.level} ready blocks reach a draw call`);
  assert.ok(store.diagnosticsState.tileUploadCount > 0, `fixed L${level.level} increments GPU upload diagnostics`);
  if (!aggregateSummary) {
    const physicalMaxCalls = gl.uniform1fCalls.filter(([location]) => location === 'physicalMaxMmh');
    assert.ok(physicalMaxCalls.length > 0, `fixed L${level.level} supplies a direct rain physical maximum`);
    assert.ok(physicalMaxCalls.every(([, value]) => value === level.encoding.rain.physical_max_mmh), `fixed L${level.level} uses its direct rain physical maximum`);
    assert.ok(physicalMaxCalls.every(([, value]) => Number.isFinite(value)), `fixed L${level.level} supplies a finite direct rain physical maximum`);
  }
}

const legacyStore = new TiledRainTileStore({
  manifest: { frame_count: 1, temporal_block_size: 1, encoding: { physical_max_mmh: 37 }, tiles: [] },
  tiles: new Map()
});
assert.equal(legacyStore.physicalMaxMmh, 37, 'legacy flat rain encoding remains normalized at the store boundary');

const aggregateL11CacheKey = tiledRainProgramCacheKey({ aggregateSummary: true, lodLevel: 11, gridSize: 2 ** 11, variantName: 'dots', hazardsAvailable: true });
const aggregateL12CacheKey = tiledRainProgramCacheKey({ aggregateSummary: true, lodLevel: 12, gridSize: 2 ** 12, variantName: 'dots', hazardsAvailable: true });
const directL13CacheKey = tiledRainProgramCacheKey({ lodLevel: 13, gridSize: 2 ** 13, variantName: 'dots', hazardsAvailable: true });
const directL14CacheKey = tiledRainProgramCacheKey({ lodLevel: 14, gridSize: 2 ** 14, variantName: 'dots', hazardsAvailable: true });
assert.notEqual(aggregateL11CacheKey, aggregateL12CacheKey, 'adjacent aggregate levels must have distinct compile-time grid identities');
assert.notEqual(directL13CacheKey, directL14CacheKey, 'adjacent direct levels must have distinct compile-time grid identities');
assert.notEqual(aggregateL12CacheKey, directL13CacheKey, 'aggregate and direct payload kinds must have distinct program identities');

const first = { rainWetMeanMmh: 4, rainMaxMmh: 12, rainCoverage: 0.25, strongCoverage: 0.5, stormCoverage: 0.36, stormMaxSeverity: 0.8, hailCoverage: 0.16, hailMaxSeverity: 0.7 };
const second = { ...first, rainWetMeanMmh: 8, rainMaxMmh: 20, rainCoverage: 1, strongCoverage: 0.25, stormMaxSeverity: 0.4 };
const radii = aggregateDotsRadiusFractions(first);
assert.equal(radii.rain, Math.sqrt(first.rainCoverage) * rainMmhToRadiusFraction(first.rainWetMeanMmh));
assert.equal(radii.strong, Math.sqrt(first.strongCoverage) * dotsStrongRainMmhToRadiusFraction(first.rainMaxMmh));
assert.equal(radii.storm, Math.sqrt(first.stormCoverage) * geographicHazardRadiusForSeverity('storm', first.stormMaxSeverity, 1));
assert.equal(aggregateDotsTemporalRadius(first, second, 0.5, 'rain'), Math.sqrt((radii.rain ** 2 + aggregateDotsRadiusFractions(second).rain ** 2) / 2));
const squares = aggregateSquaresInputs(first, second, 0.25);
assert.equal(squares.rainWetMeanMmh, 5);
assert.equal(squares.rainCoverage, 0.4375);
assert.ok(Math.abs(squares.stormMaxSeverity - 0.7) < 1e-12);
assert.equal(squares.stormCoverage, 0.36);
assert.equal(squares.hailCoverage, 0.16);
assert.equal(squares.hailMaxSeverity, 0.7);
assert.deepEqual(aggregateDotsRadiusFractions({ ...first, rainCoverage: -1 }), { rain: 0, strong: 0, storm: 0, hail: 0 });
assert.deepEqual(aggregateSquaresInputs({ ...first, rainCoverage: -1 }, second, 0), {
  rainWetMeanMmh: 8, rainCoverage: 1, stormCoverage: 0.36, stormMaxSeverity: 0.4, hailCoverage: 0.16, hailMaxSeverity: 0.7
});

const lifecycleDataset = {
  manifest: validated,
  level: validated.levels[0],
  manifestUrl: '/lod/manifest.json',
  tiles: new Map([['0:0', validated.levels[0].tiles[0]]]),
  isMultiLod: true
};
const lifecycleStore = new TiledRainTileStore(lifecycleDataset);
const lifecycleEvents = [];
const lifecycleLayer = new TiledRainLayer(lifecycleStore, {
  onDiagnosticEvent: (type, details) => lifecycleEvents.push({ type, details })
});
const readyStates = new Map();
lifecycleStore.ensureBlock = (level, tileKey, blockIndex) => {
  const key = `${level}:${tileKey}:${blockIndex}`;
  let state = readyStates.get(key);
  if (!state) {
    const descriptor = lifecycleStore.descriptor(level, tileKey, blockIndex);
    state = { key, level, tileKey, blockIndex, descriptor, status: 'ready', aggregateSummary: level < 13, hazardsAvailable: false,
      payload: new ArrayBuffer(0), payloads: { primary: null, secondary: null }, hazardPayloads: {}, hazardTextures: {} };
    readyStates.set(key, state);
    lifecycleStore.blocks.set(key, state);
  }
  return Promise.resolve(state);
};
const lifecycleBounds = { minX: 64 / 2 ** 11, maxX: 64 / 2 ** 11, minY: 64 / 2 ** 11, maxY: 64 / 2 ** 11 };
lifecycleLayer.setViewportBounds(lifecycleBounds);
assert.deepEqual(lifecycleLayer.viewportTileKeys, ['0:0']);
lifecycleLayer.setDesiredLod(14);
assert.equal(lifecycleEvents[0].type, 'tiled-lod-desired-change');
assert.equal(lifecycleEvents[1].type, 'tiled-lod-preload-start');
assert.deepEqual(
  { fromLevel: lifecycleLayer.pendingLod.fromLevel, toLevel: lifecycleLayer.pendingLod.toLevel },
  { fromLevel: 11, toLevel: 12 }
);
assert.ok(Number.isFinite(lifecycleLayer.pendingLod.startedAt));
await Promise.resolve();
await Promise.resolve();
await new Promise((resolve) => setTimeout(resolve, 0));
await Promise.resolve();
assert.deepEqual(lifecycleLayer.lodTransition && [lifecycleLayer.lodTransition.fromLevel, lifecycleLayer.lodTransition.toLevel], [11, 12]);
assert.deepEqual(lifecycleEvents.slice(-2).map(({ type }) => type), ['tiled-lod-preload-ready', 'tiled-lod-transition-start']);
assert.ok(lifecycleEvents.at(-1).details.endpointLevels.some(({ level, endpointRole }) => level === 11 && endpointRole === 'transition-from'));
assert.ok(lifecycleEvents.at(-1).details.endpointLevels.some(({ level, endpointRole }) => level === 12 && endpointRole === 'transition-to'));
assert.ok([...lifecycleStore.blocks.keys()].some((key) => key.startsWith('11:')));
assert.ok([...lifecycleStore.blocks.keys()].some((key) => key.startsWith('12:')));
lifecycleLayer.setDesiredLod(11);
assert.deepEqual([lifecycleLayer.lodTransition.fromLevel, lifecycleLayer.lodTransition.toLevel], [12, 11]);
assert.equal(lifecycleEvents.at(-1).type, 'tiled-lod-transition-reversal');
lifecycleLayer.updateLodTransition(lifecycleLayer.lodTransition.start + 1000);
await Promise.resolve();
await Promise.resolve();
assert.equal(lifecycleLayer.stableLevel, 11);
assert.equal(lifecycleEvents.at(-1).type, 'tiled-lod-transition-complete');
lifecycleLayer.setDesiredLod(14);
assert.equal(lifecycleLayer.pendingLod?.toLevel, 12);
lifecycleStore.setProtectedBlockKeys(new Set(Array.from({ length: 1000 }, (_, index) => `14:0:0:${index}`)));
assert.equal(lifecycleStore.diagnosticsState.effectiveReadyBlockLimit, 1000);
lifecycleStore.setProtectedBlockKeys(new Set());
assert.equal(lifecycleStore.diagnosticsState.effectiveReadyBlockLimit, 320);

const expectedMaxCombinedBytes = Math.max(...validated.levels.flatMap((level) => level.tiles.flatMap((tile) => tile.blocks.map((entry) => {
  const primary = level.kind === 'aggregate-summary' ? entry.summary_a : entry.rain;
  const hazard = level.kind === 'aggregate-summary'
    ? entry.summary_b
    : [entry.storm, entry.hail].filter(Boolean).reduce((total, descriptor) => total + descriptor.byte_length, 0);
  return primary.byte_length + (typeof hazard === 'number' ? hazard : hazard?.byte_length || 0);
}))));
assert.equal(lifecycleStore.diagnosticsState.maxCombinedBlockBytes, expectedMaxCombinedBytes);
assert.ok(lifecycleStore.diagnosticsState.readyCacheByteTarget >= 320 * expectedMaxCombinedBytes);
const levelStats = new Map(lifecycleStore.levelDiagnostics().map((entry) => [entry.level, entry]));
assert.equal(levelStats.get(11).kind, 'aggregate-summary');
assert.equal(levelStats.get(13).kind, 'direct');
assert.ok(levelStats.get(11).readyBlockCount >= 1);
assert.equal(levelStats.get(12).endpointRole, null);

const sharedStore = { hazardsAvailable: true, aggregateSummary: true, gridSize: 2 ** 11, lodLevel: 11, manifest: { frame_count: 2, temporal_block_size: 1 }, tiles: new Map(), blocks: new Map() };
const sharedLayer = new TiledRainLayer(sharedStore);
const residencyBefore = sharedStore.blocks;
sharedLayer.setPresentationMode('squares');
sharedLayer.setPresentationMode('dots');
assert.equal(sharedLayer.store.blocks, residencyBefore);
assert.equal(sharedStore.blocks.size, 0);

// The Dots transition submits only the fine grid.  Its coarse identity and
// endpoint texture blocks are consumed procedurally by the transition program;
// no endpoint instance/pair buffer is built on the CPU.
const transitionStore = new TiledRainTileStore(lifecycleDataset);
const transitionLayer = new TiledRainLayer(transitionStore);
transitionLayer.viewportBounds = lifecycleBounds;
transitionLayer.committedFrame = { frame0: 0, frame1: 0, progress: 0.25 };
for (const level of [11, 12]) {
  const descriptor = transitionStore.descriptor(level, '0:0', 0);
  const state = {
    key: `${level}:0:0:0`, level, tileKey: '0:0', blockIndex: 0, descriptor, status: 'ready', aggregateSummary: true,
    payload: new ArrayBuffer(descriptor.summary_a.byte_length), payloads: { primary: null, secondary: new ArrayBuffer(descriptor.summary_b.byte_length) }, hazardPayloads: {}, hazardTextures: {}
  };
  state.payloads.primary = state.payload;
  transitionStore.blocks.set(state.key, state);
}
transitionLayer.lodTransition = { fromLevel: 11, toLevel: 12, start: performance.now(), rawProgress: 0.5 };
transitionLayer.transitionProgramsFor = () => ({
  program: {},
  locations: new Proxy({}, { get: (_, key) => ['matrix', 'fallbackMatrix', 'projectionMatrix', 'tileMercatorCoords', 'clippingPlane', 'projectionTransition'].includes(key) ? null : String(key) })
});
const transitionGl = fakeGl();
transitionLayer.vertexBuffer = {}; transitionLayer.hazardVertexBuffers = { storm: {}, hail: {} };
transitionLayer.render(transitionGl, { shaderData: { variantName: 'fixture', vertexShaderPrelude: '' }, defaultProjectionData: {} });
assert.equal(transitionGl.draws.length, 4, 'Dots GPU transition keeps rain/strong/storm/hail pass order once on the fine grid, not both endpoint grids');
assert.ok(transitionGl.draws.every((draw) => draw.at(-1) === TILE_SIZE ** 2), 'Dots GPU transition instances are exactly one fine tile');
assert.equal(transitionLayer.presentationMode, 'dots', 'stable presentation selection remains Dots during GPU split/merge');

console.log('tiled rain multi-LOD runtime verifier: PASS');
