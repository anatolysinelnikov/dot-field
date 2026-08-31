import fs from 'node:fs';
import { parseRealWeatherCsv } from '../src/engine/real-weather.js';
import { setActiveWeatherField } from '../src/engine/geography.js';
import { canonicalWindowFromMercatorBounds, GeographicLodTopology, lngLatToMercator } from '../src/engine/geographic-lod.js';
import { GeographicWeatherPyramid } from '../src/engine/geographic-weather-pyramid.js';
import { GeographicDotsLayer } from '../src/engine/geographic-dots-layer.js';
import { GeographicSquaresLayer } from '../src/engine/geographic-squares-layer.js';
import { GPU_WEATHER_LEVELS } from '../src/engine/geographic-gpu-weather-presentation.js';

const GPU_LEVEL = 14;
setActiveWeatherField(parseRealWeatherCsv(fs.readFileSync(new URL('../data/mrl_z3_t+40min_376x239.csv', import.meta.url), 'utf8')));
const [centerX, centerY] = lngLatToMercator(45.03, 43.35);
const firstWindow = canonicalWindowFromMercatorBounds({
  minX: centerX - 0.004,
  maxX: centerX + 0.004,
  minY: centerY - 0.004,
  maxY: centerY + 0.004
});
const shiftedWindow = canonicalWindowFromMercatorBounds({
  minX: centerX + 0.006,
  maxX: centerX + 0.014,
  minY: centerY - 0.002,
  maxY: centerY + 0.006
});

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`PASS ${message}`);
  else { failures++; console.error(`FAIL ${message}`); }
}

function source(topology, levelData) {
  const textureA = {};
  const textureB = {};
  const resource = { disposed: false, dispose() { this.disposed = true; } };
  return {
    topology,
    levelData,
    kind: levelData.level <= 12 ? 'summary' : 'physical',
    textureA,
    textureB,
    coverageTextureA: levelData.level <= 12 ? {} : textureA,
    coverageTextureB: levelData.level <= 12 ? {} : textureB,
    width: levelData.width,
    height: levelData.height,
    format: 'R16F',
    resource
  };
}

function topologyFor(window) {
  return new GeographicLodTopology(window, { minLevel: 10, maxLevel: 14 });
}

class StableGpuLifecycleScenario {
  constructor() {
    this.pyramid = new GeographicWeatherPyramid(Float32Array, topologyFor(firstWindow));
    this.dots = new GeographicDotsLayer(this.pyramid);
    this.squares = new GeographicSquaresLayer(this.pyramid);
    this.dots.setGpuWeatherMode(true);
    this.squares.setGpuWeatherMode(true);
    this.active = null;
    this.pending = null;
    this.stableCommittedSourcelessSamples = 0;
  }

  assertStable(label) {
    const active = this.active;
    const sources = [this.dots.gpuWeatherSource, this.squares.gpuWeatherSource];
    const sourceIsCoherent = Boolean(active && sources[0] && sources[0] === sources[1]
      && sources[0].topology === this.pyramid.topology
      && sources[0].levelData === active.levelData
      && sources[0].levelData?.level === active.level
      && this.dots.isGpuWeatherSourceCompatible(sources[0])
      && this.squares.isGpuWeatherSourceCompatible(sources[1]));
    if (!sourceIsCoherent) this.stableCommittedSourcelessSamples++;
    check(this.stableCommittedSourcelessSamples === 0, `${label} stableCommittedSourcelessSamples == 0`);
    check(Boolean(active && sources[0] && sources[0] === sources[1]), `${label} has one shared committed source identity`);
    check(sources[0]?.topology === this.pyramid.topology, `${label} source topology matches committed topology`);
    check(sources[0]?.levelData === active?.levelData, `${label} source level-data matches committed level data`);
    check(sources[0]?.levelData?.level === active?.level, `${label} source level matches committed level`);
    check(sources[0]?.resource?.disposed === false, `${label} committed source resources remain owned`);
    check(this.dots.levelData === active?.levelData && this.squares.levelData === active?.levelData, `${label} both renderers share committed level data`);
    check(!this.dots.transition && !this.squares.transition, `${label} is outside CPU transition state`);
    check(this.dots.isGpuWeatherSourceCompatible(sources[0]) && this.squares.isGpuWeatherSourceCompatible(sources[1]), `${label} source is compatible with both stable renderers`);
    if (active?.level <= 12) {
      check(sources[0]?.kind === 'summary' && sources[0]?.coverageTextureA && sources[0]?.coverageTextureB, `${label} carries the coarse GPU summary and coverage pair`);
      check(this.dots.diagnostics().gpuWeather.mappedCpuBytes === 0 && this.squares.diagnostics().gpuWeather.mappedCpuBytes === 0, `${label} keeps CPU presentation bytes at zero`);
    } else check(sources[0]?.kind === 'physical', `${label} carries the direct physical source`);
  }

