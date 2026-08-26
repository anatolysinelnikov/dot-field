import fs from 'node:fs';
import { setActiveWeatherField } from '../src/engine/geography.js';
import { RealWeatherSequence } from '../src/engine/real-weather.js';
import { selectMercatorGridSamples } from '../src/engine/geographic-lod.js';
import { GeographicWeatherPyramid } from '../src/engine/geographic-weather-pyramid.js';
import { GeographicDotsLayer } from '../src/engine/geographic-dots-layer.js';
import { GeographicSquaresLayer } from '../src/engine/geographic-squares-layer.js';
import { GeographicScalarLayer } from '../src/engine/geographic-scalar-layer.js';
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
  const layer = new Layer(new GeographicWeatherPyramid());
  layer.setActive(true);
  layer.setSamples(selectMercatorGridSamples(level).samples, 0);
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

function scalarDigest(state) {
  const indices = representativeIndices(state.raw.rainMmh);
  return valuesAt(state.raw.rainMmh, indices);
}

function textureDigest(values) {
  const indices = [0, values.length >> 1, values.length - 4];
  return indices.map((index) => values[index]);
}

const scalar = new GeographicScalarLayer();
scalar.setActive(true);
scalar.valueTextures = [{ id: 'texture0' }, { id: 'texture1' }];
scalar.updateWeather(0);
pairMatches(scalar.temporal, 0, 'Scalar start');
for (let index = 1; index <= 22; index++) {
  const previousState1 = scalar.temporal.state1;
  const stateDigest = scalarDigest(previousState1);
  const previousValues1 = scalar.textureValues1;
  const valuesDigest = textureDigest(previousValues1);
  const previousTexture1 = scalar.valueTextures[1];
  const time = timeAt(index);
  scalar.updateWeather(time);
  pairMatches(scalar.temporal, time, `Scalar sequential ${index}`);
  check(scalar.temporal.state0 === previousState1 && scalar.temporal.state0.raw.rainMmh !== scalar.temporal.state1.raw.rainMmh, `Scalar sequential ${index} state ownership`);
  check(sameValues(scalarDigest(scalar.temporal.state0), stateDigest), `Scalar sequential ${index} does not mutate promoted values`);
  check(scalar.textureValues0 === previousValues1 && sameValues(textureDigest(scalar.textureValues0), valuesDigest), `Scalar sequential ${index} preserves promoted CPU texture values`);
  check(scalar.valueTextures[0] === previousTexture1 && scalar.texturesDirty[0], `Scalar sequential ${index} preserves promoted GPU texture ownership`);
}
for (const [name, time] of [
  ['large forward scrub', timeAt(127, 0.6)],
  ['backward scrub', timeAt(41, 0.3)],
  ['near end', timeAt(179, 0.6)],
  ['endpoint', 1]
]) {
  scalar.updateWeather(time);
  const expected = pairMatches(scalar.temporal, time, `Scalar ${name}`);
  check(scalar.temporal.state0 && scalar.temporal.state1, `Scalar ${name} state ownership`);
  if (expected.index > 0) check(expected.index !== 0 && scalar.temporal.index !== 0, `Scalar ${name} has no stale initial keyframe`);
}
scalar.setActive(false);
scalar.setActive(true);
const scalarSwitchTime = timeAt(90, 0.5);
scalar.updateWeather(scalarSwitchTime);
pairMatches(scalar.temporal, scalarSwitchTime, 'Scalar reactivation at nonzero time');

for (const Layer of [GeographicDotsLayer, GeographicSquaresLayer]) verifyDiscreteLayer(Layer);

if (failures) process.exitCode = 1;
console.log(failures ? `VERIFICATION FAILED: ${failures}` : 'VERIFICATION PASSED');
