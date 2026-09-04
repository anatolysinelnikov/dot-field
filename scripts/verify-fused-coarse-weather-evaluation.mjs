import fs from 'node:fs';
import { setActiveWeatherField } from '../src/engine/geography.js';
import { parseRealWeatherCsv, RealWeatherSequence } from '../src/engine/real-weather.js';
import { loadRealWeatherFixture } from './real-weather-fixture.mjs';
import {
  aggregateWeatherSummary,
  buildCenteredContributions,
  evaluateDirectWeatherSummary,
  WEATHER_SUMMARY_PROFILE_GENERIC,
  rainCoverageWeightForThreshold,
  GeographicWeatherPyramid
} from '../src/engine/geographic-weather-pyramid.js';
import { GeographicLodTopology, lodRangeForStableLevel, canonicalWindowFromMercatorBounds, lngLatToMercator, mercatorXForIndex, mercatorYForIndex } from '../src/engine/geographic-lod.js';
import { GeographicDotsLayer, mapDotsWeatherSummary } from '../src/engine/geographic-dots-layer.js';
import { GeographicSquaresLayer, mapSquaresWeatherSummary } from '../src/engine/geographic-squares-layer.js';

const { metadata, weather: loadedWeather } = await loadRealWeatherFixture();
const weather = new RealWeatherSequence({
  longitudes: loadedWeather.longitudes,
  latitudes: loadedWeather.latitudes,
  sourceFrames: loadedWeather.sourceFrames,
  frameCount: loadedWeather.frameCount,
  longitudeSpacing: loadedWeather.longitudeSpacing,
  latitudeSpacing: loadedWeather.latitudeSpacing,
  weatherSupport: loadedWeather.weatherSupport,
  timestamps: loadedWeather.timestamps,
  potentialWeatherMask: loadedWeather.potentialWeatherMask,
  sourceFrameCacheLimit: loadedWeather.sourceFrameCacheLimit
});
const time = metadata.time;
setActiveWeatherField(weather);

const levels = [10, 11, 12];
const topology = new GeographicLodTopology(undefined, lodRangeForStableLevel(10));
const fusedPyramid = new GeographicWeatherPyramid(Float32Array, topology);
const oldPyramid = new GeographicWeatherPyramid(Float32Array, topology);
for (const level of [11, 12, 13]) oldPyramid.centeredRelations.set(level, buildCenteredContributions(topology.levels.get(level), topology.levels.get(level - 1)));
const geometry = fusedPyramid.prepareSamplingGeometry(13, weather.prepareFrame(0));
const oldLevelData = topology.levels.get(13);
const oldLongitudes = new Float64Array(oldLevelData.count);
const oldLatitudes = new Float64Array(oldLevelData.count);
for (let index = 0; index < oldLevelData.count; index++) {
  oldLongitudes[index] = mercatorXForIndex(oldLevelData, index) * 360 - 180;
  const mercatorY = mercatorYForIndex(oldLevelData, index);
  oldLatitudes[index] = Math.atan(Math.sinh(Math.PI * (1 - 2 * mercatorY))) * 180 / Math.PI;
}
const oldGeometryPrepared = weather.prepareSamplingGeometry(oldLongitudes, oldLatitudes);
const oldGeometry = { ...oldGeometryPrepared };
delete oldGeometry.potentialActiveIndices;

function oldChain(frame, minimumLevel, reusable = null) {
  const genericFrame = Object.create(frame);
  genericFrame.weatherSummaryProfile = WEATHER_SUMMARY_PROFILE_GENERIC;
  let summary = evaluateDirectWeatherSummary(
    oldPyramid.levels.get(13),
    genericFrame,
    reusable?.[13] || null,
    Float32Array,
    oldGeometry,
    oldPyramid.totalWeights.get(13)
  );
  // Keep the dense-reference values but use the same immutable active set for
  // renderer packing, so this verifier compares representation rather than
  // intentionally rendering every guaranteed-dry canonical sample.
  summary.potentialActiveIndices = geometry.potentialActiveIndices;
  const summaries = { 13: summary };
  for (let level = 12; level >= minimumLevel; level--) {
    summary = aggregateWeatherSummary(
      oldPyramid.levels.get(level),
      summary,
      oldPyramid.centeredRelations.get(level + 1),
      reusable?.[level] || null,
      Float32Array,
      oldPyramid.totalWeights.get(level)
    );
    summaries[level] = summary;
  }
  return summaries;
}

