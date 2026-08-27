import fs from 'node:fs';
import { geographicPrepareTemporalSampling, setActiveWeatherField } from '../src/engine/geography.js';
import { RealWeatherSequence } from '../src/engine/real-weather.js';
import {
  aggregateWeatherSummary,
  buildCenteredContributions,
  evaluateDirectWeatherSummary,
  RAIN_COVERAGE_THRESHOLDS_MMH,
  GeographicWeatherPyramid
} from '../src/engine/geographic-weather-pyramid.js';
import { GeographicLodTopology, lodRangeForStableLevel } from '../src/engine/geographic-lod.js';
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
const denseGeometry = { ...optimizedGeometry };
delete denseGeometry.potentialActiveIndices;
delete denseGeometry.potentialWeatherMask;

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

function compareSummary(level, optimized, dense) {
  const differences = [];
  const compare = (name, left, right) => differences.push([name, maxDifference(left, right)]);
  compare('totalWeight', optimized.totalWeight, dense.totalWeight);
  compare('rainWeightedSumMmh', optimized.rainWeightedSumMmh, dense.rainWeightedSumMmh);
  compare('rainMaxMmh', optimized.rainMaxMmh, dense.rainMaxMmh);
  for (let index = 0; index < RAIN_COVERAGE_THRESHOLDS_MMH.length; index++) {
    compare(`rainCoverageWeight@${RAIN_COVERAGE_THRESHOLDS_MMH[index]}`, optimized.rainCoverageWeight[index], dense.rainCoverageWeight[index]);
  }
  for (const name of ['stormCoverageWeight', 'stormWeightedSeverity', 'stormMaxSeverity', 'hailCoverageWeight', 'hailWeightedSeverity', 'hailMaxSeverity']) {
    compare(name, optimized[name], dense[name]);
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
