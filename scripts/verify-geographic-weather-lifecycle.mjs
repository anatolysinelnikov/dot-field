import fs from 'node:fs';
import { setActiveWeatherField } from '../src/engine/geography.js';
import { parseRealWeatherCsv } from '../src/engine/real-weather.js';
import { GeographicLodTopology, selectMercatorGridSamples } from '../src/engine/geographic-lod.js';
import { GeographicWeatherPyramid } from '../src/engine/geographic-weather-pyramid.js';
import { GeographicDotsLayer } from '../src/engine/geographic-dots-layer.js';
import { GeographicSquaresLayer } from '../src/engine/geographic-squares-layer.js';
import { TEMPORAL_FRAME_COUNT, geographicTemporalFrameAt } from '../src/engine/geographic-layer-utils.js';

const FRAME_TIME = 0.347;
const field = parseRealWeatherCsv(fs.readFileSync(new URL('../data/mrl_z3_t+40min_376x239.csv', import.meta.url), 'utf8'));
setActiveWeatherField(field);

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`PASS ${message}`);
  else { failures++; console.error(`FAIL ${message}`); }
}

function makeInstrumentedLayer(Layer) {
  const pyramid = new GeographicWeatherPyramid(Float32Array, new GeographicLodTopology(undefined, { minLevel: 13, maxLevel: 15 }));
  const layer = new Layer(pyramid);
  layer.setActive(true);
  const stats = { evaluations: [], keyframes: [], dotBuilds: 0, packedLevels: [] };
  const evaluate = pyramid.evaluate.bind(pyramid);
  pyramid.evaluate = (...args) => {
    stats.evaluations.push([...new Set(args[0])]);
    return evaluate(...args);
  };
  const evaluateKeyframe = layer.evaluateKeyframe.bind(layer);
  layer.evaluateKeyframe = (...args) => {
    stats.keyframes.push({ level: args[0], index: args[1] });
    return evaluateKeyframe(...args);
  };
  if (Layer === GeographicSquaresLayer) {
    const buildGroup = layer.buildGroup.bind(layer);
    layer.buildGroup = (...args) => {
      stats.packedLevels.push({ group: args[0], level: args[1] });
      return buildGroup(...args);
    };
  } else {
    const rebuildInstances = layer.rebuildInstances.bind(layer);
    layer.rebuildInstances = (...args) => {
      stats.dotBuilds++;
      return rebuildInstances(...args);
    };
  }
  return { layer, pyramid, stats };
}

function resetStats(stats) {
  stats.evaluations.length = 0;
  stats.keyframes.length = 0;
  stats.dotBuilds = 0;
  stats.packedLevels.length = 0;
}

function samples(level) {
  return selectMercatorGridSamples(level).samples;
}

function typedStateEqual(left, right) {
  for (const key of ['rainRadius', 'strongRadius', 'stormRadius', 'hailRadius', 'rainWetMeanMmh', 'rainCoverage', 'stormCoverage', 'stormMeanSeverity', 'stormMaxSeverity', 'hailCoverage', 'hailMeanSeverity', 'hailMaxSeverity']) {
    if (!(key in left) || !(key in right)) continue;
    if (left[key].length !== right[key].length) return false;
    for (let index = 0; index < left[key].length; index++) if (Math.abs(left[key][index] - right[key][index]) > 1e-6) return false;
  }
  return true;
}

function exerciseTransition(Layer, fromLevel, toLevel) {
  const { layer, pyramid, stats } = makeInstrumentedLayer(Layer);
  const fromSamples = samples(fromLevel);
  const toSamples = samples(toLevel);
  layer.setSamples(fromSamples, FRAME_TIME);
  const sourceState = layer.temporal.levels.get(fromLevel);
  const sourceFrames = [sourceState.frames0, sourceState.frames1];
  resetStats(stats);
  layer.setTransition(fromSamples, toSamples, FRAME_TIME, 0);
  const destinationState = layer.temporal.levels.get(toLevel);
  check(stats.evaluations.length === 2 && stats.evaluations.every((levels) => levels.length === 1 && levels[0] === toLevel), `${Layer.name} L${fromLevel}->L${toLevel} evaluates only destination at start`);
  check(stats.keyframes.length === 2 && stats.keyframes.every(({ level }) => level === toLevel), `${Layer.name} L${fromLevel}->L${toLevel} maps only destination at start`);
  check(layer.temporal.levels.get(fromLevel).frames0 === sourceFrames[0] && layer.temporal.levels.get(fromLevel).frames1 === sourceFrames[1], `${Layer.name} retains source temporal states at start`);
  if (Layer === GeographicSquaresLayer) check(stats.packedLevels.length === 1 && stats.packedLevels[0].level === toLevel, `Squares packs only destination group at start`);
  else check(stats.dotBuilds === 1, `Dots builds one transition instance set at start`);

  const fresh = makeInstrumentedLayer(Layer).layer;
  fresh.setSamples(toSamples, FRAME_TIME);
  resetStats(stats);
  layer.setSamples(toSamples, FRAME_TIME);
  check(stats.evaluations.length === 0 && stats.keyframes.length === 0, `${Layer.name} L${fromLevel}->L${toLevel} completion does not evaluate or map`);
  check(layer.temporal.levels.size === 1 && layer.temporal.levels.get(toLevel) === destinationState, `${Layer.name} promotes destination temporal state`);
  check(typedStateEqual(layer.temporal.levels.get(toLevel).frames0.mapped[toLevel], fresh.temporal.levels.get(toLevel).frames0.mapped[toLevel]), `${Layer.name} promoted destination mapping matches fresh stable state`);
  if (Layer === GeographicSquaresLayer) check(stats.packedLevels.length === 0, `Squares promotes destination group without repacking`);
  else check(stats.dotBuilds === 1, `Dots performs only the stable destination instance pass at completion`);
  return { layer, pyramid, stats, fromSamples, toSamples };
}

