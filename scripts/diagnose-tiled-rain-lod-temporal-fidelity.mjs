import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRealWeatherFixture } from './real-weather-fixture.mjs';
import { setActiveWeatherField } from '../src/engine/geography.js';
import { geographicTemporalFrameAt, TEMPORAL_FRAME_COUNT } from '../src/engine/geographic-layer-utils.js';
import { GeographicLodTopology } from '../src/engine/geographic-lod.js';
import {
  GeographicWeatherPyramid,
  WEATHER_REFERENCE_LEVEL
} from '../src/engine/geographic-weather-pyramid.js';
import { mapDotsWeatherSummary } from '../src/engine/geographic-dots-layer.js';
import { mapSquaresWeatherSummary } from '../src/engine/geographic-squares-layer.js';
import { RAIN_STRONG_RADIUS_ANCHORS } from '../src/engine/config.js';
import {
  dotsStrongRainMmhToRadiusFraction,
  rainMmhToRadiusFraction
} from '../src/engine/precipitation-mapping.js';
import { geographicHazardRadiusForSeverity } from '../src/engine/hazard-renderer.js';

const LEVELS = [10, 11, 12];
const REFERENCE_LEVEL = WEATHER_REFERENCE_LEVEL;
const TILE_SIZE = 128;
const TILE_SAMPLES = TILE_SIZE * TILE_SIZE;
const BLOCK_SIZE = 4;
const SUMMARY_COMPONENTS = [
  'rainWetMeanMmh', 'rainMaxMmh', 'rainCoverage', 'strongCoverage',
  'stormCoverage', 'stormMaxSeverity', 'hailCoverage', 'hailMaxSeverity'
];
const Dots_COMPONENTS = ['rainRadiusFraction', 'strongRadiusFraction', 'stormRadiusFraction', 'hailRadiusFraction'];
const SQUARES_COMPONENTS = [
  'rainWetMeanMmh', 'rainCoverage', 'strongInput', 'rainAlpha',
  'stormEffectiveStrength', 'hailEffectiveStrength', 'finalAlpha'
];
const PROGRESSES = [0.2, 0.5, 0.8];
const root = path.resolve(process.argv[2] || fileURLToPath(new URL('../data/generated/tiled-rain-lod/current/', import.meta.url)));
const sourceRoot = path.resolve(process.argv[3] || fileURLToPath(new URL('../data/generated/current/', import.meta.url)));

function fail(message) {
  throw new Error(`tiled-rain-lod temporal diagnostic failed: ${message}`);
}

function requireValue(condition, message) {
  if (!condition) fail(message);
}

