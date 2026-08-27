import fs from 'node:fs';
import { setActiveWeatherField } from '../src/engine/geography.js';
import { RealWeatherSequence } from '../src/engine/real-weather.js';
import {
  aggregateWeatherSummary,
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
      pyramid.contributions.get(level + 1),
      null,
      Float32Array,
      pyramid.totalWeights.get(level)
    );
    summaries[level] = summary;
  }
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
let totalComparisons = 0;
for (const normalizedTime of normalizedTimes) {
  const frame = weather.prepareFrame(normalizedTime);
  const optimized = optimizedPyramid.evaluate([10], frame);
  const dense = denseChain(densePyramid, frame, 10);
  for (const level of [10, 11, 12, 13]) {
    compareSummary(level, optimized[level], dense[level]);
    totalComparisons++;
  }
  console.log(`time=${normalizedTime} sourceFrames=${frame.frame0}/${frame.frame1} progress=${frame.progress}`);
}

for (const normalizedTime of [...exactSourceFrameTimes].reverse()) {
  const frame = weather.prepareFrame(normalizedTime);
  const optimized = optimizedPyramid.evaluate([10], frame);
  const dense = denseChain(densePyramid, frame, 10);
  for (const level of [10, 11, 12, 13]) {
    compareSummary(level, optimized[level], dense[level]);
    totalComparisons++;
  }
}

const activeCount = optimizedGeometry.potentialActiveIndices.length;
const zeroCount = optimizedPyramid.samplesFor(13).length - activeCount;
console.log(`sequence union source mask: ${weather.potentialWeatherMask.reduce((sum, value) => sum + value, 0)} positive source nodes; L13 potentially-active=${activeCount}; guaranteed-dry=${zeroCount}`);
console.log(`dense/sparse comparisons passed: ${totalComparisons} summaries across ${exactSourceFrameTimes.length} exact frames plus ${interpolatedTimes.length} interpolated times in forward and reverse order; all physical and mapped arrays match within 1e-6`);