for (const Layer of [GeographicDotsLayer, GeographicSquaresLayer]) exerciseTransition(Layer, 14, 15);
for (const Layer of [GeographicDotsLayer, GeographicSquaresLayer]) exerciseTransition(Layer, 13, 14);

for (const Layer of [GeographicDotsLayer, GeographicSquaresLayer]) {
  const { layer, stats } = makeInstrumentedLayer(Layer);
  const fromSamples = samples(14);
  const toSamples = samples(15);
  layer.setSamples(fromSamples, FRAME_TIME);
  layer.setTransition(fromSamples, toSamples, FRAME_TIME, 0.4);
  const states = [layer.temporal.levels.get(14), layer.temporal.levels.get(15)];
  resetStats(stats);
  layer.setTransition(toSamples, fromSamples, FRAME_TIME, 0.6);
  check(stats.evaluations.length === 0 && stats.keyframes.length === 0, `${Layer.name} reversal reuses both prepared levels`);
  check(layer.temporal.levels.get(14) === states[0] && layer.temporal.levels.get(15) === states[1], `${Layer.name} reversal preserves both temporal state objects`);
  if (Layer === GeographicSquaresLayer) check(stats.packedLevels.length === 0, 'Squares reversal reuses both packed groups');
  else check(stats.dotBuilds === 1, 'Dots reversal rebuilds only renderer-specific pair orientation');

  for (const progress of [0.2, 0.8, 0.1]) {
    resetStats(stats);
    const reverseFrom = progress === 0.2 ? fromSamples : (progress === 0.8 ? toSamples : fromSamples);
    const reverseTo = progress === 0.2 ? toSamples : (progress === 0.8 ? fromSamples : toSamples);
    layer.setTransition(reverseFrom, reverseTo, FRAME_TIME, progress);
    check(stats.evaluations.length === 0 && stats.keyframes.length === 0, `${Layer.name} repeated reversal ${progress} keeps temporal states`);
  }
}

for (const Layer of [GeographicDotsLayer, GeographicSquaresLayer]) {
  const { layer, stats } = makeInstrumentedLayer(Layer);
  const fromSamples = samples(14);
  const toSamples = samples(15);
  layer.setSamples(fromSamples, FRAME_TIME);
  layer.setTransition(fromSamples, toSamples, FRAME_TIME, 0.2);
  const oldFrames = new Map([...layer.temporal.levels].map(([level, state]) => [level, state.frames1]));
  const current = geographicTemporalFrameAt(FRAME_TIME);
  const rolloverTime = (current.index + 1.25) / TEMPORAL_FRAME_COUNT;
  resetStats(stats);
  layer.updateWeather(rolloverTime);
  check(stats.evaluations.length === 2 && stats.evaluations.every((levels) => levels.length === 1), `${Layer.name} temporal rollover evaluates each active level once`);
  check([...layer.temporal.levels].every(([level, state]) => state.frames0 === oldFrames.get(level) && state.frames0.index === current.index + 1), `${Layer.name} temporal rollover promotes previous next frame`);
  check(layer.temporal.levels.get(14).frames1.index === (current.index + 2) % TEMPORAL_FRAME_COUNT && layer.temporal.levels.get(15).frames1.index === (current.index + 2) % TEMPORAL_FRAME_COUNT, `${Layer.name} temporal rollover prepares only the next future frame`);
  resetStats(stats);
  layer.setTransition(toSamples, fromSamples, rolloverTime, 0.7);
  check(stats.evaluations.length === 0 && stats.keyframes.length === 0, `${Layer.name} immediate post-rollover reversal reuses current states`);
  resetStats(stats);
  layer.setSamples(fromSamples, rolloverTime);
  check(stats.evaluations.length === 0 && stats.keyframes.length === 0, `${Layer.name} post-rollover completion promotes without stale-state rebuild`);
  layer.setActive(false);
  check(layer.temporal === null, `${Layer.name} releases temporal state while inactive`);
}

if (failures) process.exitCode = 1;
console.log(failures ? `VERIFICATION FAILED: ${failures}` : 'VERIFICATION PASSED');