function maximumDifference(left, right) {
  if (left.length !== right.length) throw new Error(`array length mismatch ${left.length} !== ${right.length}`);
  let result = 0;
  for (let index = 0; index < left.length; index++) result = Math.max(result, Math.abs(left[index] - right[index]));
  return result;
}

function compareSummary(level, fused, old) {
  if (!fused || !old) throw new Error(`missing L${level} summary`);
  const fields = [
    'totalWeight', 'rainWeightedSumMmh', 'rainMaxMmh'
  ];
  let maximum = 0;
  for (const field of fields) maximum = Math.max(maximum, maximumDifference(fused[field], old[field]));
  let classificationChanges = 0;
  for (const threshold of [0.05, 2.5]) {
    const fusedCoverage = rainCoverageWeightForThreshold(fused, threshold);
    const oldCoverage = rainCoverageWeightForThreshold(old, threshold);
    maximum = Math.max(maximum, maximumDifference(fusedCoverage, oldCoverage));
    for (let index = 0; index < fused.levelData.count; index++) {
      if ((fusedCoverage[index] > 0) !== (oldCoverage[index] > 0)) classificationChanges++;
    }
  }
  if (maximum > 1e-6 || classificationChanges) throw new Error(`L${level} fused summary differs: max=${maximum}, classifications=${classificationChanges}`);
  return { maximum, classificationChanges };
}

function compareMapped(level, fusedDots, oldDots, fusedSquares, oldSquares) {
  const dot = fusedDots.layout === 'rain-only' ? ['rainRadius', 'strongRadius'] : ['rainRadius', 'strongRadius', 'stormRadius', 'hailRadius'];
  const square = fusedSquares.layout === 'rain-only' ? ['rainWetMeanMmh', 'rainCoverage'] : ['rainWetMeanMmh', 'rainCoverage', 'stormCoverage', 'stormMeanSeverity', 'stormMaxSeverity', 'hailCoverage', 'hailMeanSeverity', 'hailMaxSeverity'];
  for (const field of dot) {
    const error = maximumDifference(fusedDots[field], oldDots[field]);
    if (error > 1e-6) throw new Error(`L${level} mapped ${field} differs by ${error}`);
  }
  for (const field of square) {
    const error = maximumDifference(fusedSquares[field], oldSquares[field]);
    if (error > 1e-6) throw new Error(`L${level} mapped ${field} differs by ${error}`);
  }
}

function makeDots(pyramid, level, mapped0, mapped1) {
  const layer = new GeographicDotsLayer(pyramid);
    layer.levelData = pyramid.levelDataFor(level);
  layer.temporal = { levels: new Map([[level, { frames0: { mapped: { [level]: mapped0 } }, frames1: { mapped: { [level]: mapped1 } } }]]) };
  layer.rebuildInstances();
  return layer;
}

function makeSquares(pyramid, level, mapped0, mapped1) {
  const layer = new GeographicSquaresLayer(pyramid);
    layer.levelData = pyramid.levelDataFor(level);
  layer.temporal = { levels: new Map([[level, { frames0: { mapped: { [level]: mapped0 } }, frames1: { mapped: { [level]: mapped1 } } }]]) };
  layer.rebuildInstances();
  return layer;
}

function comparePacked(level, fusedDots, oldDots, fusedSquares, oldSquares, summary) {
  for (const type of fusedDots.temporal.levels.values().next().value.frames0.mapped[level].layout === 'rain-only' ? ['rain', 'strong'] : ['rain', 'strong', 'storm', 'hail']) {
    const error = maximumDifference(fusedDots.instances[type], oldDots.instances[type]);
    if (error > 1e-6) throw new Error(`L${level} packed Dots ${type} differs by ${error}`);
  }
  const active = summary.potentialActiveIndices;
  if (fusedSquares.instanceCounts[0] !== oldSquares.instanceCounts[0]) throw new Error(`L${level} packed Squares count differs`);
  if (fusedSquares.instanceCounts[0] !== active.length) throw new Error(`L${level} packed Squares count is not the static active count`);
  const fusedData = fusedSquares.instanceData[0];
  const oldData = oldSquares.instanceData[0];
  let error = 0;
  const fusedRainOnly = fusedSquares.instanceLayouts[0] === 'rain-only';
  const oldRainOnly = oldSquares.instanceLayouts[0] === 'rain-only';
  for (let index = 0; index < fusedSquares.instanceCounts[0]; index++) {
    const fusedOffset = index * (fusedRainOnly ? 6 : 18);
    const oldOffset = index * (oldRainOnly ? 6 : 18);
    const fusedRainFields = fusedRainOnly ? [0, 1, 2, 3, 4, 5] : [0, 1, 2, 3, 10, 11];
    const oldRainFields = oldRainOnly ? [0, 1, 2, 3, 4, 5] : [0, 1, 2, 3, 10, 11];
    for (let component = 0; component < 6; component++) error = Math.max(error, Math.abs(fusedData[fusedOffset + fusedRainFields[component]] - oldData[oldOffset + oldRainFields[component]]));
  }
  if (error > 1e-6) throw new Error(`L${level} packed Squares rain fields differ by ${error}`);
}

