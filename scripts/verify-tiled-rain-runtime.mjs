import assert from 'node:assert/strict';
import {
  aggregateDotsRadiusFractions,
  aggregateDotsTemporalRadius,
  aggregateSquaresInputs,
  adjacentTiledRainLod,
  automaticTiledRainLod,
  selectTiledRainLod,
  sourceFrameForTime,
  TiledRainLayer,
  TiledRainTileStore,
  validateTiledRainLodManifest
} from '../src/engine/tiled-rain.js';
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
          rain: { dtype: 'UInt16', nodata_code: 0, dry_code: 1, positive_code_min: 2, positive_code_max: 65535, positive_quantized_range: 65534, physical_max_mmh: 10 },
          hazards: { dtype: 'UInt8', decode: 'code / 255' }
        }
      };
    })
  };
}

function fakeGl() {
  const uploads = [];
  return {
    uploads,
    TEXTURE_2D_ARRAY: 1, TEXTURE_MIN_FILTER: 2, TEXTURE_MAG_FILTER: 3, NEAREST: 4,
    TEXTURE_WRAP_S: 5, TEXTURE_WRAP_T: 6, CLAMP_TO_EDGE: 7,
    R16UI: 8, RED_INTEGER: 9, UNSIGNED_SHORT: 10, RGBA16F: 11, RGBA: 12, HALF_FLOAT: 13,
    createTexture: () => ({}), bindTexture: () => {}, texParameteri: () => {}, pixelStorei: () => {},
    texImage3D: (...args) => uploads.push(args)
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
assert.deepEqual([11, 12, 13].map((level) => adjacentTiledRainLod(level, 14)), [12, 13, 14]);
assert.equal(adjacentTiledRainLod(14, 11), 13);
assert.throws(() => adjacentTiledRainLod(10, 11));
assert.deepEqual(sourceFrameForTime(19, 0.5), { frame0: 9, frame1: 9, progress: 0 });
assert.deepEqual(sourceFrameForTime(19, 0.525), { frame0: 9, frame1: 10, progress: 0.45000000000000107 });

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
const lifecycleLayer = new TiledRainLayer(lifecycleStore);
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
assert.deepEqual(lifecycleLayer.pendingLod, { fromLevel: 11, toLevel: 12, generation: lifecycleLayer.pendingLod.generation });
await Promise.resolve();
await Promise.resolve();
await new Promise((resolve) => setTimeout(resolve, 0));
await Promise.resolve();
assert.deepEqual(lifecycleLayer.lodTransition && [lifecycleLayer.lodTransition.fromLevel, lifecycleLayer.lodTransition.toLevel], [11, 12]);
assert.ok([...lifecycleStore.blocks.keys()].some((key) => key.startsWith('11:')));
assert.ok([...lifecycleStore.blocks.keys()].some((key) => key.startsWith('12:')));
lifecycleLayer.setDesiredLod(11);
assert.deepEqual([lifecycleLayer.lodTransition.fromLevel, lifecycleLayer.lodTransition.toLevel], [12, 11]);
lifecycleLayer.updateLodTransition(lifecycleLayer.lodTransition.start + 1000);
await Promise.resolve();
await Promise.resolve();
assert.equal(lifecycleLayer.stableLevel, 11);
lifecycleLayer.setDesiredLod(14);
assert.equal(lifecycleLayer.pendingLod?.toLevel, 12);
lifecycleStore.setProtectedBlockKeys(new Set(Array.from({ length: 1000 }, (_, index) => `14:0:0:${index}`)));
assert.equal(lifecycleStore.diagnosticsState.effectiveReadyBlockLimit, 1000);
lifecycleStore.setProtectedBlockKeys(new Set());
assert.equal(lifecycleStore.diagnosticsState.effectiveReadyBlockLimit, 320);

const sharedStore = { hazardsAvailable: true, aggregateSummary: true, gridSize: 2 ** 11, lodLevel: 11, manifest: { frame_count: 2, temporal_block_size: 1 }, tiles: new Map(), blocks: new Map() };
const sharedLayer = new TiledRainLayer(sharedStore);
const residencyBefore = sharedStore.blocks;
sharedLayer.setPresentationMode('squares');
sharedLayer.setPresentationMode('dots');
assert.equal(sharedLayer.store.blocks, residencyBefore);
assert.equal(sharedStore.blocks.size, 0);

console.log('tiled rain multi-LOD runtime verifier: PASS');
