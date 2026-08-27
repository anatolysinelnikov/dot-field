import fs from 'node:fs';
import { prepareGeographicFieldFrame, setActiveWeatherField, WEATHER_REGION } from '../src/engine/geography.js';
import { GeographicWeatherPyramid, RAIN_COVERAGE_THRESHOLDS_MMH, aggregateWeatherSummary, evaluateDirectWeatherSummary } from '../src/engine/geographic-weather-pyramid.js';
import { mapDotsWeatherSummary } from '../src/engine/geographic-dots-layer.js';
import { mapSquaresWeatherSummary } from '../src/engine/geographic-squares-layer.js';
import { parseRealWeatherCsv } from '../src/engine/real-weather.js';
import { canonicalWindowFromMercatorBounds, GeographicLodTopology, lngLatToMercator } from '../src/engine/geographic-lod.js';

const TOLERANCE = 1e-12;
let failures = 0;
function check(condition, message) {
  if (!condition) {
    failures++;
    console.error(`FAIL ${message}`);
  }
}
function maxError(left, right) {
  let error = 0;
  for (let index = 0; index < left.length; index++) error = Math.max(error, Math.abs(left[index] - right[index]));
  return error;
}
function summaryError(left, right) {
  let error = 0;
  for (const name of ['totalWeight', 'rainWeightedSumMmh', 'rainMaxMmh', 'stormCoverageWeight', 'stormWeightedSeverity', 'stormMaxSeverity', 'hailCoverageWeight', 'hailWeightedSeverity', 'hailMaxSeverity']) {
    error = Math.max(error, maxError(left[name], right[name]));
  }
  for (let threshold = 0; threshold < RAIN_COVERAGE_THRESHOLDS_MMH.length; threshold++) {
    error = Math.max(error, maxError(left.rainCoverageWeight[threshold], right.rainCoverageWeight[threshold]));
  }
  return error;
}
function mappingError(left, right, names) {
  let error = 0;
  for (const name of names) error = Math.max(error, maxError(left[name], right[name]));
  return error;
}

const field = parseRealWeatherCsv(fs.readFileSync(new URL('../data/mrl_z3_t+40min_376x239.csv', import.meta.url), 'utf8'));
setActiveWeatherField(field);
const frame = prepareGeographicFieldFrame(0.347);
const [centerX, centerY] = lngLatToMercator(...WEATHER_REGION.center);
const testWindow = canonicalWindowFromMercatorBounds({ minX: centerX - 0.004, maxX: centerX + 0.004, minY: centerY - 0.004, maxY: centerY + 0.004 });

const points = [
  [field.longitudes[0], field.latitudes[0]],
  [field.longitudes[Math.floor(field.longitudes.length / 2)], field.latitudes[Math.floor(field.latitudes.length / 2)]],
  [field.longitudes.at(-1), field.latitudes.at(-1)],
  [field.longitudes[12] + field.longitudeSpacing * 0.37, field.latitudes[18] + field.latitudeSpacing * 0.63],
  [field.longitudes[12], field.latitudes[18] + field.latitudeSpacing * 0.5],
  [field.longitudes[12] + field.longitudeSpacing * 0.5, field.latitudes[18]],
  [field.bounds.west, field.bounds.north],
  [field.bounds.east, field.bounds.south],
  [field.bounds.west - field.longitudeSpacing, field.bounds.south],
  [field.bounds.east + field.longitudeSpacing, field.bounds.north],
  [field.bounds.west, field.bounds.south - field.latitudeSpacing],
  [field.bounds.east, field.bounds.north + field.latitudeSpacing]
];
const outsidePointStart = 8;
let rainPoint = null;
let stormPoint = null;
let hailPoint = null;
for (let latitudeIndex = 0; latitudeIndex < field.latitudes.length; latitudeIndex++) {
  for (let longitudeIndex = 0; longitudeIndex < field.longitudes.length; longitudeIndex++) {
    const sourceIndex = field.index(longitudeIndex, latitudeIndex);
    const point = [field.longitudes[longitudeIndex], field.latitudes[latitudeIndex]];
    if (!rainPoint && field.rainMmh[sourceIndex] > 0) rainPoint = point;
    if (!stormPoint && field.storm[sourceIndex] > 0) stormPoint = point;
    if (!hailPoint && field.hail[sourceIndex] > 0) hailPoint = point;
  }
}
for (const point of [rainPoint, stormPoint, hailPoint]) if (point) points.push(point);

const longitudes = Float64Array.from(points, ([longitude]) => longitude);
const latitudes = Float64Array.from(points, ([, latitude]) => latitude);
const geometry = field.prepareSamplingGeometry(longitudes, latitudes);
const prepared = { rainMmh: 0, storm: 0, hail: 0 };
let sampleError = 0;
for (let index = 0; index < points.length; index++) {
  const normal = field.sample(longitudes[index], latitudes[index]);
  field.samplePrepared(geometry, index, prepared);
  sampleError = Math.max(sampleError, Math.abs(normal.rainMmh - prepared.rainMmh), Math.abs(normal.storm - prepared.storm), Math.abs(normal.hail - prepared.hail));
}
console.log(`representative prepared-vs-normal error: ${sampleError}`);
check(sampleError <= TOLERANCE, 'prepared samples reproduce normal rain/storm/hail values');

