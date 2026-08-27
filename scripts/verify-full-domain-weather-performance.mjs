import fs from 'node:fs';
import { geographicPrepareTemporalSampling, setActiveWeatherField } from '../src/engine/geography.js';
import { RealWeatherSequence } from '../src/engine/real-weather.js';
import {
  aggregateWeatherSummary,
  buildCenteredContributions,
  evaluateDirectWeatherSummary,
  rainCoverageWeightForThreshold,
  GeographicWeatherPyramid
} from '../src/engine/geographic-weather-pyramid.js';
import { GeographicLodTopology, lodRangeForStableLevel, mercatorXForIndex, mercatorYForIndex } from '../src/engine/geographic-lod.js';
import { mapDotsWeatherSummary } from '../src/engine/geographic-dots-layer.js';
import { mapSquaresWeatherSummary } from '../src/engine/geographic-squares-layer.js';

const metadata = JSON.parse(fs.readFileSync(new URL('../data/generated/202608262200/metadata.json', import.meta.url), 'utf8'));
const grid = metadata.spatial_grid;
const time = metadata.time;
const binary = fs.readFileSync(new URL('../data/generated/202608262200/rain.f32', import.meta.url));
const rainFramesMmh = new Float32Array(binary.buffer, binary.byteOffset, binary.byteLength / Float32Array.BYTES_PER_ELEMENT);
const longitudes = Float64Array.from({ length: grid.width }, (_, index) => grid.longitude_start + index * grid.longitude_spacing);
const latitudes = Float64Array.from({ length: grid.height }, (_, index) => grid.latitude_start + index * grid.latitude_spacing);
const weather = new RealWeatherSequence({
  longitudes,
  latitudes,
  rainFramesMmh,
  frameCount: time.count,
  longitudeSpacing: grid.longitude_spacing,
  latitudeSpacing: grid.latitude_spacing,
  timestamps: time.timestamps
});
setActiveWeatherField(weather);

const topology = new GeographicLodTopology(undefined, lodRangeForStableLevel(10));
const optimizedPyramid = new GeographicWeatherPyramid(Float32Array, topology);
const densePyramid = new GeographicWeatherPyramid(Float32Array, topology);
const denseRelations = new Map();
for (let level = 12; level >= 10; level--) denseRelations.set(level + 1, buildCenteredContributions(topology.levels.get(level + 1), topology.levels.get(level)));
const optimizedGeometry = optimizedPyramid.prepareSamplingGeometry(13, weather.prepareFrame(0));
const denseLongitudes = new Float64Array(topology.levels.get(13).count);
const denseLatitudes = new Float64Array(topology.levels.get(13).count);
for (let index = 0; index < topology.levels.get(13).count; index++) {
  const levelData = topology.levels.get(13);
  denseLongitudes[index] = mercatorXForIndex(levelData, index) * 360 - 180;
  const mercatorY = mercatorYForIndex(levelData, index);
  denseLatitudes[index] = Math.atan(Math.sinh(Math.PI * (1 - 2 * mercatorY))) * 180 / Math.PI;
}
const densePreparedGeometry = weather.prepareSamplingGeometry(denseLongitudes, denseLatitudes);
const denseGeometry = { ...densePreparedGeometry };
delete denseGeometry.potentialActiveIndices;

function denseChain(pyramid, frame, minimumLevel) {
  let summary = evaluateDirectWeatherSummary(pyramid.levels.get(13), frame, null, Float32Array, denseGeometry, pyramid.totalWeights.get(13));
  const summaries = { 13: summary };
  for (let level = 12; level >= minimumLevel; level--) {
    summary = aggregateWeatherSummary(
      pyramid.levels.get(level),
      summary,
      denseRelations.get(level + 1),
      null,
      Float32Array,
      pyramid.totalWeights.get(level)
    );
    summaries[level] = summary;
  }
  return summaries;
}