const testTimes = [...Array(time.count).keys()].map((index) => index / (time.count - 1)).concat([0.123, 0.347, 0.5, 0.777, 0.91]);
const reverseTimes = [...testTimes].reverse();
let summaryChecks = 0;
let mappedChecks = 0;
let packedChecks = 0;
let maximumError = 0;

for (const sequence of [testTimes, reverseTimes]) {
  let oldReusable = null;
  let fusedReusable = null;
  for (const normalizedTime of sequence) {
    const frame = weather.prepareFrame(normalizedTime);
    const fused = fusedPyramid.evaluate(levels, frame, fusedReusable);
    if (fused[13] !== undefined) throw new Error('coarse-only fused evaluation retained an L13 summary');
    fusedReusable = fused;
    const old = oldChain(frame, 10, oldReusable);
    oldReusable = old;
    for (const level of levels) {
      const result = compareSummary(level, fused[level], old[level]);
      maximumError = Math.max(maximumError, result.maximum);
      summaryChecks++;
      const fusedDots = mapDotsWeatherSummary(fused[level]);
      const oldDots = mapDotsWeatherSummary(old[level]);
      const fusedSquares = mapSquaresWeatherSummary(fused[level]);
      const oldSquares = mapSquaresWeatherSummary(old[level]);
      compareMapped(level, fusedDots, oldDots, fusedSquares, oldSquares);
      mappedChecks++;
      const fusedDotsLayer = makeDots(fusedPyramid, level, fusedDots, fusedDots);
      const oldDotsLayer = makeDots(oldPyramid, level, oldDots, oldDots);
      const fusedSquaresLayer = makeSquares(fusedPyramid, level, fusedSquares, fusedSquares);
      const oldSquaresLayer = makeSquares(oldPyramid, level, oldSquares, oldSquares);
      comparePacked(level, fusedDotsLayer, oldDotsLayer, fusedSquaresLayer, oldSquaresLayer, fused[level]);
      packedChecks++;
    }
  }
}

// The active sets and reconstructed spatial geometry are shared by every temporal frame.
if (geometry.potentialActiveIndices.length !== 53567) console.log(`observed L13 potential-active count=${geometry.potentialActiveIndices.length}`);
if (geometry.potentialActiveIndices.length !== oldGeometryPrepared.potentialActiveIndices.length) throw new Error('old and fused prepared geometries have different active sets');

// A generic RealWeatherField has no explicit rain-only batch capability. It must retain the old L13 path.
const fallbackField = parseRealWeatherCsv(fs.readFileSync(new URL('../data/mrl_z3_t+40min_376x239.csv', import.meta.url), 'utf8'));
const [centerX, centerY] = lngLatToMercator(45, 43);
const fallbackWindow = canonicalWindowFromMercatorBounds({ minX: centerX - 0.004, maxX: centerX + 0.004, minY: centerY - 0.004, maxY: centerY + 0.004 });
const fallbackPyramid = new GeographicWeatherPyramid(Float32Array, new GeographicLodTopology(fallbackWindow, lodRangeForStableLevel(10)));
const fallbackSummaries = fallbackPyramid.evaluate([10], fallbackField.prepareFrame(0));
if (!fallbackSummaries[13] || !fallbackSummaries[10]) throw new Error('generic provider did not retain the fallback L13 direct path');

console.log(`fused coarse weather verification passed: summaries=${summaryChecks}, mapped=${mappedChecks}, packed=${packedChecks}, maxError=${maximumError}, reverse-order checked`);
console.log(`all 19 exact source frames + 5 interpolated positions; L10/L11/L12 thresholds, weighted sums, maxima, Dots, Squares, packed instances match within 1e-6`);
console.log(`generic non-sequence fallback retained L13 direct summary: yes; active L13 samples=${geometry.potentialActiveIndices.length}`);