  commitStable(level, topology = this.pyramid.topology, label = `stable L${level}`) {
    this.pyramid.setTopology(topology, { preserveCompatibleState: false });
    const levelData = topology.levelDataFor(level);
    const committedSource = source(topology, levelData);
    check(this.dots.isGpuWeatherSourceCompatible(committedSource, { topology, levelData, allowTransition: true })
      && this.squares.isGpuWeatherSourceCompatible(committedSource, { topology, levelData, allowTransition: true }), `${label} passes renderer preflight before publication`);
    this.dots.setGpuWeatherCommittedState(topology, levelData, committedSource, 0);
    this.squares.setGpuWeatherCommittedState(topology, levelData, committedSource, 0);
    this.active = { level, topology, levelData, source: committedSource };
    this.pending = null;
    this.assertStable(label);
  }

  beginPending(level, topology, label) {
    const pending = { level, topology, levelData: topology.levelDataFor(level), source: source(topology, topology.levelDataFor(level)), cancelled: false };
    this.pending = pending;
    this.assertStable(`${label} while replacement is pending`);
    check(this.dots.gpuWeatherSource === this.active.source && this.squares.gpuWeatherSource === this.active.source, `${label} leaves ACTIVE source untouched while PENDING is incomplete`);
    return pending;
  }

  supersedePending(nextPending, label) {
    const previous = this.pending;
    if (previous) {
      previous.cancelled = true;
      previous.source?.resource?.dispose();
    }
    this.pending = nextPending;
    this.assertStable(`${label} after superseding pending work`);
    check(!previous?.cancelled || this.dots.gpuWeatherSource === this.active.source, `${label} superseded cleanup cannot alter ACTIVE source`);
    check(this.active.source.resource.disposed === false, `${label} superseded cleanup cannot dispose ACTIVE resources`);
  }

  commitPending(label, { expectReady = true } = {}) {
    const pending = this.pending;
    const ready = Boolean(pending && !pending.cancelled);
    check(ready === expectReady, `${label} commits only the latest pending work`);
    if (!pending || pending.cancelled) return;
    this.commitStable(pending.level, pending.topology, label);
  }

  transitionTo(level, label) {
    const from = this.active.levelData;
    const to = this.pyramid.levelDataFor(level);
    this.dots.setTransition(from, to, 0, 0);
    this.squares.setTransition(from, to, 0, 0);
    check(!this.dots.gpuWeatherSource && !this.squares.gpuWeatherSource, `${label} uses source-less CPU transition state only outside stable GPU`);
    this.commitStable(level, this.pyramid.topology, label);
  }
}

check(GPU_WEATHER_LEVELS.join(',') === '10,11,12,13,14', 'GPU weather stable levels include L10-L14');