function coarseAndDirect(pyramid, frame) {
  const summaries = pyramid.evaluate([10], frame);
  summaries[13] = pyramid.evaluate([13], frame)[13];
  return summaries;
}

function maxDifference(left, right) {
  let maximum = 0;
  let mismatches = 0;
  for (let index = 0; index < left.length; index++) {
    const difference = Math.abs(left[index] - right[index]);
    if (difference > maximum) maximum = difference;
    if (difference !== 0) mismatches++;
  }
  return { maximum, mismatches };
}

function materializedTemporalReference(frame, geometry) {
  const activeIndices = geometry.potentialActiveIndices;
  const rain0 = frame.preparedSourceFrame(geometry, frame.frame0);
  const rain1 = frame.preparedSourceFrame(geometry, frame.frame1);
  const values = new Float64Array(activeIndices.length);
  for (let activeIndex = 0; activeIndex < activeIndices.length; activeIndex++) {
    values[activeIndex] = rain0[activeIndex] + (rain1[activeIndex] - rain0[activeIndex]) * frame.progress;
  }
  return values;
}

function comparePreparedTemporal(frame, geometry) {
  const temporal = geographicPrepareTemporalSampling(frame, geometry);
  if (!temporal) throw new Error('real sequence did not expose prepared temporal sampling.');
  const expected = materializedTemporalReference(frame, geometry);
  for (let activeIndex = 0; activeIndex < expected.length; activeIndex++) {
    if (temporal(activeIndex) !== expected[activeIndex]) {
      throw new Error(`prepared temporal value differs at active index ${activeIndex}.`);
    }
  }
}

function compareCompactAndDenseGeometry() {
  if (optimizedGeometry.kind !== 'compact-rectangular' || optimizedGeometry.baseIndex) {
    throw new Error('regular sequence geometry is not compact and axis-separable.');
  }
  if (densePreparedGeometry.kind !== 'dense-generic' || !densePreparedGeometry.baseIndex) {
    throw new Error('dense geometry reference was not materialized through the generic path.');
  }
  if (optimizedGeometry.width * optimizedGeometry.height !== densePreparedGeometry.baseIndex.length) {
    throw new Error('compact/dense geometry sample count differs.');
  }
  let activeIndex = 0;
  for (let index = 0; index < densePreparedGeometry.baseIndex.length; index++) {
    const column = index % optimizedGeometry.width;
    const row = (index - column) / optimizedGeometry.width;
    const sourceColumn = optimizedGeometry.sourceColumn[column];
    const sourceRowBase = optimizedGeometry.sourceRowBase[row];
    const compactInside = sourceColumn !== 0xffffffff && sourceRowBase !== 0xffffffff;
    const denseBaseIndex = densePreparedGeometry.baseIndex[index];
    if (compactInside !== (denseBaseIndex !== 0xffffffff)) {
      throw new Error(`compact/dense inside status differs at sample ${index}.`);
    }
    if (compactInside) {
      const compactBaseIndex = sourceRowBase + sourceColumn;
      if (compactBaseIndex !== denseBaseIndex
        || optimizedGeometry.longitudeFraction[column] !== densePreparedGeometry.longitudeFraction[index]
        || optimizedGeometry.latitudeFraction[row] !== densePreparedGeometry.latitudeFraction[index]) {
        throw new Error(`compact/dense lookup differs at sample ${index}.`);
      }
    }
    if (optimizedGeometry.potentialActiveIndices[activeIndex] === index) activeIndex++;
  }
  if (activeIndex !== optimizedGeometry.potentialActiveIndices.length) {
    throw new Error('compact geometry active-index traversal is not row-major.');
  }
  if (optimizedGeometry.potentialActiveIndices.length !== densePreparedGeometry.potentialActiveIndices.length) {
    throw new Error('compact/dense potential-active counts differ.');
  }
  for (let index = 0; index < optimizedGeometry.potentialActiveIndices.length; index++) {
    if (optimizedGeometry.potentialActiveIndices[index] !== densePreparedGeometry.potentialActiveIndices[index]) {
      throw new Error(`compact/dense potential-active index differs at ${index}.`);
    }
  }
  const frame = weather.prepareFrame(0);
  const compactRain = frame.preparedSourceFrame(optimizedGeometry, 0);
  const denseRain = frame.preparedSourceFrame(densePreparedGeometry, 0);
  if (compactRain.length !== denseRain.length) throw new Error('compact/dense prepared rain counts differ.');
  for (let index = 0; index < compactRain.length; index++) {
    if (compactRain[index] !== denseRain[index]) throw new Error(`compact/dense prepared rain differs at ${index}.`);
  }
}