let sourceNodeError = 0;
for (const longitudeIndex of [0, Math.floor(field.longitudes.length / 2), field.longitudes.length - 1]) {
  for (const latitudeIndex of [0, Math.floor(field.latitudes.length / 2), field.latitudes.length - 1]) {
    const index = field.index(longitudeIndex, latitudeIndex);
    const nodeGeometry = field.prepareSamplingGeometry(
      Float64Array.of(field.longitudes[longitudeIndex]),
      Float64Array.of(field.latitudes[latitudeIndex])
    );
    const value = field.samplePrepared(nodeGeometry, 0);
    sourceNodeError = Math.max(sourceNodeError, Math.abs(value.rainMmh - field.rainMmh[index]), Math.abs(value.storm - field.storm[index]), Math.abs(value.hail - field.hail[index]));
  }
}
console.log(`exact source-node prepared error: ${sourceNodeError}`);
check(sourceNodeError <= TOLERANCE, 'prepared source nodes recover exact source values');
for (let index = outsidePointStart; index < 12; index++) {
  check(geometry.baseIndex[index] === 0xffffffff, `outside point ${index} uses the explicit outside marker`);
  field.samplePrepared(geometry, index, prepared);
  check(prepared.rainMmh === 0 && prepared.storm === 0 && prepared.hail === 0, 'outside prepared sample values remain zero');
}
check(field.isSamplingGeometryCompatible(geometry), 'prepared geometry records compatible source axes');
check(!('rainMmh' in geometry) && !('storm' in geometry) && !('hail' in geometry), 'prepared geometry does not cache weather values');
console.log(`batch stencil: ${geometry.baseIndex.length} samples, ${field.samplingGeometryBytes(geometry)} bytes, ${field.samplingGeometryBytes(geometry) / geometry.baseIndex.length} bytes/sample`);

const fullTopology = new GeographicLodTopology(testWindow, { minLevel: 10, maxLevel: 15 });
const pyramid = new GeographicWeatherPyramid(Float64Array, fullTopology);
const preparedSummaries = new Map();
const directSummaryErrors = [];
for (const level of [13, 14, 15]) {
  const levelData = pyramid.levels.get(level);
  const normal = evaluateDirectWeatherSummary(levelData, frame, null, Float64Array);
  const samplingGeometry = pyramid.prepareSamplingGeometry(level, frame);
  const preparedSummary = evaluateDirectWeatherSummary(levelData, frame, null, Float64Array, samplingGeometry);
  preparedSummaries.set(level, preparedSummary);
  const error = summaryError(normal, preparedSummary);
  let coverageMismatches = 0;
  for (let threshold = 0; threshold < RAIN_COVERAGE_THRESHOLDS_MMH.length; threshold++) for (let index = 0; index < normal.levelData.count; index++) {
    if (normal.rainCoverageWeight[threshold][index] !== preparedSummary.rainCoverageWeight[threshold][index]) coverageMismatches++;
  }
  directSummaryErrors.push(error);
  console.log(`L${level} direct summary: samples=${levelData.count}, error=${error}, coverage mismatches=${coverageMismatches}, stencil bytes=${field.samplingGeometryBytes(samplingGeometry)}`);
  check(error <= TOLERANCE && coverageMismatches === 0, `L${level} prepared summary is numerically and categorically identical`);
  const dotsError = mappingError(mapDotsWeatherSummary(normal), mapDotsWeatherSummary(preparedSummary), ['rainRadius', 'strongRadius', 'stormRadius', 'hailRadius']);
  const squaresError = mappingError(mapSquaresWeatherSummary(normal), mapSquaresWeatherSummary(preparedSummary), ['rainWetMeanMmh', 'rainCoverage', 'stormCoverage', 'stormMeanSeverity', 'stormMaxSeverity', 'hailCoverage', 'hailMeanSeverity', 'hailMaxSeverity']);
  console.log(`L${level} renderer mapping errors: Dots=${dotsError}, Squares=${squaresError}`);
  check(dotsError <= TOLERANCE && squaresError <= TOLERANCE, `L${level} renderer mappings are unchanged`);
}
check(pyramid.prepareSamplingGeometry(15, frame) === pyramid.samplingGeometries.get(15), 'same-grid L15 stencil is reused by identity');
check(pyramid.samplingGeometries.size === 3, 'pyramid owns one stencil for each direct level only');

const ordinary = new GeographicWeatherPyramid(Float64Array, fullTopology).evaluate([13], frame)[13];
let aggregate = preparedSummaries.get(13);
let ordinaryAggregate = ordinary;
for (const level of [12, 11, 10]) {
  const relation = pyramid.topologyFor(level + 1).centeredRelationToParent;
  aggregate = aggregateWeatherSummary(pyramid.levels.get(level), aggregate, relation, null, Float64Array);
  ordinaryAggregate = aggregateWeatherSummary(pyramid.levels.get(level), ordinaryAggregate, relation, null, Float64Array);
  const error = summaryError(ordinaryAggregate, aggregate);
  console.log(`L${level} aggregate summary error after prepared L13: ${error}`);
  check(error <= TOLERANCE, `L${level} aggregate remains unchanged`);
}
check(directSummaryErrors.every((error) => error <= TOLERANCE), 'all direct level errors remain within strict tolerance');

const stencilSizes = [13, 14, 15].map((level) => {
  const geometryForLevel = pyramid.samplingGeometries.get(level);
  return `${level}=${field.samplingGeometryBytes(geometryForLevel)}`;
}).join(', ');
console.log(`stencil sizes (bytes): ${stencilSizes}; total=${[13, 14, 15].reduce((sum, level) => sum + field.samplingGeometryBytes(pyramid.samplingGeometries.get(level)), 0)}`);
console.log(failures ? `VERIFICATION FAILED: ${failures}` : 'VERIFICATION PASSED');
if (failures) process.exitCode = 1;
