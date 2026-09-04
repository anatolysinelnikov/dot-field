import fs from 'node:fs';
import { setActiveWeatherField } from '../src/engine/geography.js';
import { loadRealWeatherFixture } from './real-weather-fixture.mjs';
import { RealWeatherSequence } from '../src/engine/real-weather.js';
import { createWeatherSummary, GeographicWeatherPyramid, WEATHER_SUMMARY_PROFILE_GENERIC } from '../src/engine/geographic-weather-pyramid.js';
import { GeographicLodTopology } from '../src/engine/geographic-lod.js';
import { GeographicDotsLayer, mapDotsWeatherSummary } from '../src/engine/geographic-dots-layer.js';
import { GeographicSquaresLayer, mapSquaresWeatherSummary } from '../src/engine/geographic-squares-layer.js';

const { weather: loadedWeather } = await loadRealWeatherFixture();
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
setActiveWeatherField(weather);
const topology = new GeographicLodTopology(undefined, { minLevel: 13, maxLevel: 14 });
const pyramid = new GeographicWeatherPyramid(Float32Array, topology);
const level = 14;

function check(condition, label) { if (!condition) throw new Error(label); console.log(`PASS ${label}`); }
function mappedBytes(state) { return Object.values(state).reduce((bytes, value) => bytes + (value instanceof Float32Array ? value.byteLength : 0), 0); }
function buildSquares(mapped) {
  const layer = new GeographicSquaresLayer(pyramid); layer.levelData = topology.levelDataFor(level);
  layer.temporal = { levels: new Map([[level, { frames0: { mapped: { [level]: mapped } }, frames1: { mapped: { [level]: mapped } } }]]) };
  layer.rebuildInstances(); return layer;
}
function buildDots(mapped) {
  const layer = new GeographicDotsLayer(pyramid); layer.levelData = topology.levelDataFor(level);
  layer.temporal = { levels: new Map([[level, { frames0: { mapped: { [level]: mapped } }, frames1: { mapped: { [level]: mapped } } }]]) };
  layer.rebuildInstances(); return layer;
}
function genericSummary(storm = 0, hail = 0) {
  const summary = createWeatherSummary(topology.levelDataFor(level), null, Float32Array, null, WEATHER_SUMMARY_PROFILE_GENERIC);
  for (let index = 0; index < summary.levelData.count; index++) {
    summary.totalWeight[index] = 1; summary.rainWeightedSumMmh[index] = index % 3 ? 2 : 0; summary.rainMaxMmh[index] = summary.rainWeightedSumMmh[index];
    summary.rainCoverageWeight[0][index] = summary.rainWeightedSumMmh[index] > 0 ? 1 : 0; summary.rainCoverageWeight[3][index] = summary.rainWeightedSumMmh[index] >= 2.5 ? 1 : 0;
    summary.stormCoverageWeight[index] = storm; summary.stormWeightedSeverity[index] = storm; summary.stormMaxSeverity[index] = storm;
    summary.hailCoverageWeight[index] = hail; summary.hailWeightedSeverity[index] = hail; summary.hailMaxSeverity[index] = hail;
  }
  return summary;
}

const compactSummary = pyramid.evaluate([level], weather.prepareFrame(0.37))[level];
const compactDots = mapDotsWeatherSummary(compactSummary); const compactSquares = mapSquaresWeatherSummary(compactSummary);
check(compactDots.layout === 'rain-only' && !('stormRadius' in compactDots), 'unavailable channels select compact Dots mapping');
check(compactSquares.layout === 'rain-only' && !('stormCoverage' in compactSquares), 'unavailable channels select compact Squares mapping');
const compactLayer = buildSquares(compactSquares);
check(compactLayer.instanceLayouts[0] === 'rain-only' && compactLayer.instanceData[0].length >= compactLayer.instanceCounts[0] * 6, 'unavailable channels select six-float Squares instances');

const zeroDots = mapDotsWeatherSummary(genericSummary()); const zeroSquares = mapSquaresWeatherSummary(genericSummary());
check(zeroDots.layout === 'full' && zeroDots.stormRadius && zeroDots.hailRadius, 'available zero-valued hazards retain full Dots mapping');
check(zeroSquares.layout === 'full' && zeroSquares.stormCoverage && zeroSquares.hailCoverage, 'available zero-valued hazards retain full Squares mapping');
check(buildSquares(zeroSquares).instanceLayouts[0] === 'full', 'available zero-valued hazards retain eighteen-float Squares instances');

const hazardDots = mapDotsWeatherSummary(genericSummary(0.5, 0.8)); const hazardSquares = mapSquaresWeatherSummary(genericSummary(0.5, 0.8));
check(hazardDots.stormRadius.some((value) => value > 0) === false && hazardDots.hailRadius.some((value) => value > 0), 'full Dots keeps hail-over-storm priority');
check(hazardSquares.stormCoverage.some((value) => value > 0) && hazardSquares.hailCoverage.some((value) => value > 0), 'full Squares keeps available hazard statistics');
check(buildDots(hazardDots).counts.hail > 0, 'full Dots hazard packing remains active');
const compactMappedSampleCount = compactSummary.representation === 'packed-direct'
  ? compactSummary.potentialActiveIndices.length : topology.levels.get(level).count;
check(mappedBytes(compactDots) === compactMappedSampleCount * 2 * Float32Array.BYTES_PER_ELEMENT, 'compact Dots mapped bytes scale with packed active samples');
check(mappedBytes(compactSquares) === compactMappedSampleCount * 2 * Float32Array.BYTES_PER_ELEMENT, 'compact Squares mapped bytes scale with packed active samples');
check(mappedBytes(compactDots) * 2 < mappedBytes(zeroDots), 'compact Dots mapped bytes remain below half of dense hazard reference');
check(mappedBytes(compactSquares) * 3 < mappedBytes(zeroSquares), 'compact Squares mapped bytes remain below one third of dense hazard reference');
console.log('RENDERER CHANNEL LAYOUT VERIFICATION PASSED');