for (const Layer of [GeographicDotsLayer, GeographicSquaresLayer]) {
  const pyramid = new GeographicWeatherPyramid(Float32Array, new GeographicLodTopology(firstWindow, { minLevel: 13, maxLevel: 14 }));
  const layer = new Layer(pyramid);
  const firstTopology = pyramid.topology;
  const firstLevelData = pyramid.levelDataFor(GPU_LEVEL);

  layer.setGpuWeatherMode(true);
  layer.setLevelData(firstLevelData, 0);
  const firstSource = source(firstTopology, firstLevelData);
  check(layer.isGpuWeatherSourceCompatible(firstSource), `${Layer.name} accepts matching topology and L14 identity`);
  layer.setGpuWeatherSource(firstSource, { requestRepaint: false });
  check(layer.gpuWeatherSource === firstSource, `${Layer.name} installs the matching source`);

  pyramid.setCanonicalWindow(shiftedWindow);
  const shiftedTopology = pyramid.topology;
  layer.setTopology(shiftedTopology);
  check(layer.gpuWeatherSource === null, `${Layer.name} clears source when the canonical window changes`);
  layer.setLevelData(pyramid.levelDataFor(GPU_LEVEL), 0);
  check(layer.gpuWeatherSource === null, `${Layer.name} keeps source clear until the new L14 source is ready`);

  const shiftedSource = source(shiftedTopology, layer.levelData);
  layer.setGpuWeatherSource(shiftedSource, { requestRepaint: false });
  check(layer.gpuWeatherSource === shiftedSource, `${Layer.name} accepts the synchronized replacement source`);

  const sameWindowReplacement = new GeographicLodTopology(shiftedTopology.canonicalWindow, { minLevel: 13, maxLevel: 14 });
  pyramid.setTopology(sameWindowReplacement);
  layer.setTopology(sameWindowReplacement);
  check(layer.gpuWeatherSource === null, `${Layer.name} clears source for a same-window topology replacement`);
  layer.setLevelData(pyramid.levelDataFor(GPU_LEVEL), 0);
  const synchronizedSource = source(sameWindowReplacement, layer.levelData);
  layer.setGpuWeatherSource(synchronizedSource, { requestRepaint: false });
  check(layer.gpuWeatherSource === synchronizedSource, `${Layer.name} resumes after same-window synchronization`);

  let threw = false;
  try {
    layer.setGpuWeatherSource(source(shiftedTopology, layer.levelData), { requestRepaint: false });
  } catch (error) {
    threw = error instanceof Error && error.message.includes('GPU weather source must match the active stable GPU topology');
  }
  check(threw, `${Layer.name} retains the topology compatibility invariant`);

  layer.setActive(false);
  layer.setTransition(pyramid.levelDataFor(13), pyramid.levelDataFor(GPU_LEVEL), 0, 0);
  check(layer.gpuWeatherSource === null, `${Layer.name} clears source before an L13/L14 transition`);

  layer.setGpuWeatherMode(false);
  check(layer.gpuWeatherSource === null, `${Layer.name} clears source on GPU deactivation`);
}

// Stable L13 uses the same source/topology identity contract as L14.
for (const Layer of [GeographicDotsLayer, GeographicSquaresLayer]) {
  const pyramid = new GeographicWeatherPyramid(Float32Array, new GeographicLodTopology(firstWindow, { minLevel: 12, maxLevel: 14 }));
  const layer = new Layer(pyramid);
  const levelData = pyramid.levelDataFor(13);
  layer.setGpuWeatherMode(true);
  layer.setLevelData(levelData, 0);
  const source13 = source(pyramid.topology, levelData);
  check(layer.isGpuWeatherSourceCompatible(source13), `${Layer.name} accepts matching stable L13 identity`);
  layer.setGpuWeatherSource(source13, { requestRepaint: false });
  check(layer.gpuWeatherSource === source13, `${Layer.name} installs the stable L13 source`);
  const mismatched = source(new GeographicLodTopology(shiftedWindow, { minLevel: 12, maxLevel: 14 }), levelData);
  let threw = false;
  try { layer.setGpuWeatherSource(mismatched, { requestRepaint: false }); } catch (error) {
    threw = error instanceof Error && error.message.includes('GPU weather source must match the active stable GPU topology');
  }
  check(threw, `${Layer.name} rejects mismatched stable L13 source identity`);
}