function compareCompactLevelGeometry(level) {
  const levelData = topology.levels.get(level);
  const compact = optimizedPyramid.prepareSamplingGeometry(level, weather.prepareFrame(0));
  const longitudes = new Float64Array(levelData.count);
  const latitudes = new Float64Array(levelData.count);
  for (let index = 0; index < levelData.count; index++) {
    longitudes[index] = mercatorXForIndex(levelData, index) * 360 - 180;
    const mercatorY = mercatorYForIndex(levelData, index);
    latitudes[index] = Math.atan(Math.sinh(Math.PI * (1 - 2 * mercatorY))) * 180 / Math.PI;
  }
  const dense = weather.prepareSamplingGeometry(longitudes, latitudes);
  if (compact.kind !== 'compact-rectangular' || compact.baseIndex || compact.width * compact.height !== levelData.count) {
    throw new Error(`L${level} sequence geometry is not compact rectangular.`);
  }
  if (compact.potentialActiveIndices.length !== dense.potentialActiveIndices.length) {
    throw new Error(`L${level} compact/dense active count differs.`);
  }
  for (let index = 0; index < levelData.count; index++) {
    const column = index % compact.width;
    const row = (index - column) / compact.width;
    const sourceColumn = compact.sourceColumn[column];
    const sourceRowBase = compact.sourceRowBase[row];
    const compactInside = sourceColumn !== 0xffffffff && sourceRowBase !== 0xffffffff;
    const denseBase = dense.baseIndex[index];
    if (compactInside !== (denseBase !== 0xffffffff)) throw new Error(`L${level} inside status differs at ${index}.`);
    if (compactInside && (sourceRowBase + sourceColumn !== denseBase
      || compact.longitudeFraction[column] !== dense.longitudeFraction[index]
      || compact.latitudeFraction[row] !== dense.latitudeFraction[index])) {
      throw new Error(`L${level} lookup differs at ${index}.`);
    }
  }
  for (let index = 0; index < compact.potentialActiveIndices.length; index++) {
    if (compact.potentialActiveIndices[index] !== dense.potentialActiveIndices[index]) {
      throw new Error(`L${level} active index differs at ${index}.`);
    }
  }
}

function compareSummary(level, optimized, dense) {
  const differences = [];
  const compare = (name, left, right) => differences.push([name, maxDifference(left, right)]);
  compare('totalWeight', optimized.totalWeight, dense.totalWeight);
  compare('rainWeightedSumMmh', optimized.rainWeightedSumMmh, dense.rainWeightedSumMmh);
  compare('rainMaxMmh', optimized.rainMaxMmh, dense.rainMaxMmh);
  for (const threshold of [0.05, 2.5]) {
    compare(`rainCoverageWeight@${threshold}`, rainCoverageWeightForThreshold(optimized, threshold), rainCoverageWeightForThreshold(dense, threshold));
  }
  const dots = mapDotsWeatherSummary(optimized);
  const denseDots = mapDotsWeatherSummary(dense);
  for (const name of ['rainRadius', 'strongRadius', 'stormRadius', 'hailRadius']) compare(`Dots.${name}`, dots[name], denseDots[name]);
  const squares = mapSquaresWeatherSummary(optimized);
  const denseSquares = mapSquaresWeatherSummary(dense);
  for (const name of ['rainWetMeanMmh', 'rainCoverage', 'stormCoverage', 'stormMeanSeverity', 'stormMaxSeverity', 'hailCoverage', 'hailMeanSeverity', 'hailMaxSeverity']) compare(`Squares.${name}`, squares[name], denseSquares[name]);
  for (const [name, result] of differences) {
    if (result.maximum > 0) console.log(`L${level} ${name}: maxError=${result.maximum} mismatches=${result.mismatches}`);
    if (result.maximum > 1e-6) throw new Error(`L${level} ${name} differs beyond Float32 tolerance.`);
  }
}

