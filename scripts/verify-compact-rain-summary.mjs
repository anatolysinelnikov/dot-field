import fs from 'node:fs';
import { setActiveWeatherField } from '../src/engine/geography.js';
import { RealWeatherSequence } from '../src/engine/real-weather.js';
import {
  GeographicWeatherPyramid,
  WEATHER_SUMMARY_PROFILE_GENERIC,
  WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY,
  rainCoverageWeightForThreshold
} from '../src/engine/geographic-weather-pyramid.js';
import { GeographicLodTopology } from '../src/engine/geographic-lod.js';
import { mapDotsWeatherSummary } from '../src/engine/geographic-dots-layer.js';
import { mapSquaresWeatherSummary } from '../src/engine/geographic-squares-layer.js';

const metadata = JSON.parse(fs.readFileSync(new URL('../data/generated/202608262200/metadata.json', import.meta.url), 'utf8'));
const grid = metadata.spatial_grid;
const time = metadata.time;
const binary = fs.readFileSync(new URL('../data/generated/202608262200/rain.f32', import.meta.url));
const weather = new RealWeatherSequence({
  longitudes: Float64Array.from({ length: grid.width }, (_, index) => grid.longitude_start + index * grid.longitude_spacing),
  latitudes: Float64Array.from({ length: grid.height }, (_, index) => grid.latitude_start + index * grid.latitude_spacing),
  rainFramesMmh: new Float32Array(binary.buffer, binary.byteOffset, binary.byteLength / 4),
  frameCount: time.count, longitudeSpacing: grid.longitude_spacing, latitudeSpacing: grid.latitude_spacing, timestamps: time.timestamps
});
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