for (const Layer of [GeographicDotsLayer, GeographicSquaresLayer]) {
  const pyramid = new GeographicWeatherPyramid(Float32Array, new GeographicLodTopology(firstWindow, { minLevel: 10, maxLevel: 13 }));
  const layer = new Layer(pyramid);
  for (const level of [10, 11, 12]) {
    const levelData = pyramid.levelDataFor(level);
    layer.setGpuWeatherMode(true);
    layer.setLevelData(levelData, 0);
    const summarySource = source(pyramid.topology, levelData);
    check(layer.isGpuWeatherSourceCompatible(summarySource), `${Layer.name} accepts matching GPU summary L${level} identity`);
    layer.setGpuWeatherSource(summarySource, { requestRepaint: false });
    check(layer.gpuWeatherSource === summarySource, `${Layer.name} installs GPU summary L${level} source`);
    layer.setLevelData(levelData, 0);
  }
}

// Transactional stable-state scenarios cover every supported level and the
// replacement/transition boundaries that previously could clear a committed
// source without publishing its replacement.
{
  const scenario = new StableGpuLifecycleScenario();
  scenario.commitStable(12, scenario.pyramid.topology, 'initial stable L12 GPU activation');
  const pendingTopology = topologyFor(shiftedWindow);
  scenario.beginPending(12, pendingTopology, 'stable L12 same-level spatial replacement');
  scenario.commitPending('stable L12 same-level spatial replacement commit');

  scenario.transitionTo(11, 'stable L12 → transition → stable L11');
  scenario.transitionTo(10, 'stable L11 → transition → stable L10');
  scenario.transitionTo(11, 'stable L10 → transition → stable L11');

  scenario.commitStable(12, scenario.pyramid.topology, 'stable L11 → stable L12 GPU activation');
  scenario.transitionTo(13, 'stable L12 → transition → stable L13');
  scenario.beginPending(13, topologyFor(firstWindow), 'stable L13 same-level spatial replacement');
  scenario.commitPending('stable L13 same-level spatial replacement commit');
  scenario.transitionTo(14, 'stable L13 → transition → stable L14');
  scenario.transitionTo(13, 'stable L14 → transition → stable L13');

  scenario.commitStable(12, scenario.pyramid.topology, 'stable L12 before rapid pending targets');
  const pendingA = scenario.beginPending(12, topologyFor(shiftedWindow), 'rapid pending target A');
  const pendingB = { level: 12, topology: topologyFor(firstWindow), levelData: null, source: null, cancelled: false };
  scenario.supersedePending(pendingB, 'rapid pending target B');
  check(pendingA.cancelled, 'rapid pending target A is marked superseded');
  scenario.pending = pendingA;
  scenario.commitPending('superseded pending target A', { expectReady: false });
  scenario.assertStable('superseded pending target A cannot publish');
  scenario.pending = pendingB;
  scenario.commitPending('rapid pending target B');

  scenario.beginPending(12, topologyFor(shiftedWindow), 'Dots ↔ Squares pending boundary');
  scenario.dots.setActive(false);
  scenario.squares.setActive(true);
  scenario.assertStable('Dots ↔ Squares pending boundary');
  scenario.commitPending('Dots ↔ Squares pending boundary commit');
  check(scenario.dots.gpuWeatherSource === scenario.squares.gpuWeatherSource, 'Dots ↔ Squares commit preserves one source identity');
}

if (failures) process.exitCode = 1;
console.log(failures ? `VERIFICATION FAILED: ${failures}` : 'VERIFICATION PASSED');
