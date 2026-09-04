import fs from 'node:fs';
import { setActiveWeatherField } from '../src/engine/geography.js';
import { loadRealWeatherFixture } from './real-weather-fixture.mjs';
import {
  GeographicWeatherPyramid,
  WEATHER_SUMMARY_PROFILE_GENERIC,
  WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY,
  rainCoverageWeightForThreshold
} from '../src/engine/geographic-weather-pyramid.js';
import { RealWeatherSequence } from '../src/engine/real-weather.js';
import { GeographicLodTopology } from '../src/engine/geographic-lod.js';
import { mapDotsWeatherSummary } from '../src/engine/geographic-dots-layer.js';
import { mapSquaresWeatherSummary } from '../src/engine/geographic-squares-layer.js';

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
if (weather.prepareFrame(0).weatherSummaryProfile !== WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY) throw new Error('sequence did not explicitly select compact rain-only summary profile');

const topology = new GeographicLodTopology(undefined, { minLevel: 10, maxLevel: 14 });
const compactPyramid = new GeographicWeatherPyramid(Float32Array, topology);
const genericPyramid = new GeographicWeatherPyramid(Float32Array, topology);
const fields = ['totalWeight', 'rainWeightedSumMmh', 'rainMaxMmh'];
const mappedDots = ['rainRadius', 'strongRadius'];
const mappedSquares = ['rainWetMeanMmh', 'rainCoverage'];

function same(left, right, name) {
  if (left.length !== right.length) throw new Error(`${name}: length mismatch`);
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) throw new Error(`${name}: mismatch at ${index}`);
}
function genericFrame(frame) {
  const reference = Object.create(frame);
  reference.weatherSummaryProfile = WEATHER_SUMMARY_PROFILE_GENERIC;
  return reference;
}
function compare(level, compact, generic) {
  if (compact.profile !== WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY || generic.profile !== WEATHER_SUMMARY_PROFILE_GENERIC) throw new Error(`L${level}: incorrect profile`);
  if (compact.representation === 'packed-direct') {
    if (generic.representation !== 'packed-direct' || compact.levelData !== generic.levelData) {
      throw new Error(`L${level}: direct states did not select the same packed representation`);
    }
    for (const field of ['rainMmh']) same(compact.channels[field], generic.channels[field], `L${level}.channels.${field}`);
    same(compact.coverageMasks.rain, generic.coverageMasks.rain, `L${level}.coverageMasks.rain`);
    const compactDots = mapDotsWeatherSummary(compact);
    const genericDots = mapDotsWeatherSummary(generic);
    for (const field of mappedDots) same(compactDots[field], genericDots[field], `L${level}.Dots.${field}`);
    const compactSquares = mapSquaresWeatherSummary(compact);
    const genericSquares = mapSquaresWeatherSummary(generic);
    for (const field of mappedSquares) same(compactSquares[field], genericSquares[field], `L${level}.Squares.${field}`);
    if (compact.potentialActiveIndices.length >= compact.levelData.count) throw new Error(`L${level}: packed direct state did not reduce the active index set`);
    return;
  }
  for (const field of fields) same(compact[field], generic[field], `L${level}.${field}`);
  for (const threshold of [0.05, 2.5]) same(rainCoverageWeightForThreshold(compact, threshold), rainCoverageWeightForThreshold(generic, threshold), `L${level}.coverage@${threshold}`);
  same(compact.potentialActiveIndices, generic.potentialActiveIndices, `L${level}.potentialActiveIndices`);
  for (const field of mappedDots) same(mapDotsWeatherSummary(compact)[field], mapDotsWeatherSummary(generic)[field], `L${level}.Dots.${field}`);
  for (const field of mappedSquares) same(mapSquaresWeatherSummary(compact)[field], mapSquaresWeatherSummary(generic)[field], `L${level}.Squares.${field}`);
  if (mapDotsWeatherSummary(compact).layout !== 'rain-only' || 'stormRadius' in mapDotsWeatherSummary(compact)) throw new Error(`L${level}: compact Dots layout allocated hazards`);
  if (mapSquaresWeatherSummary(compact).layout !== 'rain-only' || 'stormCoverage' in mapSquaresWeatherSummary(compact)) throw new Error(`L${level}: compact Squares layout allocated hazards`);
  if (mapDotsWeatherSummary(generic).layout !== 'full' || mapSquaresWeatherSummary(generic).layout !== 'full') throw new Error(`L${level}: generic zero-hazard reference did not retain full layouts`);
  if ('stormCoverageWeight' in compact || 'hailCoverageWeight' in compact) throw new Error(`L${level}: compact profile allocated hazard fields`);
}

const times = [...Array(time.count).keys()].map((index) => index / (time.count - 1));
for (let index = 0; index < time.count - 1; index++) times.push((index + 0.37) / (time.count - 1));
let compactReusable = null;
let genericReusable = null;
let checks = 0;
for (const traversal of [times, [...times].reverse()]) {
  for (const normalizedTime of traversal) {
    const compact = compactPyramid.evaluate([10, 11, 12, 13], weather.prepareFrame(normalizedTime), compactReusable);
    const generic = genericPyramid.evaluate([10, 11, 12, 13], genericFrame(weather.prepareFrame(normalizedTime)), genericReusable);
    compactReusable = compact;
    genericReusable = generic;
    for (const level of [10, 11, 12, 13]) { compare(level, compact[level], generic[level]); checks++; }
  }
}
const terminalCompact = compactPyramid.evaluate([14], weather.prepareFrame(1));
const terminalGeneric = genericPyramid.evaluate([14], genericFrame(weather.prepareFrame(1)));
compare(14, terminalCompact[14], terminalGeneric[14]);
console.log(`compact rain-summary verification passed: ${checks + 1} exact retained-field and Dots/Squares comparisons; 19 source frames, every interval interpolation, forward/reverse, L10-L14, compact reuse`);