const exactSourceFrameTimes = Array.from({ length: time.count }, (_, index) => index / (time.count - 1));
const interpolatedTimes = [0.123, 0.347, 0.5, 0.777];
const normalizedTimes = [...exactSourceFrameTimes, ...interpolatedTimes];
const temporalBoundaryTimes = [
  ...exactSourceFrameTimes,
  ...Array.from({ length: time.count - 1 }, (_, index) => (index + 0.25) / (time.count - 1)),
  ...Array.from({ length: time.count - 1 }, (_, index) => (index + 0.75) / (time.count - 1)),
  ...interpolatedTimes
];
compareCompactAndDenseGeometry();
for (const level of [10, 11, 12]) compareCompactLevelGeometry(level);
for (const normalizedTime of [...temporalBoundaryTimes, ...temporalBoundaryTimes].reverse()) {
  comparePreparedTemporal(weather.prepareFrame(normalizedTime), optimizedGeometry);
}
if (optimizedGeometry.temporalRainMmh) throw new Error('normal prepared weather evaluation retained temporal rain scratch.');
let totalComparisons = 0;
for (const normalizedTime of normalizedTimes) {
  const frame = weather.prepareFrame(normalizedTime);
  const optimized = coarseAndDirect(optimizedPyramid, frame);
  const dense = denseChain(densePyramid, frame, 10);
  for (const level of [10, 11, 12, 13]) {
    compareSummary(level, optimized[level], dense[level]);
    totalComparisons++;
  }
  console.log(`time=${normalizedTime} sourceFrames=${frame.frame0}/${frame.frame1} progress=${frame.progress}`);
}

const compatibilityBatch = weather.prepareFrame(0.347).samplePreparedBatch(optimizedGeometry);
const compatibilityReference = materializedTemporalReference(weather.prepareFrame(0.347), optimizedGeometry);
if (!compatibilityBatch.every((value, index) => value === compatibilityReference[index])) {
  throw new Error('lazy compatibility temporal batch differs from the prepared temporal capability.');
}
if (compatibilityBatch.byteLength !== optimizedGeometry.potentialActiveIndices.length * Float64Array.BYTES_PER_ELEMENT) {
  throw new Error('lazy compatibility temporal batch has unexpected storage.');
}
delete optimizedGeometry.temporalRainMmh;

for (const normalizedTime of [...exactSourceFrameTimes].reverse()) {
  const frame = weather.prepareFrame(normalizedTime);
  const optimized = coarseAndDirect(optimizedPyramid, frame);
  const dense = denseChain(densePyramid, frame, 10);
  for (const level of [10, 11, 12, 13]) {
    compareSummary(level, optimized[level], dense[level]);
    totalComparisons++;
  }
}

const activeCount = optimizedGeometry.potentialActiveIndices.length;
const zeroCount = optimizedPyramid.levelDataFor(13).count - activeCount;
console.log(`sequence union source mask: ${weather.potentialWeatherMask.reduce((sum, value) => sum + value, 0)} positive source nodes; L13 potentially-active=${activeCount}; guaranteed-dry=${zeroCount}`);
console.log(`dense/sparse comparisons passed: ${totalComparisons} summaries across ${exactSourceFrameTimes.length} exact frames plus ${interpolatedTimes.length} interpolated times in forward and reverse order; all physical and mapped arrays match within 1e-6`);