async function jsonFile(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function payloadFile(asset) {
  requireValue(typeof asset === 'string' && !path.isAbsolute(asset), `payload path is not relative: ${asset}`);
  const resolved = path.resolve(root, asset);
  const relative = path.relative(root, resolved);
  requireValue(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`), `payload escapes generated root: ${asset}`);
  return resolved;
}

function decodeHalf(bits) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >>> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction ? Number.NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function halfAt(buffer, frameIndex, sampleIndex, component) {
  return decodeHalf(buffer.readUInt16LE(((frameIndex * TILE_SAMPLES + sampleIndex) * 4 + component) * 2));
}

function extentSize(extent) {
  return { width: extent.max_i - extent.min_i + 1, height: extent.max_j - extent.min_j + 1 };
}

function tileFor(level, x, y) {
  return level.tileMap.get(`${Math.floor(x / TILE_SIZE)}:${Math.floor(y / TILE_SIZE)}`);
}

function blockFor(tile, frame) {
  const block = tile.blocks.find((candidate) => frame >= candidate.frame_start
    && frame < candidate.frame_start + candidate.frame_count);
  requireValue(block, `missing block for source frame ${frame} in L${tile.level || '?'}`);
  return block;
}

function makeMetric() {
  return { count: 0, absolute_sum: 0, squared_sum: 0, maximum: 0, samples: [] };
}

function addMetric(metric, error, index) {
  requireValue(Number.isFinite(error), 'non-finite comparison error');
  metric.count++;
  metric.absolute_sum += error;
  metric.squared_sum += error * error;
  if (error > metric.maximum) metric.maximum = error;
  // A regular deterministic spatial stride keeps quantiles bounded while the
  // count/sum/max statistics still cover every supported sample.
  if ((index & 31) === 0) metric.samples.push(error);
}

function finishMetric(metric) {
  const sorted = metric.samples.sort((a, b) => a - b);
  const quantile = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] : 0;
  return {
    sample_count: metric.count,
    mean_absolute_error: metric.count ? metric.absolute_sum / metric.count : 0,
    rms_error: metric.count ? Math.sqrt(metric.squared_sum / metric.count) : 0,
    p95_absolute_error: quantile(0.95),
    p99_absolute_error: quantile(0.99),
    maximum_absolute_error: metric.maximum,
    quantile_sample_count: sorted.length,
    quantile_method: 'regular spatial stride 32 (deterministic)'
  };
}

function makeMetricSet(names) {
  return Object.fromEntries(names.map((name) => [name, makeMetric()]));
}

function finishMetricSet(metrics) {
  return Object.fromEntries(Object.entries(metrics).map(([name, metric]) => [name, finishMetric(metric)]));
}

function compactFromSummary(summary) {
  const count = summary.levelData.count;
  const values = Object.fromEntries(SUMMARY_COMPONENTS.map((name) => [name, new Float32Array(count)]));
  const rainCoverageWeights = summary.rainCoverageWeight;
  for (let index = 0; index < count; index++) {
    const total = summary.totalWeight[index];
    const rainWeight = rainCoverageWeights[0][index];
    const strongWeight = rainCoverageWeights[4][index];
    const stormWeight = summary.stormCoverageWeight?.[index] || 0;
    const hailWeight = summary.hailCoverageWeight?.[index] || 0;
    values.rainWetMeanMmh[index] = rainWeight > 0 ? summary.rainWeightedSumMmh[index] / rainWeight : 0;
    values.rainMaxMmh[index] = summary.rainMaxMmh[index];
    values.rainCoverage[index] = total > 0 ? rainWeight / total : 0;
    values.strongCoverage[index] = total > 0 ? strongWeight / total : 0;
    values.stormCoverage[index] = total > 0 ? stormWeight / total : 0;
    values.stormMaxSeverity[index] = summary.stormMaxSeverity?.[index] || 0;
    values.hailCoverage[index] = total > 0 ? hailWeight / total : 0;
    values.hailMaxSeverity[index] = summary.hailMaxSeverity?.[index] || 0;
  }
  return values;
}

function compactFromAssetFrame(frame) {
  const values = Object.fromEntries(SUMMARY_COMPONENTS.map((name) => [name, new Float32Array(frame.count)]));
  for (const name of SUMMARY_COMPONENTS) values[name].set(frame[name]);
  return values;
}

function mixCompact(a, b, progress) {
  const output = Object.fromEntries(SUMMARY_COMPONENTS.map((name) => [name, new Float32Array(a[name].length)]));
  const inverse = 1 - progress;
  for (const name of SUMMARY_COMPONENTS) {
    const target = output[name];
    for (let index = 0; index < target.length; index++) target[index] = a[name][index] * inverse + b[name][index] * progress;
  }
  return output;
}

function smoothstep(edge0, edge1, value) {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function strongRainMmhToShaderFraction(value) {
  const mmh = Number(value);
  const anchors = RAIN_STRONG_RADIUS_ANCHORS;
  const maximumRadius = anchors[anchors.length - 1].radius;
  if (mmh <= anchors[0].mmh) return 0;
  for (let index = 1; index < anchors.length; index++) {
    const upper = anchors[index];
    if (mmh <= upper.mmh) {
      const lower = anchors[index - 1];
      const progress = Math.max(0, Math.min(1, (mmh - lower.mmh) / (upper.mmh - lower.mmh)));
      return Math.sqrt(lower.radius * lower.radius + (upper.radius * upper.radius - lower.radius * lower.radius) * progress) / maximumRadius;
    }
  }
  return 1;
}

// These are the exact scalar expressions in geographic-squares-layer.js:
// rainVisibility/strongRain come from precipitation-mapping.js shader anchors,
// and strength() plus the coverage/max composition comes from its fragment shader.
function squareScalars(values) {
  const rainMean = values.rainWetMeanMmh;
  const rainCoverage = Math.max(0, Math.min(1, values.rainCoverage));
  const rainInput = rainMmhToRadiusFraction(rainMean);
  const strongInput = strongRainMmhToShaderFraction(rainMean);
  const rainAlpha = rainInput * rainCoverage;
  const stormStrength = smoothstep(0.075 * 0.45, 0.93, values.stormMaxSeverity);
  const hailStrength = smoothstep(0.11 * 0.45, 0.93, values.hailMaxSeverity);
  const stormEffectiveStrength = Math.max(0, Math.min(1, values.stormCoverage)) * stormStrength;
  const hailEffectiveStrength = Math.max(0, Math.min(1, values.hailCoverage)) * hailStrength;
  return {
    rainWetMeanMmh: rainMean,
    rainCoverage,
    strongInput,
    rainAlpha,
    stormEffectiveStrength,
    hailEffectiveStrength,
    finalAlpha: Math.max(rainAlpha, stormEffectiveStrength, hailEffectiveStrength)
  };
}

function dotsScalars(values, spacing) {
  const rain = Math.sqrt(Math.max(0, values.rainCoverage)) * rainMmhToRadiusFraction(values.rainWetMeanMmh);
  const strong = Math.sqrt(Math.max(0, values.strongCoverage)) * dotsStrongRainMmhToRadiusFraction(values.rainMaxMmh);
  const hail = Math.sqrt(Math.max(0, values.hailCoverage))
    * geographicHazardRadiusForSeverity('hail', values.hailMaxSeverity, spacing) / spacing;
  const storm = hail > 0 ? 0 : Math.sqrt(Math.max(0, values.stormCoverage))
    * geographicHazardRadiusForSeverity('storm', values.stormMaxSeverity, spacing) / spacing;
  return {
    rainRadiusFraction: rain,
    strongRadiusFraction: strong,
    stormRadiusFraction: storm,
    hailRadiusFraction: hail
  };
}

function mappedDotsToScalars(mapped, spacing, count) {
  const output = Object.fromEntries(Dots_COMPONENTS.map((name) => [name, new Float32Array(count)]));
  for (let index = 0; index < count; index++) {
    output.rainRadiusFraction[index] = mapped.rainRadius[index] / spacing;
    output.strongRadiusFraction[index] = mapped.strongRadius[index] / spacing;
    output.stormRadiusFraction[index] = (mapped.stormRadius?.[index] || 0) / spacing;
    output.hailRadiusFraction[index] = (mapped.hailRadius?.[index] || 0) / spacing;
  }
  return output;
}

function mappedSquaresToScalars(mapped, count) {
  const output = Object.fromEntries(SQUARES_COMPONENTS.map((name) => [name, new Float32Array(count)]));
  for (let index = 0; index < count; index++) {
    const rainMean = mapped.rainWetMeanMmh[index];
    const rainCoverage = Math.max(0, Math.min(1, mapped.rainCoverage[index]));
    const rainInput = rainMmhToRadiusFraction(rainMean);
    const strongInput = strongRainMmhToShaderFraction(rainMean);
    const rainAlpha = rainInput * rainCoverage;
    const stormStrength = smoothstep(0.075 * 0.45, 0.93, mapped.stormMaxSeverity?.[index] || 0);
    const hailStrength = smoothstep(0.11 * 0.45, 0.93, mapped.hailMaxSeverity?.[index] || 0);
    const stormEffective = Math.max(0, Math.min(1, mapped.stormCoverage?.[index] || 0)) * stormStrength;
    const hailEffective = Math.max(0, Math.min(1, mapped.hailCoverage?.[index] || 0)) * hailStrength;
    output.rainWetMeanMmh[index] = rainMean;
    output.rainCoverage[index] = rainCoverage;
    output.strongInput[index] = strongInput;
    output.rainAlpha[index] = rainAlpha;
    output.stormEffectiveStrength[index] = stormEffective;
    output.hailEffectiveStrength[index] = hailEffective;
    output.finalAlpha[index] = Math.max(rainAlpha, stormEffective, hailEffective);
  }
  return output;
}

function dotsAtCompact(values, spacing, count) {
  const output = Object.fromEntries(Dots_COMPONENTS.map((name) => [name, new Float32Array(count)]));
  for (let index = 0; index < count; index++) {
    const rainCoverage = Math.max(0, values.rainCoverage[index]);
    const strongCoverage = Math.max(0, values.strongCoverage[index]);
    const hail = Math.sqrt(Math.max(0, values.hailCoverage[index]))
      * geographicHazardRadiusForSeverity('hail', values.hailMaxSeverity[index], spacing) / spacing;
    const storm = hail > 0 ? 0 : Math.sqrt(Math.max(0, values.stormCoverage[index]))
      * geographicHazardRadiusForSeverity('storm', values.stormMaxSeverity[index], spacing) / spacing;
    output.rainRadiusFraction[index] = Math.sqrt(rainCoverage) * rainMmhToRadiusFraction(values.rainWetMeanMmh[index]);
    output.strongRadiusFraction[index] = Math.sqrt(strongCoverage) * dotsStrongRainMmhToRadiusFraction(values.rainMaxMmh[index]);
    output.stormRadiusFraction[index] = storm;
    output.hailRadiusFraction[index] = hail;
  }
  return output;
}

function squaresAtCompact(values, count) {
  const output = Object.fromEntries(SQUARES_COMPONENTS.map((name) => [name, new Float32Array(count)]));
  for (let index = 0; index < count; index++) {
    const rainMean = values.rainWetMeanMmh[index];
    const rainCoverage = Math.max(0, Math.min(1, values.rainCoverage[index]));
    const rainInput = rainMmhToRadiusFraction(rainMean);
    const strongInput = strongRainMmhToShaderFraction(rainMean);
    const rainAlpha = rainInput * rainCoverage;
    const stormStrength = smoothstep(0.075 * 0.45, 0.93, values.stormMaxSeverity[index]);
    const hailStrength = smoothstep(0.11 * 0.45, 0.93, values.hailMaxSeverity[index]);
    const stormEffective = Math.max(0, Math.min(1, values.stormCoverage[index])) * stormStrength;
    const hailEffective = Math.max(0, Math.min(1, values.hailCoverage[index])) * hailStrength;
    output.rainWetMeanMmh[index] = rainMean;
    output.rainCoverage[index] = rainCoverage;
    output.strongInput[index] = strongInput;
    output.rainAlpha[index] = rainAlpha;
    output.stormEffectiveStrength[index] = stormEffective;
    output.hailEffectiveStrength[index] = hailEffective;
    output.finalAlpha[index] = Math.max(rainAlpha, stormEffective, hailEffective);
  }
  return output;
}

function interpolateScalars(a, b, progress, names) {
  const output = Object.fromEntries(names.map((name) => [name, new Float32Array(a[name].length)]));
  const inverse = 1 - progress;
  for (const name of names) {
    for (let index = 0; index < output[name].length; index++) output[name][index] = a[name][index] * inverse + b[name][index] * progress;
  }
  return output;
}

function updateMetricSet(metrics, actual, expected, count) {
  for (const name of Object.keys(metrics)) {
    for (let index = 0; index < count; index++) addMetric(metrics[name], Math.abs(actual[name][index] - expected[name][index]), index);
  }
}

function updateThresholdCounts(target, candidate, reference, count) {
  for (let index = 0; index < count; index++) {
    const rainCandidate = candidate.rainCoverage[index] > 0;
    const rainReference = reference.rainCoverage[index] > 0;
    const strongCandidate = candidate.strongCoverage[index] > 0;
    const strongReference = reference.strongCoverage[index] > 0;
    if (!rainCandidate && rainReference) target.rain_zero_candidate_positive_reference++;
    if (rainCandidate && !rainReference) target.rain_zero_reference_positive_candidate++;
    if (!strongCandidate && strongReference) target.strong_zero_candidate_positive_reference++;
    if (strongCandidate && !strongReference) target.strong_zero_reference_positive_candidate++;
    for (const [name, candidateName] of [['storm', 'stormCoverage'], ['hail', 'hailCoverage']]) {
      const candidateVisible = candidate[candidateName][index] > 0;
      const referenceVisible = reference[candidateName][index] > 0;
      if (!candidateVisible && referenceVisible) target[`${name}_zero_candidate_positive_reference`]++;
      if (candidateVisible && !referenceVisible) target[`${name}_zero_reference_positive_candidate`]++;
    }
    if (Math.abs(candidate.rainCoverage[index] - reference.rainCoverage[index]) > 0.05) target.rain_coverage_error_gt_005++;
    if (Math.abs(candidate.rainCoverage[index] - reference.rainCoverage[index]) > 0.10) target.rain_coverage_error_gt_010++;
    if (Math.abs(candidate.strongCoverage[index] - reference.strongCoverage[index]) > 0.05) target.strong_coverage_error_gt_005++;
    if (Math.abs(candidate.strongCoverage[index] - reference.strongCoverage[index]) > 0.10) target.strong_coverage_error_gt_010++;
    for (const name of ['storm', 'hail']) {
      if (Math.abs(candidate[`${name}Coverage`][index] - reference[`${name}Coverage`][index]) > 0.05) target[`${name}_coverage_error_gt_005`]++;
      if (Math.abs(candidate[`${name}Coverage`][index] - reference[`${name}Coverage`][index]) > 0.10) target[`${name}_coverage_error_gt_010`]++;
    }
  }
}

function addWorst(examples, category, score, detail) {
  if (!Number.isFinite(score)) return;
  const list = examples[category] || (examples[category] = []);
  list.push({ score, ...detail });
  list.sort((a, b) => b.score - a.score || a.level - b.level || a.interval - b.interval || a.progress - b.progress || a.j - b.j || a.i - b.i);
  if (list.length > 5) list.length = 5;
}

function mightEnterWorst(examples, category, score) {
  const list = examples[category];
  return !list || list.length < 5 || score > list[list.length - 1].score;
}

async function loadAssetSummaryFrame(level, frame) {
  const extent = level.grid.support_sample_bounds;
  const size = extentSize(extent);
  const output = Object.fromEntries(SUMMARY_COMPONENTS.map((name) => [name, new Float32Array(size.width * size.height)]));
  const tiles = level.tiles.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  for (const tile of tiles) {
    const block = tile.blocks.find((candidate) => frame >= candidate.frame_start
      && frame < candidate.frame_start + candidate.frame_count);
    requireValue(block, `L${level.level} missing asset block for frame ${frame}`);
    const localFrame = frame - block.frame_start;
    const summaryA = block.summary_a;
    const summaryB = block.summary_b;
    requireValue(summaryA, `L${level.level} frame ${frame} is missing Summary A`);
    const [aBuffer, bBuffer] = await Promise.all([
      readFile(payloadFile(summaryA.asset)),
      summaryB ? readFile(payloadFile(summaryB.asset)) : null
    ]);
    const minX = Math.max(extent.min_i, tile.x * TILE_SIZE);
    const maxX = Math.min(extent.max_i, tile.x * TILE_SIZE + TILE_SIZE - 1);
    const minY = Math.max(extent.min_j, tile.y * TILE_SIZE);
    const maxY = Math.min(extent.max_j, tile.y * TILE_SIZE + TILE_SIZE - 1);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const tileSample = (y - tile.y * TILE_SIZE) * TILE_SIZE + (x - tile.x * TILE_SIZE);
        const outputIndex = (y - extent.min_j) * size.width + (x - extent.min_i);
        output.rainWetMeanMmh[outputIndex] = halfAt(aBuffer, localFrame, tileSample, 0);
        output.rainMaxMmh[outputIndex] = halfAt(aBuffer, localFrame, tileSample, 1);
        output.rainCoverage[outputIndex] = halfAt(aBuffer, localFrame, tileSample, 2);
        output.strongCoverage[outputIndex] = halfAt(aBuffer, localFrame, tileSample, 3);
        if (bBuffer) {
          output.stormCoverage[outputIndex] = halfAt(bBuffer, localFrame, tileSample, 0);
          output.stormMaxSeverity[outputIndex] = halfAt(bBuffer, localFrame, tileSample, 1);
          output.hailCoverage[outputIndex] = halfAt(bBuffer, localFrame, tileSample, 2);
          output.hailMaxSeverity[outputIndex] = halfAt(bBuffer, localFrame, tileSample, 3);
        }
      }
    }
  }
  for (const name of SUMMARY_COMPONENTS) {
    for (const value of output[name]) requireValue(Number.isFinite(value), `L${level.level} ${name} contains a non-finite Float16 value`);
  }
  return { ...output, ...size, minI: extent.min_i, minJ: extent.min_j, count: size.width * size.height };
}

async function validateManifest(manifest, metadata) {
  requireValue(manifest.schema === 'dot-field-tiled-rain-lod-v1', 'schema mismatch');
  requireValue(manifest.version === 1, 'version mismatch');
  requireValue(manifest.reference_level === REFERENCE_LEVEL, 'reference level mismatch');
  requireValue(manifest.tile_size === TILE_SIZE && manifest.temporal_block_size === BLOCK_SIZE, 'tile or block contract mismatch');
  requireValue(manifest.source_generation_id === metadata.generation_id, `source generation mismatch: ${manifest.source_generation_id} vs ${metadata.generation_id}`);
  requireValue(manifest.frame_count === metadata.time.count, 'frame count mismatch with normalized source');
  assert.deepEqual(manifest.timestamps, metadata.time.timestamps, 'timestamp list mismatch');
  const levels = new Map();
  for (const level of manifest.levels || []) {
    requireValue([10, 11, 12, 13, 14].includes(level.level), `unexpected level L${level.level}`);
    requireValue(level.kind === (level.level < REFERENCE_LEVEL ? 'aggregate-summary' : 'direct'), `L${level.level} kind mismatch`);
    if (level.level >= REFERENCE_LEVEL) continue;
    requireValue(level.tile_size === TILE_SIZE, `L${level.level} tile size mismatch`);
    requireValue(level.encoding?.plane_a?.dtype === 'Float16', `L${level.level} Summary A is not Float16`);
    requireValue(level.encoding.plane_a.components.join(',') === 'rainWetMeanMmh,rainMaxMmh,rainCoverage,strongCoverage', `L${level.level} Summary A component order mismatch`);
    requireValue(level.encoding?.plane_b?.components.join(',') === 'stormCoverage,stormMaxSeverity,hailCoverage,hailMaxSeverity', `L${level.level} Summary B component order mismatch`);
    requireValue(level.encoding.plane_a.nodata_sentinel?.value === -1, `L${level.level} NoData sentinel mismatch`);
    const generatedSize = extentSize(level.grid.generated_sample_bounds);
    const supportSize = extentSize(level.grid.support_sample_bounds);
    requireValue(level.grid.grid_size === 2 ** level.level, `L${level.level} grid size mismatch`);
    requireValue(level.grid.width === generatedSize.width && level.grid.height === generatedSize.height, `L${level.level} generated grid mismatch`);
    requireValue(level.grid.count === generatedSize.width * generatedSize.height, `L${level.level} generated count mismatch`);
    requireValue(supportSize.width > 0 && supportSize.height > 0, `L${level.level} empty support`);
    requireValue(level.tiles.length === level.tile_count, `L${level.level} tile count mismatch`);
    const tileMap = new Map();
    for (const tile of level.tiles) {
      const key = `${tile.x}:${tile.y}`;
      requireValue(!tileMap.has(key), `L${level.level} duplicate tile ${key}`);
      tileMap.set(key, { ...tile, level: level.level });
      requireValue(Array.isArray(tile.blocks) && tile.blocks.length === Math.ceil(manifest.frame_count / BLOCK_SIZE), `L${level.level} ${key} block count mismatch`);
      for (const block of tile.blocks) {
        requireValue(block.summary_a, `L${level.level} ${key} block ${block.index} missing Summary A`);
        requireValue(block.summary_a.component_count === 4 && block.summary_a.sample_count === TILE_SAMPLES, `L${level.level} invalid Summary A descriptor`);
        requireValue(block.summary_a.frame_count === block.frame_count, `L${level.level} invalid Summary A frame count`);
        requireValue(block.summary_a.byte_length === block.frame_count * TILE_SAMPLES * 4 * 2, `L${level.level} invalid Summary A byte length`);
        for (const descriptor of [block.summary_a, block.summary_b].filter(Boolean)) {
          await stat(payloadFile(descriptor.asset));
          requireValue(descriptor.asset.endsWith('.f16'), `L${level.level} summary asset is not .f16`);
        }
      }
    }
    level.tileMap = tileMap;
    levels.set(level.level, level);
  }
  requireValue(LEVELS.every((level) => levels.has(level)), 'not all aggregate levels are present');
  return levels;
}

function sourceNormalizedTime(frame, progress, frameCount) {
  return (frame + progress) / (frameCount - 1);
}

function validateTemporalMapping(weather, frameCount, frame, progress) {
  const time = sourceNormalizedTime(frame, progress, frameCount);
  const prepared = weather.prepareFrame(time);
  requireValue(prepared.frame0 === frame && prepared.frame1 === frame + 1, `source mapping mismatch at interval ${frame} progress ${progress}`);
  requireValue(Math.abs(prepared.progress - progress) < 1e-9, `source progress mismatch at interval ${frame} progress ${progress}`);
  const normalFrame = geographicTemporalFrameAt(time);
  requireValue(normalFrame.index >= 0 && normalFrame.index < TEMPORAL_FRAME_COUNT, 'normal temporal keyframe outside contract');
  return { time, normalFrame };
}

async function selectIntervals(level12, frameCount) {
  const intervalCount = frameCount - 1;
  const stats = Array.from({ length: intervalCount }, () => ({ rainCoverage: 0, strongCoverage: 0, rainMeanOrMax: 0 }));
  const extent = level12.grid.generated_sample_bounds;
  const size = extentSize(extent);
  for (const tile of level12.tiles.slice().sort((a, b) => a.y - b.y || a.x - b.x)) {
    for (const block of tile.blocks) {
      const descriptor = block.summary_a;
      const buffer = await readFile(payloadFile(descriptor.asset));
      for (let localFrame = 0; localFrame < block.frame_count; localFrame++) {
        const frame = block.frame_start + localFrame;
        if (frame >= frameCount - 1) continue;
        const nextBlock = frame + 1 < block.frame_start + block.frame_count
          ? block : level12.tiles[0].blocks.find((candidate) => frame + 1 >= candidate.frame_start && frame + 1 < candidate.frame_start + candidate.frame_count);
        // The pass intentionally compares neighboring source frames. For a
        // block boundary, the next frame is read from the same tile below.
        let nextBuffer = buffer;
        let nextLocal = localFrame + 1;
        if (!nextBlock || nextLocal >= block.frame_count) {
          const tileBlock = level12.tiles.find((candidate) => candidate.x === tile.x && candidate.y === tile.y).blocks
            .find((candidate) => frame + 1 >= candidate.frame_start && frame + 1 < candidate.frame_start + candidate.frame_count);
          nextBuffer = await readFile(payloadFile(tileBlock.summary_a.asset));
          nextLocal = frame + 1 - tileBlock.frame_start;
        }
        for (let sample = 0; sample < TILE_SAMPLES; sample++) {
          const currentCoverage = halfAt(buffer, localFrame, sample, 2);
          const nextCoverage = halfAt(nextBuffer, nextLocal, sample, 2);
          if (currentCoverage >= 0 && nextCoverage >= 0) stats[frame].rainCoverage = Math.max(stats[frame].rainCoverage, Math.abs(nextCoverage - currentCoverage));
          const currentStrong = halfAt(buffer, localFrame, sample, 3);
          const nextStrong = halfAt(nextBuffer, nextLocal, sample, 3);
          if (currentStrong >= 0 && nextStrong >= 0) stats[frame].strongCoverage = Math.max(stats[frame].strongCoverage, Math.abs(nextStrong - currentStrong));
          const currentMean = halfAt(buffer, localFrame, sample, 0);
          const nextMean = halfAt(nextBuffer, nextLocal, sample, 0);
          const currentMax = halfAt(buffer, localFrame, sample, 1);
          const nextMax = halfAt(nextBuffer, nextLocal, sample, 1);
          if (currentCoverage >= 0 && nextCoverage >= 0) stats[frame].rainMeanOrMax = Math.max(stats[frame].rainMeanOrMax, Math.abs(nextMean - currentMean), Math.abs(nextMax - currentMax));
        }
      }
    }
  }
  const selected = new Map();
  const add = (interval, reason) => {
    if (!selected.has(interval)) selected.set(interval, []);
    selected.get(interval).push(reason);
  };
  const base = [0, Math.round((intervalCount - 1) * 0.25), Math.round((intervalCount - 1) * 0.5), Math.round((intervalCount - 1) * 0.75), intervalCount - 1];
  for (const interval of [...new Set(base)]) add(interval, interval === 0 ? 'first source interval' : interval === intervalCount - 1 ? 'final source interval' : `sequence position ${Math.round(interval / (intervalCount - 1) * 100)}%`);
  for (const [name, label] of [['rainCoverage', 'largest L12 rainCoverage endpoint change'], ['strongCoverage', 'largest L12 strongCoverage endpoint change'], ['rainMeanOrMax', 'largest L12 rainWetMeanMmh/rainMaxMmh endpoint change']]) {
    const maximum = Math.max(...stats.map((value) => value[name]));
    add(stats.findIndex((value) => value[name] === maximum), label);
  }
  return { intervals: [...selected.keys()].sort((a, b) => a - b), reasons: Object.fromEntries([...selected.entries()].map(([interval, reasons]) => [interval, [...new Set(reasons)]])), endpointChangeStats: stats };
}

function makeThresholdCounts() {
  return {
    rain_zero_candidate_positive_reference: 0,
    rain_zero_reference_positive_candidate: 0,
    strong_zero_candidate_positive_reference: 0,
    strong_zero_reference_positive_candidate: 0,
    storm_zero_candidate_positive_reference: 0,
    storm_zero_reference_positive_candidate: 0,
    hail_zero_candidate_positive_reference: 0,
    hail_zero_reference_positive_candidate: 0,
    rain_coverage_error_gt_005: 0,
    rain_coverage_error_gt_010: 0,
    strong_coverage_error_gt_005: 0,
    strong_coverage_error_gt_010: 0,
    storm_coverage_error_gt_005: 0,
    storm_coverage_error_gt_010: 0,
    hail_coverage_error_gt_005: 0,
    hail_coverage_error_gt_010: 0
  };
}

function makeVisibilityCounts() {
  return Object.fromEntries(Dots_COMPONENTS.map((name) => [name, 0]));
}

function addFloat16Separation(target, actual, unquantized, reference, count) {
  for (const name of SUMMARY_COMPONENTS) {
    for (let index = 0; index < count; index++) {
      addMetric(target.float16_transport[name], Math.abs(actual[name][index] - unquantized[name][index]), index);
      addMetric(target.temporal_approximation[name], Math.abs(unquantized[name][index] - reference[name][index]), index);
    }
  }
}

function collectHazardMeanProof(summary) {
  if (!summary.stormWeightedSeverity || !summary.hailWeightedSeverity) return 0;
  let maximumViolation = 0;
  for (const [weighted, coverage, maximum] of [
    [summary.stormWeightedSeverity, summary.stormCoverageWeight, summary.stormMaxSeverity],
    [summary.hailWeightedSeverity, summary.hailCoverageWeight, summary.hailMaxSeverity]
  ]) {
    for (let index = 0; index < summary.levelData.count; index++) {
      const mean = coverage[index] > 0 ? weighted[index] / coverage[index] : 0;
      maximumViolation = Math.max(maximumViolation, mean - maximum[index]);
    }
  }
  requireValue(maximumViolation <= 1e-5, `hazard mean exceeded max by ${maximumViolation}`);
  return maximumViolation;
}

async function main() {
  const metadata = await jsonFile(path.join(sourceRoot, 'metadata.json'));
  const manifest = await jsonFile(path.join(root, 'manifest.json'));
  const levels = await validateManifest(manifest, metadata);
  const { weather } = await loadRealWeatherFixture({ sourceFrameCacheLimit: 19, retainAllSourceFrames: true });
  setActiveWeatherField(weather);
  requireValue(weather.frameCount === manifest.frame_count, 'loaded weather frame count differs from manifest');
  const topology = new GeographicLodTopology(undefined, { minLevel: 10, maxLevel: REFERENCE_LEVEL });
  const pyramid = new GeographicWeatherPyramid(Float32Array, topology);
  for (const level of LEVELS) {
    const data = pyramid.levelDataFor(level);
    const grid = levels.get(level).grid;
    requireValue(data.minI === grid.support_sample_bounds.min_i && data.maxI === grid.support_sample_bounds.max_i
      && data.minJ === grid.support_sample_bounds.min_j && data.maxJ === grid.support_sample_bounds.max_j, `L${level} support identity differs from runtime pyramid`);
  }
  const selection = await selectIntervals(levels.get(12), manifest.frame_count);
  const results = Object.fromEntries(LEVELS.map((level) => [level, {
    raw_summary: { candidate_a: makeMetricSet(SUMMARY_COMPONENTS), unquantized_endpoint_interpolation: makeMetricSet(SUMMARY_COMPONENTS) },
    dots: { candidate_a: makeMetricSet(Dots_COMPONENTS), candidate_b: makeMetricSet(Dots_COMPONENTS), visibility_disagreements: { candidate_a: makeVisibilityCounts(), candidate_b: makeVisibilityCounts() } },
    squares: { candidate_a: makeMetricSet(SQUARES_COMPONENTS), candidate_b: makeMetricSet(SQUARES_COMPONENTS) },
    thresholds: makeThresholdCounts(),
    float16_vs_temporal: { float16_transport: makeMetricSet(SUMMARY_COMPONENTS), temporal_approximation: makeMetricSet(SUMMARY_COMPONENTS) },
    hazard_mean_omission_proof: { maximum_mean_minus_max_violation: 0 }
  }]));
  const worst = {};
  let tileInvariantChecks = 0;
  const selectedCases = [];
  for (const interval of selection.intervals) {
    const endpointAssets = {};
    const endpointReference = {};
    const endpointDots = {};
    const endpointSquares = {};
    for (const level of LEVELS) {
      endpointAssets[level] = [await loadAssetSummaryFrame(levels.get(level), interval), await loadAssetSummaryFrame(levels.get(level), interval + 1)];
      const referenceSummaries = [0, 1].map((offset) => pyramid.evaluate([level], weather.prepareFrame(sourceNormalizedTime(interval + offset, 0, manifest.frame_count)))[level]);
      endpointReference[level] = referenceSummaries.map(compactFromSummary);
      const decodedEndpoints = endpointAssets[level].map(compactFromAssetFrame);
      endpointDots[level] = decodedEndpoints.map((values) => dotsAtCompact(values, 2 ** -level, values.rainCoverage.length));
      endpointSquares[level] = decodedEndpoints.map((values) => squaresAtCompact(values, values.rainCoverage.length));
      results[level].hazard_mean_omission_proof.maximum_mean_minus_max_violation = Math.max(
        results[level].hazard_mean_omission_proof.maximum_mean_minus_max_violation,
        ...referenceSummaries.map(collectHazardMeanProof)
      );
    }
    for (const progress of PROGRESSES) {
      const mapping = validateTemporalMapping(weather, manifest.frame_count, interval, progress);
      selectedCases.push({ source_interval: [interval, interval + 1], progress, normalized_time: mapping.time, normal_temporal_keyframe: mapping.normalFrame });
      for (const level of LEVELS) {
        const levelData = pyramid.levelDataFor(level);
        const referenceFrame = weather.prepareFrame(mapping.time);
        const referenceSummary = pyramid.evaluate([level], referenceFrame)[level];
        const reference = compactFromSummary(referenceSummary);
        const actualEndpoint = endpointAssets[level].map(compactFromAssetFrame);
        const unquantizedEndpoint = endpointReference[level];
        const candidateA = mixCompact(actualEndpoint[0], actualEndpoint[1], progress);
        const unquantizedCandidate = mixCompact(unquantizedEndpoint[0], unquantizedEndpoint[1], progress);
        const actualReferenceDots = mappedDotsToScalars(mapDotsWeatherSummary(referenceSummary), levelData.spacing, levelData.count);
        const actualReferenceSquares = mappedSquaresToScalars(mapSquaresWeatherSummary(referenceSummary), levelData.count);
        const candidateADots = dotsAtCompact(candidateA, levelData.spacing, levelData.count);
        const candidateBSummaryDots = interpolateScalars(endpointDots[level][0], endpointDots[level][1], progress, Dots_COMPONENTS);
        const candidateASquares = squaresAtCompact(candidateA, levelData.count);
        const candidateBSquares = interpolateScalars(endpointSquares[level][0], endpointSquares[level][1], progress, SQUARES_COMPONENTS);
        updateMetricSet(results[level].raw_summary.candidate_a, candidateA, reference, levelData.count);
        updateMetricSet(results[level].raw_summary.unquantized_endpoint_interpolation, unquantizedCandidate, reference, levelData.count);
        updateMetricSet(results[level].dots.candidate_a, candidateADots, actualReferenceDots, levelData.count);
        updateMetricSet(results[level].dots.candidate_b, candidateBSummaryDots, actualReferenceDots, levelData.count);
        for (const name of Dots_COMPONENTS) {
          for (let index = 0; index < levelData.count; index++) {
            if ((candidateADots[name][index] > 0) !== (actualReferenceDots[name][index] > 0)) results[level].dots.visibility_disagreements.candidate_a[name]++;
            if ((candidateBSummaryDots[name][index] > 0) !== (actualReferenceDots[name][index] > 0)) results[level].dots.visibility_disagreements.candidate_b[name]++;
          }
        }
        updateMetricSet(results[level].squares.candidate_a, candidateASquares, actualReferenceSquares, levelData.count);
        updateMetricSet(results[level].squares.candidate_b, candidateBSquares, actualReferenceSquares, levelData.count);
        updateThresholdCounts(results[level].thresholds, candidateA, reference, levelData.count);
        addFloat16Separation(results[level].float16_vs_temporal, candidateA, unquantizedCandidate, reference, levelData.count);
        const extent = levels.get(level).grid.support_sample_bounds;
        const edgeSamples = [
          [extent.min_i, extent.min_j],
          [extent.min_i + 127, extent.min_j + 127],
          [extent.min_i + 128, extent.min_j + 128],
          [extent.max_i - 127, extent.max_j - 127],
          [extent.max_i, extent.max_j]
        ].filter(([i, j]) => i >= extent.min_i && i <= extent.max_i && j >= extent.min_j && j <= extent.max_j);
        for (const [i, j] of edgeSamples) {
          const tile = tileFor(levels.get(level), i, j);
          requireValue(tile, `tile lookup failed at L${level} ${i},${j}`);
          const localX = i - tile.x * TILE_SIZE;
          const localY = j - tile.y * TILE_SIZE;
          const block = tile.blocks.find((candidate) => interval >= candidate.frame_start && interval < candidate.frame_start + candidate.frame_count);
          requireValue(block, `edge sample block lookup failed at L${level} ${i},${j}`);
          const descriptor = block.summary_a;
          const buffer = await readFile(payloadFile(descriptor.asset));
          const localFrame = interval - block.frame_start;
          const sample = localY * TILE_SIZE + localX;
          const assembledIndex = (j - extent.min_j) * levelData.width + i - extent.min_i;
          requireValue(Math.abs(halfAt(buffer, localFrame, sample, 2) - endpointAssets[level][0].rainCoverage[assembledIndex]) < 1e-6, `tile boundary identity mismatch at L${level} ${i},${j}`);
          tileInvariantChecks++;
        }
        for (let index = 0; index < levelData.count; index++) {
          const i = levelData.minI + (index % levelData.width);
          const j = levelData.minJ + Math.floor(index / levelData.width);
          const makeDetail = () => ({
            level, interval, progress, i, j,
            endpoint: Object.fromEntries(SUMMARY_COMPONENTS.map((name) => [name, [actualEndpoint[0][name][index], actualEndpoint[1][name][index]]])),
            reference: Object.fromEntries(SUMMARY_COMPONENTS.map((name) => [name, reference[name][index]])),
            candidate_a: Object.fromEntries(SUMMARY_COMPONENTS.map((name) => [name, candidateA[name][index]])),
            dots: { reference: Object.fromEntries(Dots_COMPONENTS.map((name) => [name, actualReferenceDots[name][index]])), candidate_a: Object.fromEntries(Dots_COMPONENTS.map((name) => [name, candidateADots[name][index]])), candidate_b: Object.fromEntries(Dots_COMPONENTS.map((name) => [name, candidateBSummaryDots[name][index]])) },
            squares: { reference: Object.fromEntries(SQUARES_COMPONENTS.map((name) => [name, actualReferenceSquares[name][index]])), candidate_a: Object.fromEntries(SQUARES_COMPONENTS.map((name) => [name, candidateASquares[name][index]])), candidate_b: Object.fromEntries(SQUARES_COMPONENTS.map((name) => [name, candidateBSquares[name][index]])) }
          });
          const rainThresholdError = Math.abs(candidateA.rainCoverage[index] - reference.rainCoverage[index]);
          const strongThresholdError = Math.abs(candidateA.strongCoverage[index] - reference.strongCoverage[index]);
          const stormThresholdError = Math.abs(candidateA.stormCoverage[index] - reference.stormCoverage[index]);
          const hailThresholdError = Math.abs(candidateA.hailCoverage[index] - reference.hailCoverage[index]);
          if ((candidateA.rainCoverage[index] > 0) !== (reference.rainCoverage[index] > 0) && mightEnterWorst(worst, 'rain_coverage_threshold_transition', rainThresholdError)) addWorst(worst, 'rain_coverage_threshold_transition', rainThresholdError, makeDetail());
          if ((candidateA.strongCoverage[index] > 0) !== (reference.strongCoverage[index] > 0) && mightEnterWorst(worst, 'strong_coverage_threshold_transition', strongThresholdError)) addWorst(worst, 'strong_coverage_threshold_transition', strongThresholdError, makeDetail());
          if ((candidateA.stormCoverage[index] > 0) !== (reference.stormCoverage[index] > 0) && mightEnterWorst(worst, 'storm_threshold_transition', stormThresholdError)) addWorst(worst, 'storm_threshold_transition', stormThresholdError, makeDetail());
          if ((candidateA.hailCoverage[index] > 0) !== (reference.hailCoverage[index] > 0) && mightEnterWorst(worst, 'hail_threshold_transition', hailThresholdError)) addWorst(worst, 'hail_threshold_transition', hailThresholdError, makeDetail());
          const dotsError = Math.abs(candidateADots.rainRadiusFraction[index] - actualReferenceDots.rainRadiusFraction[index]);
          const squaresError = Math.abs(candidateASquares.finalAlpha[index] - actualReferenceSquares.finalAlpha[index]);
          if (mightEnterWorst(worst, 'dots_presentation', dotsError)) addWorst(worst, 'dots_presentation', dotsError, makeDetail());
          if (mightEnterWorst(worst, 'squares_presentation', squaresError)) addWorst(worst, 'squares_presentation', squaresError, makeDetail());
        }
      }
    }
  }
  const finished = {};
  for (const level of LEVELS) {
    finished[level] = {
      raw_summary: {
        candidate_a: finishMetricSet(results[level].raw_summary.candidate_a),
        unquantized_endpoint_interpolation: finishMetricSet(results[level].raw_summary.unquantized_endpoint_interpolation)
      },
      dots: { candidate_a: finishMetricSet(results[level].dots.candidate_a), candidate_b: finishMetricSet(results[level].dots.candidate_b), visibility_disagreements: results[level].dots.visibility_disagreements },
      squares: { candidate_a: finishMetricSet(results[level].squares.candidate_a), candidate_b: finishMetricSet(results[level].squares.candidate_b) },
      threshold_disagreement_counts: results[level].thresholds,
      float16_vs_temporal: {
        float16_transport: finishMetricSet(results[level].float16_vs_temporal.float16_transport),
        temporal_approximation: finishMetricSet(results[level].float16_vs_temporal.temporal_approximation)
      },
      hazard_mean_omission_proof: results[level].hazard_mean_omission_proof
    };
  }
  const mean = (metricSet) => Object.values(metricSet).reduce((sum, metric) => sum + metric.mean_absolute_error, 0) / Object.keys(metricSet).length;
  const dotsRanking = LEVELS.map((level) => ({ level, candidate_a_mean: mean(finished[level].dots.candidate_a), candidate_b_mean: mean(finished[level].dots.candidate_b) }));
  const squaresRanking = LEVELS.map((level) => ({ level, candidate_a_mean: mean(finished[level].squares.candidate_a), candidate_b_mean: mean(finished[level].squares.candidate_b) }));
  const float16Mean = LEVELS.reduce((sum, level) => sum + mean(finished[level].float16_vs_temporal.float16_transport), 0) / LEVELS.length;
  const temporalMean = LEVELS.reduce((sum, level) => sum + mean(finished[level].float16_vs_temporal.temporal_approximation), 0) / LEVELS.length;
  const output = {
    diagnostic: 'tiled-rain-lod-temporal-fidelity',
    source: { generation_id: manifest.source_generation_id, frame_count: manifest.frame_count, timestamps: manifest.timestamps },
    normal_temporal_keyframe_contract: { loop_seconds: 18, keyframe_seconds: 0.1, temporal_frame_count: TEMPORAL_FRAME_COUNT, terminal_keyframe_included: true, source_mapping: 'normalized time * (frame_count - 1), verified through RealWeatherSequence.prepareFrame' },
    selected_source_intervals: selection.intervals.map((interval) => ({ interval: [interval, interval + 1], reasons: selection.reasons[interval], l12_endpoint_change: selection.endpointChangeStats[interval] })),
    selected_temporal_progresses: PROGRESSES,
    selected_cases: selectedCases,
    levels: finished,
    worst_deterministic_examples: worst,
    tile_invariance: { checks: tileInvariantChecks, status: 'passed', identity: 'global sample indices decoded through half-open 128-sample tile ownership' },
    ranking: {
      dots: { per_level: dotsRanking, closer_candidate_by_mean_absolute_error: Object.fromEntries(dotsRanking.map((value) => [value.level, value.candidate_a_mean <= value.candidate_b_mean ? 'A' : 'B'])) },
      squares: { per_level: squaresRanking, closer_candidate_by_mean_absolute_error: Object.fromEntries(squaresRanking.map((value) => [value.level, value.candidate_a_mean <= value.candidate_b_mean ? 'A' : 'B'])) },
      error_source: { float16_mean_absolute_error: float16Mean, temporal_approximation_mean_absolute_error: temporalMean, dominant: float16Mean > temporalMean ? 'Float16 quantization' : 'temporal approximation' }
    },
    interpretation: 'Measurements only; no architectural PASS/FAIL threshold is applied.'
  };
  if (process.argv.includes('--summary-output')) {
    const short = (metrics) => Object.fromEntries(Object.entries(metrics).map(([name, metric]) => [name, {
      mae: metric.mean_absolute_error, rms: metric.rms_error, p95: metric.p95_absolute_error, p99: metric.p99_absolute_error, max: metric.maximum_absolute_error
    }]));
    const summary = {
      source: output.source,
      selected_intervals: output.selected_source_intervals.map(({ interval, reasons, l12_endpoint_change }) => ({ interval, reasons, l12_endpoint_change })),
      progresses: output.selected_temporal_progresses,
      levels: Object.fromEntries(LEVELS.map((level) => [level, {
        raw_candidate_a: short(output.levels[level].raw_summary.candidate_a),
        dots_candidate_a: short(output.levels[level].dots.candidate_a),
        dots_candidate_b: short(output.levels[level].dots.candidate_b),
        dot_visibility_disagreements: output.levels[level].dots.visibility_disagreements,
        squares_candidate_a: short(output.levels[level].squares.candidate_a),
        squares_candidate_b: short(output.levels[level].squares.candidate_b),
        thresholds: output.levels[level].threshold_disagreement_counts,
        float16_mae: Object.fromEntries(Object.entries(output.levels[level].float16_vs_temporal.float16_transport).map(([name, metric]) => [name, metric.mean_absolute_error])),
        temporal_mae: Object.fromEntries(Object.entries(output.levels[level].float16_vs_temporal.temporal_approximation).map(([name, metric]) => [name, metric.mean_absolute_error]))
      }])),
      tile_invariance: output.tile_invariance,
      ranking: output.ranking,
      worst_scores: Object.fromEntries(Object.entries(output.worst_deterministic_examples).map(([name, values]) => [name, values.map(({ score, level, interval, progress, i, j }) => ({ score, level, interval, progress, i, j }))]))
    };
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  if (process.argv.includes('--compact-output')) {
    const compact = {
      source: output.source,
      selected_source_intervals: output.selected_source_intervals,
      selected_temporal_progresses: output.selected_temporal_progresses,
      levels: Object.fromEntries(LEVELS.map((level) => [level, {
        raw_summary: Object.fromEntries(Object.entries(output.levels[level].raw_summary).map(([kind, metrics]) => [kind, Object.fromEntries(Object.entries(metrics).map(([name, metric]) => [name, {
          mae: metric.mean_absolute_error, rms: metric.rms_error, p95: metric.p95_absolute_error, p99: metric.p99_absolute_error, max: metric.maximum_absolute_error
        }]))])),
        dots: Object.fromEntries(['candidate_a', 'candidate_b'].map((kind) => [kind, Object.fromEntries(Object.entries(output.levels[level].dots[kind]).map(([name, metric]) => [name, {
          mae: metric.mean_absolute_error, p95: metric.p95_absolute_error, p99: metric.p99_absolute_error, max: metric.maximum_absolute_error
        }]))])),
        dot_visibility_disagreements: output.levels[level].dots.visibility_disagreements,
        squares: Object.fromEntries(Object.entries(output.levels[level].squares).map(([kind, metrics]) => [kind, Object.fromEntries(Object.entries(metrics).map(([name, metric]) => [name, {
          mae: metric.mean_absolute_error, p95: metric.p95_absolute_error, p99: metric.p99_absolute_error, max: metric.maximum_absolute_error
        }]))])),
        thresholds: output.levels[level].threshold_disagreement_counts,
        separation: {
          float16: Object.fromEntries(Object.entries(output.levels[level].float16_vs_temporal.float16_transport).map(([name, metric]) => [name, { mae: metric.mean_absolute_error, p99: metric.p99_absolute_error, max: metric.maximum_absolute_error }])),
          temporal: Object.fromEntries(Object.entries(output.levels[level].float16_vs_temporal.temporal_approximation).map(([name, metric]) => [name, { mae: metric.mean_absolute_error, p99: metric.p99_absolute_error, max: metric.maximum_absolute_error }]))
        }
      }])),
      tile_invariance: output.tile_invariance,
      ranking: output.ranking,
      worst_scores: Object.fromEntries(Object.entries(output.worst_deterministic_examples).map(([name, values]) => [name, values.map(({ score, level, interval, progress, i, j }) => ({ score, level, interval, progress, i, j }))]))
    };
    console.log(JSON.stringify(compact, null, 2));
    return;
  }
  console.log(JSON.stringify(output, null, 2));
  console.log('\nInterpretation');
  console.log(`Compared ${selectedCases.length} intermediate source-frame cases across L10-L12 using the existing physical interpolation and GeographicWeatherPyramid reference. Candidate A is compared in summary space; Candidate B interpolates endpoint presentation values. Mean error ranking: Dots ${JSON.stringify(output.ranking.dots.closer_candidate_by_mean_absolute_error)}, Squares ${JSON.stringify(output.ranking.squares.closer_candidate_by_mean_absolute_error)}. Dominant aggregate error source by mean summary-component error: ${output.ranking.error_source.dominant}.`);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
