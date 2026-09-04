import { loadRealWeatherFixture } from './real-weather-fixture.mjs';
import { setActiveWeatherField } from '../src/engine/geography.js';
import { GeographicDotsLayer, mapDotsWeatherSummary } from '../src/engine/geographic-dots-layer.js';
import { canonicalCoordinatesForIndex, canonicalIndexForCoordinates, GeographicLodTopology, lngLatToMercator, mercatorXForIndex, mercatorYForIndex } from '../src/engine/geographic-lod.js';
import { evaluateDirectWeatherSummary, GeographicWeatherPyramid } from '../src/engine/geographic-weather-pyramid.js';
import { RealWeatherSequence } from '../src/engine/real-weather.js';

const STORM_CODES = new Set([10, 11, 12]);
const HAIL_SEVERITIES = [0.2776807, 0.48975, 0.7018193];
const { weather } = await loadRealWeatherFixture();
setActiveWeatherField(weather);

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`);
  console.log(`PASS ${message}`);
}

function activePosition(summary, index) {
  const active = summary.potentialActiveIndices;
  if (!active) return index;
  for (let position = 0; position < active.length; position++) if (active[position] === index) return position;
  return -1;
}

function makeDotsLayer(pyramid, level, mapped) {
  const layer = new GeographicDotsLayer(pyramid);
  layer.levelData = pyramid.levelDataFor(level);
  layer.temporal = { levels: new Map([[level, {
    frames0: { mapped: { [level]: mapped } },
    frames1: { mapped: { [level]: mapped } }
  }]]) };
  layer.rebuildInstances();
  return layer;
}

const frame = weather.prepareFrame(0);
const topology = new GeographicLodTopology(undefined, { minLevel: 13, maxLevel: 14 });
const pyramid = new GeographicWeatherPyramid(Float32Array, topology);
const summaries = pyramid.evaluate([13, 14], frame);
const mapped13 = mapDotsWeatherSummary(summaries[13]);
const mapped14 = mapDotsWeatherSummary(summaries[14]);
const l13Data = topology.levelDataFor(13);
const l14Data = topology.levelDataFor(14);

const sourcePhenomena = weather.phenomenaFrames.get(0);
const sourceStormIndex = sourcePhenomena.findIndex((code) => STORM_CODES.has(code));
const sourceX = sourceStormIndex % weather.longitudes.length;
const sourceY = Math.floor(sourceStormIndex / weather.longitudes.length);
const sourceLongitude = weather.longitudes[sourceX];
const sourceLatitude = weather.latitudes[sourceY];
const sourceSample = frame.sample(sourceLongitude, sourceLatitude, {});
assert(sourceSample.storm > 0, `source code ${sourcePhenomena[sourceStormIndex]} maps to non-zero storm at ${sourceLongitude},${sourceLatitude}`);

const [sourceMercatorX, sourceMercatorY] = lngLatToMercator(sourceLongitude, sourceLatitude);
let l13Index = -1;
let nearestDistance = Number.POSITIVE_INFINITY;
for (let index = 0; index < l13Data.count; index++) {
  if (!(mapped13.stormRadius[index] > 0)) continue;
  const distance = Math.hypot(mercatorXForIndex(l13Data, index) - sourceMercatorX, mercatorYForIndex(l13Data, index) - sourceMercatorY);
  if (distance < nearestDistance) { nearestDistance = distance; l13Index = index; }
}
assert(l13Index >= 0, 'L13 summary retains a storm sample near a known source thunderstorm');
const l13Coordinates = canonicalCoordinatesForIndex(l13Data, l13Index);
const l14Index = canonicalIndexForCoordinates(l14Data, l13Coordinates.canonicalX, l13Coordinates.canonicalY);
const l14Position = activePosition(summaries[14], l14Index);
assert(l14Index >= 0 && l14Position >= 0, 'corresponding L14 canonical sample remains in the potential-active set');
assert(summaries[13].stormWeightedSeverity[l13Index] > 0, 'L13 physical storm summary is non-zero');
assert(summaries[14].channels.storm[l14Position] > 0, 'L14 packed-direct physical storm channel is non-zero');
assert(mapped13.stormRadius[l13Index] > 0, 'L13 Dots mapping produces a visible storm radius');
assert(mapped14.stormRadius instanceof Float32Array, 'L14 Dots mapping preserves the packed storm-radius array');
assert(mapped14.stormRadius[l14Position] > 0, 'L14 Dots mapping produces a visible storm radius');

const denseGeometry = pyramid.prepareSamplingGeometry(14, frame);
const denseReferenceGeometry = { ...denseGeometry };
delete denseReferenceGeometry.potentialActiveIndices;
const denseSummary = evaluateDirectWeatherSummary(l14Data, frame, null, Float32Array, denseReferenceGeometry);
assert(denseSummary.stormWeightedSeverity[l14Index] > 0, 'L14 dense direct reconstruction also retains storm');
assert(Math.abs(denseSummary.rainWeightedSumMmh[l14Index] - summaries[14].channels.rainMmh[l14Position]) <= 1e-6, 'L14 packed/direct rain output is unchanged');
const rainBeforeMapping = new Float32Array(summaries[14].channels.rainMmh);
mapDotsWeatherSummary(summaries[14]);
assert(rainBeforeMapping.every((value, index) => value === summaries[14].channels.rainMmh[index]), 'hazard mapping does not alter L14 rain data');

const dots = makeDotsLayer(pyramid, 14, mapped14);
assert(dots.counts.storm > 0, `L14 Dots builds ${dots.counts.storm} storm instances`);
const stormCountBeforeHazardsOff = dots.counts.storm;
dots.setHazardsVisible(false);
assert(!dots.hazardsVisible && dots.counts.storm === stormCountBeforeHazardsOff, 'Hazards off suppresses the hazard render pass without changing physical/instance data');

const zeroRainPosition = [...sourcePhenomena].findIndex((code, index) => STORM_CODES.has(code) && weather.sourceFrames.get(0)[index] === 0);
assert(zeroRainPosition >= 0, 'current generation contains a phenomenon-only zero-rain storm source node');
const zeroRainX = zeroRainPosition % weather.longitudes.length;
const zeroRainY = Math.floor(zeroRainPosition / weather.longitudes.length);
const zeroRainSample = frame.sample(weather.longitudes[zeroRainX], weather.latitudes[zeroRainY], {});
assert(zeroRainSample.rainMmh === 0 && zeroRainSample.storm > 0, 'phenomenon-only source sample has zero rain and non-zero storm');
const zeroRainGeometry = pyramid.prepareSamplingGeometry(14, frame);
const zeroRainActive = zeroRainGeometry.potentialActiveIndices.some((index) => {
  const sample = frame.samplePrepared(zeroRainGeometry, index, {});
  return sample.rainMmh === 0 && sample.storm > 0;
});
assert(zeroRainActive, 'phenomenon-only zero-rain samples remain active at L14');

const synthetic = new RealWeatherSequence({
  longitudes: Float64Array.of(0, 1),
  latitudes: Float64Array.of(0, 1),
  sourceFrames: new Map([[0, new Float32Array(4)], [1, new Float32Array(4)]]),
  phenomenaFrames: new Map([[0, Uint8Array.of(13, 14, 15, 0)], [1, Uint8Array.of(13, 14, 15, 0)]]),
  phenomenaAvailable: true,
  frameCount: 2,
  longitudeSpacing: 1,
  latitudeSpacing: 1,
  weatherSupport: { west: 0, east: 1, south: 0, north: 1 },
  timestamps: ['t0', 't1'],
  potentialWeatherMask: Uint8Array.of(1, 1, 1, 1),
  retainAllSourceFrames: true
});
const syntheticHail = synthetic.prepareFrame(0);
const hailSamples = [
  syntheticHail.sample(0, 0, {}).hail,
  syntheticHail.sample(1, 0, {}).hail,
  syntheticHail.sample(0, 1, {}).hail,
  syntheticHail.sample(1, 1, {}).hail
];
for (let index = 0; index < HAIL_SEVERITIES.length; index++) assert(Math.abs(hailSamples[index] - HAIL_SEVERITIES[index]) <= 1e-7, `synthetic hail code ${13 + index} follows the categorical hazard channel`);
assert(hailSamples[3] === 0, 'synthetic non-hail code produces no hail');
assert(l13Coordinates.canonicalX === (l13Data.minI + l13Index % l13Data.width) * l13Data.identityScale
  && l13Coordinates.canonicalY === (l13Data.minJ + Math.floor(l13Index / l13Data.width)) * l13Data.identityScale, 'L13 canonical identity is unchanged');
console.log(JSON.stringify({
  source: { code: sourcePhenomena[sourceStormIndex], longitude: sourceLongitude, latitude: sourceLatitude, rainMmh: sourceSample.rainMmh },
  l13: { index: l13Index, storm: summaries[13].stormWeightedSeverity[l13Index], stormRadius: mapped13.stormRadius[l13Index] },
  l14: { index: l14Index, position: l14Position, storm: summaries[14].channels.storm[l14Position], stormRadius: mapped14.stormRadius[l14Position], instances: dots.counts.storm },
  zeroRain: { longitude: weather.longitudes[zeroRainX], latitude: weather.latitudes[zeroRainY], code: sourcePhenomena[zeroRainPosition] },
  hailSamples
}, null, 2));
console.log('real phenomena L14 Dots regression verification passed');
