import fs from 'node:fs';
import { loadRealWeatherFixture } from './real-weather-fixture.mjs';
import { setActiveWeatherField, prepareGeographicFieldFrame } from '../src/engine/geography.js';
import { GeographicDotsLayer, mapDotsWeatherSummary } from '../src/engine/geographic-dots-layer.js';
import { GeographicSquaresLayer, mapSquaresWeatherSummary } from '../src/engine/geographic-squares-layer.js';
import { canonicalCoordinatesForIndex, GeographicLodTopology, canonicalWindowFromMercatorBounds, lngLatToMercator, mercatorToLngLat, mercatorXForIndex, mercatorYForIndex } from '../src/engine/geographic-lod.js';
import { GeographicWeatherPyramid, rainCoverageWeightForThreshold } from '../src/engine/geographic-weather-pyramid.js';

const { metadata, weather: sequence, sourceFrames } = await loadRealWeatherFixture();
const grid = metadata.spatial_grid;
const longitudes = sequence.longitudes;
const latitudes = sequence.latitudes;
setActiveWeatherField(sequence);

const sourceX = 846;
const sourceY = 977;
const frameIndex = 0;
const cropX = sourceX - metadata.spatial_grid.source_crop_indices.x_start;
const cropY = sourceY - metadata.spatial_grid.source_crop_indices.y_start;
const sourceValue = sourceFrames.get(frameIndex)[cropY * grid.width + cropX];
const sourceLongitude = longitudes[cropX];
const sourceLatitude = latitudes[cropY];
const frame = prepareGeographicFieldFrame(0);
const direct = frame.sample(sourceLongitude, sourceLatitude, {});
const geometry = frame.prepareSamplingGeometry(Float64Array.of(sourceLongitude), Float64Array.of(sourceLatitude));
const prepared = frame.samplePrepared(geometry, 0, {});

const [targetX, targetY] = lngLatToMercator(sourceLongitude, sourceLatitude);
const visibleBounds = {
  minX: 0.5693850101236251,
  maxX: 0.6186149907240839,
  minY: 0.21793174334541987,
  maxY: 0.24485210713543024
};
const canonicalWindow = canonicalWindowFromMercatorBounds(visibleBounds);
const topology = new GeographicLodTopology(canonicalWindow, { minLevel: 12, maxLevel: 14 });
const pyramid = new GeographicWeatherPyramid(Float64Array, topology);
const summary = pyramid.evaluate([13], frame)[13];
const nearest = Array.from({ length: summary.levelData.count }, (_, index) => index).reduce((best, index) => {
  const distance = Math.hypot(mercatorXForIndex(summary.levelData, index) - targetX, mercatorYForIndex(summary.levelData, index) - targetY);
  return !best || distance < best.distance ? { index, distance } : best;
}, null);
const nearestCoordinates = canonicalCoordinatesForIndex(summary.levelData, nearest.index);
const step = 2 ** (15 - summary.level);
const local = Array.from({ length: summary.levelData.count }, (_, index) => index).filter((index) => {
  const coordinates = canonicalCoordinatesForIndex(summary.levelData, index);
  return Math.abs(coordinates.canonicalX - nearestCoordinates.canonicalX) <= step * 2
    && Math.abs(coordinates.canonicalY - nearestCoordinates.canonicalY) <= step * 2;
});
const localCounts = {
  positive: local.filter((index) => summary.rainWeightedSumMmh[index] > 0).length,
  atLeast005: local.filter((index) => rainCoverageWeightForThreshold(summary, 0.05)[index] > 0).length,
  atLeast25: local.filter((index) => rainCoverageWeightForThreshold(summary, 2.5)[index] > 0).length,
  atLeast5: local.filter((index) => summary.rainMaxMmh[index] >= 5).length
};

