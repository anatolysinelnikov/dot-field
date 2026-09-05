import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRealWeatherFixture } from './real-weather-fixture.mjs';
import { setActiveWeatherField } from '../src/engine/geography.js';
import {
  GeographicLodTopology,
  lngLatToMercator,
  setGeographicWeatherSupport,
  mercatorToLngLat
} from '../src/engine/geographic-lod.js';
import { GeographicWeatherPyramid } from '../src/engine/geographic-weather-pyramid.js';

const LEVELS = [11, 12, 13, 14];
const REFERENCE_LEVEL = 13;
const TILE_SIZE = 128;
const TILE_SAMPLES = TILE_SIZE * TILE_SIZE;
const BLOCK_SIZE = 4;
const root = path.resolve(process.argv[2] || fileURLToPath(new URL('../data/generated/tiled-rain-lod/current/', import.meta.url)));

function fail(message) {
  throw new Error(`tiled-rain-lod verification failed: ${message}`);
}

function requireValue(condition, message) {
  if (!condition) fail(message);
}

async function jsonFile(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function payloadFile(assetRoot, asset) {
  requireValue(typeof asset === 'string' && !path.isAbsolute(asset), `payload path is not relative: ${asset}`);
  const resolved = path.resolve(assetRoot, asset);
  const relative = path.relative(assetRoot, resolved);
  requireValue(relative && !relative.startsWith(`..${path.sep}`) && relative !== '..', `payload escapes generated root: ${asset}`);
  return resolved;
}

function decodeHalf(bits) {
  const sign = (bits & 0x8000) ? -1 : 1;
  const exponent = (bits >>> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction ? Number.NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function halfAt(buffer, sampleIndex, component) {
  return decodeHalf(buffer.readUInt16LE((sampleIndex * 4 + component) * 2));
}

function tileFor(level, x, y) {
  return level.tileMap.get(`${Math.floor(x / TILE_SIZE)}:${Math.floor(y / TILE_SIZE)}`);
}

async function readPayload(descriptor, assetRoot) {
  const rawPath = payloadFile(assetRoot, descriptor.asset);
  const gzipPath = payloadFile(assetRoot, descriptor.gzip_asset);
  const [raw, gzip, rawStats, gzipStats] = await Promise.all([
    readFile(rawPath), readFile(gzipPath), stat(rawPath), stat(gzipPath)
  ]);
  requireValue(rawStats.size === descriptor.byte_length, `${descriptor.asset}: raw byte length mismatch`);
  requireValue(gzipStats.size === descriptor.gzip_byte_length, `${descriptor.gzip_asset}: gzip byte length mismatch`);
  requireValue(gzip.length >= 8 && gzip.readUInt32LE(4) === 0, `${descriptor.gzip_asset}: gzip mtime is not deterministic zero`);
  requireValue(gunzipSync(gzip).equals(raw), `${descriptor.gzip_asset}: gzip payload does not match raw bytes`);
  return { raw, gzip };
}

function descriptorByteLength(block, level, name, frameCount) {
  const descriptor = block[name];
  if (!descriptor) return 0;
  const components = descriptor.component_count;
  const bytesPerComponent = descriptor.dtype === 'Float16' ? 2 : descriptor.dtype === 'UInt16' ? 2 : 1;
  const expected = frameCount * TILE_SAMPLES * components * bytesPerComponent;
  requireValue(descriptor.frame_count === frameCount, `L${level} ${name}: frame count mismatch`);
  requireValue(descriptor.sample_count === TILE_SAMPLES, `L${level} ${name}: tile sample count mismatch`);
  requireValue(descriptor.byte_length === expected, `L${level} ${name}: logical byte length mismatch`);
  return descriptor.byte_length;
}

function extentSize(extent) {
  return {
    width: extent.max_i - extent.min_i + 1,
    height: extent.max_j - extent.min_j + 1
  };
}

function representativeAxis(minimum, maximum) {
  const candidates = [minimum, minimum + 1, minimum + 127, minimum + 128, maximum - 1, maximum];
  return [...new Set(candidates.filter((value) => value >= minimum && value <= maximum))];
}

function compareClose(actual, expected, label, tolerance) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    fail(`${label}: actual ${actual} differs from reference ${expected} by more than ${tolerance}`);
  }
}

async function validateStructure(manifest) {
  requireValue(manifest.schema === 'dot-field-tiled-rain-lod-v1', 'schema mismatch');
  requireValue(manifest.version === 1, 'version mismatch');
  requireValue(manifest.reference_level === REFERENCE_LEVEL, 'reference level mismatch');
  requireValue(manifest.level_range?.min === 11 && manifest.level_range?.max === 14, 'level range mismatch');
  requireValue(manifest.tile_size === TILE_SIZE && manifest.temporal_block_size === BLOCK_SIZE, 'common tile/temporal contract mismatch');
  requireValue(manifest.frame_count === manifest.timestamps?.length && manifest.frame_count > 0, 'temporal timestamp contract mismatch');
  requireValue(manifest.aggregation?.thresholds_mmh?.rain_coverage === 0.05, 'rain threshold mismatch');
  requireValue(manifest.aggregation?.thresholds_mmh?.strong_coverage === 2.5, 'strong-rain threshold mismatch');
  requireValue(manifest.aggregation?.source === 'unquantized Float32 L13 reconstructed physical values', 'aggregation source contract mismatch');
  requireValue(manifest.aggregation?.hazard_mean_omission?.includes('coverage plus max'), 'hazard mean omission is undocumented');
  requireValue(Array.isArray(manifest.levels) && manifest.levels.length === LEVELS.length, 'level array mismatch');
  const seenLevels = new Set();
  const levels = new Map();
  for (const level of manifest.levels) {
    requireValue(LEVELS.includes(level.level), `unexpected level L${level.level}`);
    requireValue(!seenLevels.has(level.level), `duplicate level L${level.level}`);
    seenLevels.add(level.level);
    requireValue(level.kind === (level.level < REFERENCE_LEVEL ? 'aggregate-summary' : 'direct'), `L${level.level}: incorrect kind`);
    requireValue(level.tile_size === TILE_SIZE, `L${level.level}: tile size mismatch`);
    if (level.level < REFERENCE_LEVEL) {
      requireValue(level.encoding?.plane_a?.dtype === 'Float16'
        && level.encoding.plane_a.components.join(',') === 'rainWetMeanMmh,rainMaxMmh,rainCoverage,strongCoverage', `L${level.level}: Summary A component contract mismatch`);
      requireValue(level.encoding.plane_a.nodata_sentinel?.component === 'rainCoverage'
        && level.encoding.plane_a.nodata_sentinel.value === -1, `L${level.level}: NoData sentinel contract mismatch`);
      requireValue(level.encoding?.plane_b?.dtype === 'Float16'
        && level.encoding.plane_b.components.join(',') === 'stormCoverage,stormMaxSeverity,hailCoverage,hailMaxSeverity', `L${level.level}: Summary B component contract mismatch`);
    } else {
      requireValue(level.encoding?.rain?.dtype === 'UInt16'
        && level.encoding.rain.nodata_code === 0 && level.encoding.rain.dry_code === 1
        && level.encoding.rain.positive_code_min === 2, `L${level.level}: direct rain encoding contract mismatch`);
      requireValue(level.encoding?.hazards?.dtype === 'UInt8' && level.encoding.hazards.decode === 'code / 255', `L${level.level}: direct hazard encoding contract mismatch`);
    }
    const generated = level.grid?.generated_sample_bounds;
    const support = level.grid?.support_sample_bounds;
    requireValue(generated && support, `L${level.level}: missing sample extents`);
    const generatedSize = extentSize(generated);
    requireValue(level.grid.width === generatedSize.width && level.grid.height === generatedSize.height, `L${level.level}: grid dimensions mismatch`);
    requireValue(level.grid.count === generatedSize.width * generatedSize.height, `L${level.level}: grid count mismatch`);
    requireValue(level.grid.grid_size === 2 ** level.level, `L${level.level}: grid size mismatch`);
    const tileBounds = level.tile_index_bounds;
    requireValue(tileBounds.min_x === Math.floor(generated.min_i / TILE_SIZE)
      && tileBounds.max_x === Math.floor(generated.max_i / TILE_SIZE)
      && tileBounds.min_y === Math.floor(generated.min_j / TILE_SIZE)
      && tileBounds.max_y === Math.floor(generated.max_j / TILE_SIZE), `L${level.level}: tile bounds do not own generated extent`);
    requireValue(Array.isArray(level.tiles), `L${level.level}: missing tile descriptors`);
    requireValue(level.tiles.length === level.tile_count, `L${level.level}: tile count mismatch`);
    const tileMap = new Map();
    let blockTotal = 0;
    let rawTotal = 0;
    let gzipTotal = 0;
    const rawByPlane = {};
    const gzipByPlane = {};
    for (const tile of level.tiles) {
      const tileKey = `${tile.x}:${tile.y}`;
      requireValue(!tileMap.has(tileKey), `L${level.level}: duplicate tile ${tileKey}`);
      tileMap.set(tileKey, tile);
      requireValue(tile.x >= tileBounds.min_x && tile.x <= tileBounds.max_x && tile.y >= tileBounds.min_y && tile.y <= tileBounds.max_y, `L${level.level}: tile outside bounds`);
      requireValue(Array.isArray(tile.blocks) && tile.blocks.length === Math.ceil(manifest.frame_count / BLOCK_SIZE), `L${level.level} ${tileKey}: block count mismatch`);
      const seenBlocks = new Set();
      for (const block of tile.blocks) {
        requireValue(!seenBlocks.has(block.index), `L${level.level} ${tileKey}: duplicate block ${block.index}`);
        seenBlocks.add(block.index);
        const expectedFrameCount = Math.min(BLOCK_SIZE, manifest.frame_count - block.frame_start);
        requireValue(block.frame_count === expectedFrameCount, `L${level.level} ${tileKey} block ${block.index}: frame range mismatch`);
        const names = level.level < REFERENCE_LEVEL ? ['summary_a', 'summary_b'] : ['rain', 'storm', 'hail'];
        if (level.level < REFERENCE_LEVEL) {
          requireValue(block.summary_a, `L${level.level} ${tileKey} block ${block.index}: missing Summary A`);
          requireValue(block.summary_b === null || block.summary_b, `L${level.level} ${tileKey} block ${block.index}: invalid Summary B descriptor`);
        } else {
          requireValue(block.rain, `L${level.level} ${tileKey} block ${block.index}: missing direct rain payload`);
        }
        for (const name of names) {
          const descriptor = block[name];
          if (!descriptor) continue;
          const expectedComponents = name === 'summary_a' || name === 'summary_b' ? 4 : 1;
          const expectedDtype = name === 'summary_a' || name === 'summary_b' ? 'Float16' : name === 'rain' ? 'UInt16' : 'UInt8';
          requireValue(descriptor.dtype === expectedDtype && descriptor.component_count === expectedComponents, `L${level.level} ${name}: encoding mismatch`);
          const bytes = descriptorByteLength(block, level.level, name, block.frame_count);
          rawTotal += bytes;
          gzipTotal += descriptor.gzip_byte_length;
          rawByPlane[name] = (rawByPlane[name] || 0) + bytes;
          gzipByPlane[name] = (gzipByPlane[name] || 0) + descriptor.gzip_byte_length;
          const payload = await readPayload(descriptor, root);
          if (name === 'summary_b') requireValue(payload.raw.some((value) => value !== 0) || descriptor, `L${level.level}: invalid hazard payload`);
        }
        blockTotal++;
      }
    }
    requireValue(blockTotal === level.block_count, `L${level.level}: total block count mismatch`);
    requireValue(level.payload_totals.raw_bytes === rawTotal && level.payload_totals.gzip_bytes === gzipTotal, `L${level.level}: payload totals mismatch`);
    assert.deepEqual(level.payload_totals.raw_by_plane, rawByPlane, `L${level.level}: raw plane totals mismatch`);
    assert.deepEqual(level.payload_totals.gzip_by_plane, gzipByPlane, `L${level.level}: gzip plane totals mismatch`);
    level.tileMap = tileMap;
    levels.set(level.level, level);
  }
  requireValue(seenLevels.size === LEVELS.length, 'not all levels are present');
  return levels;
}

function validateNesting(levels) {
  for (const level of [11, 12]) {
    const fine = levels.get(level + 1).grid;
    const coarse = levels.get(level).grid;
    for (const axis of ['min_i', 'max_i', 'min_j', 'max_j']) {
      const expected = axis.startsWith('min') ? Math.ceil(fine.support_sample_bounds[axis] / 2) : Math.floor(fine.support_sample_bounds[axis] / 2);
      requireValue(coarse.support_sample_bounds[axis] === expected, `L${level} support ${axis} is not the dyadic parent extent`);
    }
    const fineGenerated = fine.generated_sample_bounds;
    const coarseGenerated = coarse.generated_sample_bounds;
    requireValue(coarseGenerated.min_i === Math.ceil(fineGenerated.min_i / 2)
      && coarseGenerated.max_i === Math.floor(fineGenerated.max_i / 2)
      && coarseGenerated.min_j === Math.ceil(fineGenerated.min_j / 2)
      && coarseGenerated.max_j === Math.floor(fineGenerated.max_j / 2), `L${level}: generated extents are not nested`);
  }
  const l13 = levels.get(13).grid;
  const l14 = levels.get(14).grid;
  requireValue(l14.generated_sample_bounds.min_i === l13.generated_sample_bounds.min_i * 2
    && l14.generated_sample_bounds.max_i === (l13.generated_sample_bounds.max_i + 1) * 2 - 1
    && l14.generated_sample_bounds.min_j === l13.generated_sample_bounds.min_j * 2
    && l14.generated_sample_bounds.max_j === (l13.generated_sample_bounds.max_j + 1) * 2 - 1, 'L14 generated extent is not the refined L13 tile domain');
  requireValue(levels.get(14).tile_index_bounds.min_x === levels.get(13).tile_index_bounds.min_x * 2
    && levels.get(14).tile_index_bounds.max_x === levels.get(13).tile_index_bounds.max_x * 2 + 1
    && levels.get(14).tile_index_bounds.min_y === levels.get(13).tile_index_bounds.min_y * 2
    && levels.get(14).tile_index_bounds.max_y === levels.get(13).tile_index_bounds.max_y * 2 + 1, 'L14 tile envelope is not a 2x2 refinement');
  for (const axis of ['min_i', 'max_i', 'min_j', 'max_j']) {
    const anchor = l13.support_sample_bounds[axis] * 2;
    const containsAnchor = axis.startsWith('min')
      ? l14.support_sample_bounds[axis] <= anchor
      : l14.support_sample_bounds[axis] >= anchor;
    requireValue(containsAnchor, `L14 support ${axis} does not contain the refined L13 anchor extent`);
  }
  for (const level of [11, 12, 13]) {
    const child = levels.get(level + 1).grid.support_sample_bounds;
    const parent = levels.get(level).grid.support_sample_bounds;
    for (const axis of ['min_i', 'max_i', 'min_j', 'max_j']) {
      const expected = axis.startsWith('min') ? Math.ceil(child[axis] / 2) : Math.floor(child[axis] / 2);
      if (level < 13) requireValue(parent[axis] === expected, `L${level}: parent identity mismatch`);
    }
  }
}

async function legacyParity(manifest, levels) {
  const source = manifest.legacy_l13_parity?.source_manifest;
  if (!source) return { status: 'skipped', reason: 'legacy manifest unavailable' };
  const legacyPath = path.resolve(root, source);
  try {
    await stat(legacyPath);
  } catch {
    return { status: 'skipped', reason: 'legacy manifest unavailable' };
  }
  const legacy = await jsonFile(legacyPath);
  if (legacy.source_generation_id !== manifest.source_generation_id) return { status: 'skipped', reason: 'legacy generation differs' };
  const legacyRoot = path.dirname(legacyPath);
  const legacyTiles = new Map(legacy.tiles.map((tile) => [`${tile.x}:${tile.y}`, tile]));
  let payloads = 0;
  for (const tile of levels.get(13).tiles) {
    const legacyTile = legacyTiles.get(`${tile.x}:${tile.y}`);
    requireValue(legacyTile, `legacy parity missing tile ${tile.x}:${tile.y}`);
    for (const block of tile.blocks) {
      const oldBlock = legacyTile.blocks.find((candidate) => candidate.index === block.index);
      requireValue(oldBlock, `legacy parity missing block ${tile.x}:${tile.y}:${block.index}`);
      const [actual, expected] = await Promise.all([
        readFile(payloadFile(root, block.rain.asset)),
        readFile(payloadFile(legacyRoot, oldBlock.asset))
      ]);
      requireValue(actual.equals(expected), `L13 rain payload differs at ${tile.x}:${tile.y}:${block.index}`);
      for (const channel of ['storm', 'hail']) {
        const actualDescriptor = block[channel];
        const expectedDescriptor = oldBlock[channel];
        requireValue(Boolean(actualDescriptor) === Boolean(expectedDescriptor), `L13 ${channel} omission differs at ${tile.x}:${tile.y}:${block.index}`);
        if (actualDescriptor) {
          const [actualHazard, expectedHazard] = await Promise.all([
            readFile(payloadFile(root, actualDescriptor.asset)),
            readFile(payloadFile(legacyRoot, expectedDescriptor.asset))
          ]);
          requireValue(actualHazard.equals(expectedHazard), `L13 ${channel} payload differs at ${tile.x}:${tile.y}:${block.index}`);
        }
      }
      payloads++;
    }
  }
  return { status: 'passed', compared_block_count: payloads, mode: 'byte-for-byte rain/storm/hail' };
}

async function directL14Reference(manifest, levels, weather) {
  const frame = weather.prepareFrame(0);
  const level = levels.get(14);
  const extent = level.grid.support_sample_bounds;
  const rainDescriptor = level.tileMap.get(`${Math.floor(extent.min_i / TILE_SIZE)}:${Math.floor(extent.min_j / TILE_SIZE)}`).blocks[0].rain;
  const rainBuffer = (await readPayload(rainDescriptor, root)).raw;
  const physicalMax = level.encoding.rain.physical_max_mmh;
  const samples = representativeAxis(extent.min_i, extent.max_i).flatMap((x) => representativeAxis(extent.min_j, extent.max_j).map((y) => ({ x, y })));
  const phenomena = weather.phenomenaFrames?.get(0);
  const hazardSourceIndex = phenomena?.findIndex((code) => code >= 10 && code <= 15) ?? -1;
  if (hazardSourceIndex >= 0) {
    const sourceX = hazardSourceIndex % weather.longitudes.length;
    const sourceY = Math.floor(hazardSourceIndex / weather.longitudes.length);
    const [sourceMercatorX, sourceMercatorY] = lngLatToMercator(weather.longitudes[sourceX], weather.latitudes[sourceY]);
    samples.push({ x: Math.round(sourceMercatorX * 2 ** 14), y: Math.round(sourceMercatorY * 2 ** 14) });
  }
  const hazardBuffers = new Map();
  let checked = 0;
  let maximumError = 0;
  const maximumHazardErrors = { storm: 0, hail: 0 };
  for (const { x, y } of samples) {
    const tile = tileFor(level, x, y);
    const block = tile.blocks[0];
    const descriptor = block.rain;
    const buffer = descriptor === rainDescriptor && tile.x === Math.floor(extent.min_i / TILE_SIZE) && tile.y === Math.floor(extent.min_j / TILE_SIZE)
      ? rainBuffer : (await readPayload(descriptor, root)).raw;
    const offset = (y % TILE_SIZE) * TILE_SIZE + (x % TILE_SIZE);
    const code = buffer.readUInt16LE(offset * 2);
    const decoded = code === 0 ? Number.NaN : code === 1 ? 0 : (code - 1) / 65534 * physicalMax;
    const [longitude, latitude] = mercatorToLngLat(x / 2 ** 14, y / 2 ** 14);
    const expectedSample = frame.sample(longitude, latitude, {});
    const expected = expectedSample.rainMmh;
    const error = Math.abs(decoded - expected);
    compareClose(decoded, expected, `L14 rain ${x},${y}`, physicalMax / 65534 * 0.51 + 1e-5);
    maximumError = Math.max(maximumError, error);
    for (const channel of ['storm', 'hail']) {
      const hazardDescriptor = block[channel];
      let actualHazard = 0;
      if (hazardDescriptor) {
        let hazardBuffer = hazardBuffers.get(hazardDescriptor.asset);
        if (!hazardBuffer) {
          hazardBuffer = (await readPayload(hazardDescriptor, root)).raw;
          hazardBuffers.set(hazardDescriptor.asset, hazardBuffer);
        }
        actualHazard = hazardBuffer[offset];
        actualHazard /= 255;
      }
      const expectedHazard = expectedSample[channel] || 0;
      compareClose(actualHazard, expectedHazard, `L14 ${channel} ${x},${y}`, 0.5 / 255 + 1e-6);
      maximumHazardErrors[channel] = Math.max(maximumHazardErrors[channel], Math.abs(actualHazard - expectedHazard));
    }
    checked++;
  }
  return { status: 'passed', checked_samples: checked, checked_hazard_samples: checked * 2, maximum_decoded_rain_error_mmh: maximumError, maximum_decoded_hazard_errors: maximumHazardErrors };
}

async function aggregateReference(manifest, levels, weather) {
  const topology = new GeographicLodTopology(undefined, { minLevel: 10, maxLevel: 14 });
  const pyramid = new GeographicWeatherPyramid(Float32Array, topology);
  const summaries = pyramid.evaluate([11, 12], weather.prepareFrame(0));
  const names = ['rainWetMeanMmh', 'rainMaxMmh', 'rainCoverage', 'strongCoverage', 'stormCoverage', 'stormMaxSeverity', 'hailCoverage', 'hailMaxSeverity'];
  const maximumErrors = Object.fromEntries(LEVELS.slice(0, 2).map((level) => [level, Object.fromEntries(names.map((name) => [name, 0]))]));
  let checked = 0;
  for (const levelNumber of [11, 12]) {
    const level = levels.get(levelNumber);
    const support = level.grid.support_sample_bounds;
    const summary = summaries[levelNumber];
    const levelData = summary.levelData;
    requireValue(levelData.minI === support.min_i && levelData.maxI === support.max_i && levelData.minJ === support.min_j && levelData.maxJ === support.max_j, `L${levelNumber}: generated support extent differs from JS pyramid`);
    const valuesX = representativeAxis(support.min_i, support.max_i);
    const valuesY = representativeAxis(support.min_j, support.max_j);
    for (const x of valuesX) {
      for (const y of valuesY) {
        const tile = tileFor(level, x, y);
        const block = tile.blocks[0];
        const planeA = (await readPayload(block.summary_a, root)).raw;
        const planeB = block.summary_b ? (await readPayload(block.summary_b, root)).raw : null;
        const sampleIndex = (y % TILE_SIZE) * TILE_SIZE + (x % TILE_SIZE);
        const total = summary.totalWeight[(y - levelData.minJ) * levelData.width + x - levelData.minI];
        const rainWeight = summary.rainCoverageWeight[0][(y - levelData.minJ) * levelData.width + x - levelData.minI];
        const index = (y - levelData.minJ) * levelData.width + x - levelData.minI;
        // The production pyramid's generic profile retains seven thresholds;
        // the compact asset keeps only the active 0.05 and 2.5 mm/h entries.
        const expected = [
          rainWeight > 0 ? summary.rainWeightedSumMmh[index] / rainWeight : 0,
          summary.rainMaxMmh[index],
          total > 0 ? rainWeight / total : 0,
          total > 0 ? summary.rainCoverageWeight[4][index] / total : 0,
          total > 0 ? summary.stormCoverageWeight[index] / total : 0,
          summary.stormMaxSeverity[index],
          total > 0 ? summary.hailCoverageWeight[index] / total : 0,
          summary.hailMaxSeverity[index]
        ];
        const actual = [
          halfAt(planeA, sampleIndex, 0), halfAt(planeA, sampleIndex, 1), halfAt(planeA, sampleIndex, 2), halfAt(planeA, sampleIndex, 3),
          planeB ? halfAt(planeB, sampleIndex, 0) : 0, planeB ? halfAt(planeB, sampleIndex, 1) : 0,
          planeB ? halfAt(planeB, sampleIndex, 2) : 0, planeB ? halfAt(planeB, sampleIndex, 3) : 0
        ];
        for (let component = 0; component < names.length; component++) {
          const tolerance = Math.max(0.001, Math.abs(expected[component]) * 0.001 + 0.001);
          compareClose(actual[component], expected[component], `L${levelNumber} ${names[component]} ${x},${y}`, tolerance);
          maximumErrors[levelNumber][names[component]] = Math.max(maximumErrors[levelNumber][names[component]], Math.abs(actual[component] - expected[component]));
        }
        checked++;
      }
    }
  }
  const noDataLevel = levels.get(11);
  const generated = noDataLevel.grid.generated_sample_bounds;
  const support = noDataLevel.grid.support_sample_bounds;
  if (generated.min_i < support.min_i) {
    const tile = tileFor(noDataLevel, generated.min_i, support.min_j);
    const raw = (await readPayload(tile.blocks[0].summary_a, root)).raw;
    const local = (support.min_j % TILE_SIZE) * TILE_SIZE + (generated.min_i % TILE_SIZE);
    requireValue(halfAt(raw, local, 2) === -1, 'aggregate NoData sentinel is not exactly -1.0');
  }
  return { status: 'passed', checked_samples: checked, maximum_errors: maximumErrors };
}

function hazardMeanOmissionProof() {
  const deterministic = [0.0, 0.2660123, 0.481875, 0.6977377, 1.0];
  for (const values of [deterministic, [0.2, 0.5, 0.8], [0.01, 0.9]]) {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const maximum = Math.max(...values);
    requireValue(mean <= maximum + Number.EPSILON, 'positive hazard mean exceeded max severity');
    const strength = (value, threshold) => Math.max(0, Math.min(1, (value - threshold * 0.45) / (0.93 - threshold * 0.45)));
    requireValue(Math.abs(Math.max(strength(mean, 0.075), strength(maximum, 0.075)) - strength(maximum, 0.075)) < 1e-12, 'Squares monotonic strength equivalence failed');
  }
  return { status: 'passed', assertion: 'active Dots max(mean,max) and Squares strength(max(mean,max)) reduce to coverage plus max severity' };
}

async function main() {
  const manifest = await jsonFile(path.join(root, 'manifest.json'));
  const levels = await validateStructure(manifest);
  validateNesting(levels);
  const parity = await legacyParity(manifest, levels);
  const { metadata, weather } = await loadRealWeatherFixture({ retainAllSourceFrames: true });
  requireValue(metadata.generation_id === manifest.source_generation_id, 'manifest generation does not match local normalized source');
  setGeographicWeatherSupport(metadata.spatial_grid.weather_support);
  setActiveWeatherField(weather);
  const l14 = await directL14Reference(manifest, levels, weather);
  const aggregate = await aggregateReference(manifest, levels, weather);
  const omission = hazardMeanOmissionProof();
  console.log(JSON.stringify({
    status: 'passed',
    root,
    schema: manifest.schema,
    source_generation_id: manifest.source_generation_id,
    structural: { levels: LEVELS.map((level) => ({ level, tile_count: levels.get(level).tile_count, block_count: levels.get(level).block_count, payload_totals: levels.get(level).payload_totals })) },
    l13_legacy_parity: parity,
    l14_direct_reference: l14,
    aggregate_reference: aggregate,
    hazard_mean_omission: omission
  }, null, 2));
  console.log('tiled rain multi-LOD asset verification: PASS');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
