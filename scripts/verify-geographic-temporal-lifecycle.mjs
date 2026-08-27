import fs from 'node:fs';
import { setActiveWeatherField, WEATHER_REGION } from '../src/engine/geography.js';
import { RealWeatherSequence } from '../src/engine/real-weather.js';
import { canonicalWindowFromMercatorBounds, GeographicLodTopology, lngLatToMercator } from '../src/engine/geographic-lod.js';
import { GeographicWeatherPyramid } from '../src/engine/geographic-weather-pyramid.js';
import { GeographicDotsLayer } from '../src/engine/geographic-dots-layer.js';
import { GeographicSquaresLayer } from '../src/engine/geographic-squares-layer.js';
import { TEMPORAL_FRAME_COUNT, geographicTemporalFrameAt } from '../src/engine/geographic-layer-utils.js';

const dataRoot = new URL('../data/generated/202608262200/', import.meta.url);
const metadata = JSON.parse(fs.readFileSync(new URL('metadata.json', dataRoot), 'utf8'));
const binary = fs.readFileSync(new URL('rain.f32', dataRoot));
const { width, height, longitude_start: longitudeStart, latitude_start: latitudeStart, longitude_spacing: longitudeSpacing, latitude_spacing: latitudeSpacing } = metadata.spatial_grid;
const longitudes = Float64Array.from({ length: width }, (_, index) => longitudeStart + index * longitudeSpacing);
const latitudes = Float64Array.from({ length: height }, (_, index) => latitudeStart + index * latitudeSpacing);
const rainFramesMmh = new Float32Array(binary.buffer, binary.byteOffset, binary.byteLength / Float32Array.BYTES_PER_ELEMENT);
const sequence = new RealWeatherSequence({ longitudes, latitudes, rainFramesMmh, frameCount: metadata.time.count, longitudeSpacing, latitudeSpacing, timestamps: metadata.time.timestamps });
setActiveWeatherField(sequence);
const [centerX, centerY] = lngLatToMercator(...WEATHER_REGION.center);
const testWindow = canonicalWindowFromMercatorBounds({ minX: centerX - 0.004, maxX: centerX + 0.004, minY: centerY - 0.004, maxY: centerY + 0.004 });
const testTopology = new GeographicLodTopology(testWindow, { minLevel: 13, maxLevel: 15 });

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`PASS ${message}`);
  else { failures++; console.error(`FAIL ${message}`); }
}

function timeAt(index, progress = 0.25) {
  return (index + progress) / TEMPORAL_FRAME_COUNT;
}

function pairMatches(temporal, time, message) {
  const expected = geographicTemporalFrameAt(time);
  check(temporal.index === expected.index && temporal.nextIndex === expected.nextIndex, `${message} pair indices`);
  return expected;
}

function representativeIndices(values) {
  let maximumIndex = 0;
  for (let index = 1; index < values.length; index++) if (values[index] > values[maximumIndex]) maximumIndex = index;
  return [0, values.length >> 1, maximumIndex];
}

function valuesAt(values, indices) {
  return indices.map((index) => values[index]);
}

function sameValues(values, expected) {
  return values.length === expected.length && values.every((value, index) => value === expected[index]);
}

function discreteDigest(frame, level) {
  const summary = frame.summaries[level];
  const mapped = frame.mapped[level];
  const indices = representativeIndices(summary.rainWeightedSumMmh);
  return {
    summary: valuesAt(summary.rainWeightedSumMmh, indices),
    maximum: valuesAt(summary.rainMaxMmh, indices),
    mapped: valuesAt(mapped.rainRadius || mapped.rainWetMeanMmh, indices)
  };
}

function unchangedDiscrete(frame, level, digest) {
  const current = discreteDigest(frame, level);
  return sameValues(current.summary, digest.summary)
    && sameValues(current.maximum, digest.maximum)
    && sameValues(current.mapped, digest.mapped);
}

function verifyDiscreteLayer(Layer) {
  const level = 13;
  const layer = new Layer(new GeographicWeatherPyramid(Float32Array, testTopology));
  layer.setActive(true);
  layer.setLevelData(testTopology.levelDataFor(level), 0);
  pairMatches(layer.temporal, 0, `${Layer.name} start`);

  for (let index = 1; index <= 22; index++) {
    const state = layer.temporal.levels.get(level);
    const previousNext = state.frames1;
    const digest = discreteDigest(previousNext, level);
    const time = timeAt(index);
    layer.updateWeather(time);
    pairMatches(layer.temporal, time, `${Layer.name} sequential ${index}`);
    const promoted = layer.temporal.levels.get(level);
    check(promoted.frames0.index === index && promoted.frames1.index === index + 1, `${Layer.name} sequential ${index} frame ownership`);
    check(promoted.frames0 === previousNext, `${Layer.name} sequential ${index} promotes prior destination`);
    check(unchangedDiscrete(promoted.frames0, level, digest), `${Layer.name} sequential ${index} does not mutate promoted values`);
  }

  for (const [name, time] of [
    ['large forward scrub', timeAt(127, 0.6)],
    ['backward scrub', timeAt(41, 0.3)],
    ['near end', timeAt(179, 0.6)],
    ['endpoint', 1]
  ]) {
    layer.updateWeather(time);
    const expected = pairMatches(layer.temporal, time, `${Layer.name} ${name}`);
    const state = layer.temporal.levels.get(level);
    check(state.frames0.index === expected.index && state.frames1.index === expected.nextIndex, `${Layer.name} ${name} frame ownership`);
    if (expected.index > 0) check(state.frames0.index !== 0 && state.frames1.index !== 0, `${Layer.name} ${name} has no stale initial keyframe`);
  }

  layer.setActive(false);
  layer.setActive(true);
  const switchTime = timeAt(90, 0.5);
  layer.updateWeather(switchTime);
  pairMatches(layer.temporal, switchTime, `${Layer.name} reactivation at nonzero time`);
}

console.log('Scalar lifecycle checks skipped: Blur/Areas are inactive and their fixed-support lattice is intentionally not allocated for the full-domain sequence.');

for (const Layer of [GeographicDotsLayer, GeographicSquaresLayer]) verifyDiscreteLayer(Layer);

if (failures) process.exitCode = 1;
console.log(failures ? `VERIFICATION FAILED: ${failures}` : 'VERIFICATION PASSED');