const dots = new GeographicDotsLayer(pyramid);
dots.setActive(true);
dots.setLevelData(topology.levelDataFor(13), 0);
const dotsSummary = dots.temporal.levels.get(13).frames0.summaries[13];
const dotsMapped = mapDotsWeatherSummary(dotsSummary);
const dotsLocal = local;
const dotsRainInstances = dotsLocal.filter((index) => dotsMapped.rainRadius[index] > 0).length;
const dotsStrongInstances = dotsLocal.filter((index) => dotsMapped.strongRadius[index] > 0).length;

const squares = new GeographicSquaresLayer(pyramid);
squares.setActive(true);
squares.setLevelData(topology.levelDataFor(13), 0);
const squaresMapped = mapSquaresWeatherSummary(squares.temporal.levels.get(13).frames0.summaries[13]);
const squaresRainInstances = dotsLocal.filter((index) => squaresMapped.rainCoverage[index] > 0).length;

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`);
  console.log(`PASS ${message}`);
}

assert(Math.abs(sourceValue - 5.837427139282227) <= 1e-6, `frame 0 source x=${sourceX}, y=${sourceY} is ${sourceValue} mm/h in its independent Float32 asset`);
assert(Math.abs(direct.rainMmh - sourceValue) <= 1e-6, 'direct sequence sampling preserves the northern source node');
assert(Math.abs(prepared.rainMmh - direct.rainMmh) <= 1e-12, 'prepared sequence sampling matches direct sampling');
assert(targetX >= visibleBounds.minX && targetX <= visibleBounds.maxX && targetY >= visibleBounds.minY && targetY <= visibleBounds.maxY, 'northern source lies inside the recorded visible Mercator bounds');
assert(targetX * 2 ** 15 >= canonicalWindow.minX && targetX * 2 ** 15 <= canonicalWindow.maxX && targetY * 2 ** 15 >= canonicalWindow.minY && targetY * 2 ** 15 <= canonicalWindow.maxY, 'northern source lies inside the recorded active canonical window');
const nearestLngLat = mercatorToLngLat(mercatorXForIndex(summary.levelData, nearest.index), mercatorYForIndex(summary.levelData, nearest.index));
assert(summary.level === 13 && summary.rainWeightedSumMmh[nearest.index] > 5 && summary.rainMaxMmh[nearest.index] > 5, `nearest L13 sample ${nearestCoordinates.canonicalX}:${nearestCoordinates.canonicalY} reconstructs strong rain`);
assert(localCounts.positive > 0 && localCounts.atLeast005 > 0 && localCounts.atLeast25 > 0 && localCounts.atLeast5 > 0, `L13 local neighborhood retains compact rain thresholds ${JSON.stringify(localCounts)}`);
assert(dotsRainInstances > 0 && dotsStrongInstances > 0, `Dots maps and retains northern rain (${dotsRainInstances}) and strong rain (${dotsStrongInstances}) instances`);
assert(squaresRainInstances > 0, `Squares retains ${squaresRainInstances} northern rain instances`);
console.log(JSON.stringify({ source: { x: sourceX, y: sourceY, lon: sourceLongitude, lat: sourceLatitude, frame: frameIndex, mmh: sourceValue }, canonicalWindow, nearest: { id: `${nearestCoordinates.canonicalX}:${nearestCoordinates.canonicalY}`, canonicalX: nearestCoordinates.canonicalX, canonicalY: nearestCoordinates.canonicalY, lngLat: nearestLngLat, rainMmh: summary.rainWeightedSumMmh[nearest.index] }, localCounts, dots: { rainInstances: dotsRainInstances, strongInstances: dotsStrongInstances, rainRadius: dotsMapped.rainRadius[nearest.index], strongRadius: dotsMapped.strongRadius[nearest.index] }, squares: { rainInstances: squaresRainInstances, rainWetMeanMmh: squaresMapped.rainWetMeanMmh[nearest.index], rainCoverage: squaresMapped.rainCoverage[nearest.index] } }, null, 2));
