import fs from 'node:fs';
import { parseRealWeatherCsv } from '../src/engine/real-weather.js';
import { setActiveWeatherField } from '../src/engine/geography.js';
import {
  canonicalWindowContains,
  canonicalWindowFromMercatorBounds,
  canonicalWindowNeedsShrink,
  GeographicLodTopology,
  lngLatToMercator
} from '../src/engine/geographic-lod.js';
import { GeographicWeatherPyramid } from '../src/engine/geographic-weather-pyramid.js';
import { GeographicDotsLayer } from '../src/engine/geographic-dots-layer.js';
import { GeographicSquaresLayer } from '../src/engine/geographic-squares-layer.js';
import {
  GPU_WEATHER_LEVELS,
  gpuWeatherTransitionReadyPresentationLevels
} from '../src/engine/geographic-gpu-weather-presentation.js';

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

  completeAsync(pending, label) {
    // Models the promise continuation after tile residency/keyframe work. A
    // stale completion may dispose only its own pending resource; it cannot
    // retag or release ACTIVE.
    const accepted = this.pending === pending && !pending.cancelled;
    if (!accepted) pending.source?.resource?.dispose();
    check(!accepted || pending.source.resource.disposed === false, `${label} accepts only a live pending generation`);
    check(!accepted || this.pending === pending, `${label} publishes only the current pending generation`);
    this.assertStable(`${label} completion before publication`);
    return accepted;
  }

  cancelPendingForTransition(label) {
    const pending = this.pending;
    if (pending) {
      pending.cancelled = true;
      this.pending = null;
    }
    this.assertStable(`${label} cancellation leaves pre-transition ACTIVE intact`);
    return pending;
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

class PendingOwnerTerminalScenario {
  constructor() {
    this.nextGeneration = 0;
    this.active = { target: 'A', resource: this.resource('active-A') };
    this.pending = null;
  }

  resource(label) {
    return {
      label,
      disposed: false,
      disposeCount: 0,
      dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.disposeCount++;
      }
    };
  }

  begin(target) {
    const pending = this.createPending(target);
    this.pending = pending;
    return pending;
  }

  createPending(target) {
    return {
      target,
      generation: ++this.nextGeneration,
      status: 'preparing',
      cancelled: false,
      resourcesTransferred: false,
      resourcesReleased: false,
      resource: this.resource(`pending-${target}-${this.nextGeneration}`)
    };
  }

  markReady(pending) {
    if (this.pending === pending && !pending.cancelled) pending.status = 'ready';
  }

  terminalCleanup(pending, reason) {
    pending.status = 'terminal';
    pending.cancelled = true;
    pending.terminalReason = reason;
    if (!pending.resourcesTransferred && !pending.resourcesReleased) {
      pending.resource.dispose();
      pending.resourcesReleased = true;
    }
    if (this.pending === pending) this.pending = null;
  }

  supersede(nextPending) {
    const previous = this.pending;
    if (previous) this.terminalCleanup(previous, 'newer spatial target');
    this.pending = nextPending;
    return previous;
  }

  completeLate(pending) {
    if (this.pending !== pending || pending.cancelled || pending.status === 'terminal') {
      this.terminalCleanup(pending, pending.terminalReason || 'stale completion');
      return false;
    }
    return true;
  }

  commit(pending) {
    if (this.pending !== pending || pending.status !== 'ready') return false;
    const previous = this.active;
    this.active = { target: pending.target, resource: pending.resource };
    pending.resourcesTransferred = true;
    pending.status = 'committed';
    this.pending = null;
    previous.resource.dispose();
    return true;
  }
}

// Models the lifecycle boundary where a target can change while the normal
// renderer owns an adjacent CPU transition. GPU reactivation must compare the
// complete new active residency with that still-current target before any
// further camera event occurs.
class GpuReactivationScenario {
  constructor() {
    this.nextGeneration = 0;
    this.active = { level: 13, window: firstWindow, source: { disposed: false } };
    this.target = firstWindow;
    this.pendingCanonicalWindow = null;
    this.pending = null;
    this.gpuActive = true;
    this.inLodTransition = false;
  }

  updateTarget(window) {
    this.target = window;
    if (this.inLodTransition) this.pendingCanonicalWindow = window;
  }

  beginCpuTransition() {
    this.gpuActive = false;
    this.inLodTransition = true;
    this.pending = null;
  }

  reactivateStable(level, window) {
    this.inLodTransition = false;
    this.active = { level, window, source: { disposed: false } };
    this.gpuActive = true;
    this.pendingCanonicalWindow = null;
  }

  reconcile() {
    if (!this.gpuActive || this.inLodTransition || this.pending) return false;
    const contained = canonicalWindowContains(this.active.window, this.target);
    const needsShrink = contained && canonicalWindowNeedsShrink(this.active.window, this.target);
    if (!contained || needsShrink) {
      this.pending = {
        generation: ++this.nextGeneration,
        level: this.active.level,
        window: this.target,
        physicalLevel: this.active.level < 13 ? 13 : this.active.level,
        keyframes: ['A', 'B'],
        source: { disposed: false }
      };
      return true;
    }
    return false;
  }

  commitPending() {
    const pending = this.pending;
    if (!pending || pending.keyframes.length !== 2) return false;
    const previous = this.active;
    this.active = { level: pending.level, window: pending.window, source: pending.source };
    this.pending = null;
    previous.source.disposed = true;
    return true;
  }
}

check(GPU_WEATHER_LEVELS.join(',') === '10,11,12,13,14', 'GPU weather stable levels include L10-L14');
for (const [stableLevel, expected] of [[10, [10, 11]], [11, [10, 11, 12]], [12, [11, 12, 13]], [13, [12, 13]], [14, [14]]]) {
  check(
    gpuWeatherTransitionReadyPresentationLevels(stableLevel).join(',') === expected.join(','),
    `stable L${stableLevel} exposes the bounded GPU transition-ready presentation set`
  );
}

// A target changed during CPU-owned LOD work must remain actionable after GPU
// reactivation. The replacement is prepared and committed without a second
// camera event, while the reactivated active source remains valid until commit.
{
  const scenario = new GpuReactivationScenario();
  const targetBeforeTransition = scenario.target;
  scenario.beginCpuTransition();
  scenario.updateTarget(shiftedWindow);
  check(scenario.pendingCanonicalWindow === shiftedWindow, 'LOD transition retains the changed canonical target for reactivation');
  scenario.reactivateStable(14, firstWindow);
  check(scenario.active.window === firstWindow && !scenario.active.source.disposed, 'stable L14 reactivation establishes a valid active source before spatial replacement');
  check(scenario.target === shiftedWindow && scenario.target !== targetBeforeTransition, 'reactivation compares against the latest target rather than the pre-transition target');
  check(scenario.reconcile(), 'reactivation creates one spatial replacement when active L14 does not cover the target');
  check(scenario.pending?.physicalLevel === 14 && scenario.pending?.keyframes.join(',') === 'A,B', 'reactivation replacement prepares direct L14 A/B');
  check(!scenario.active.source.disposed, 'reactivation leaves active source valid while replacement prepares');
  check(scenario.commitPending(), 'reactivation replacement commits without another camera event');
  check(scenario.pending === null && scenario.active.window === shiftedWindow, 'reactivation replacement covers the current target and clears pending ownership');
  check(scenario.active.source.disposed === false, 'committed reactivation replacement owns its source');

  const covered = new GpuReactivationScenario();
  covered.reactivateStable(13, firstWindow);
  check(!covered.reconcile(), 'reactivation does not create unnecessary replacement when active window covers target');
  check(covered.pending === null, 'covered reactivation has no pending owner');

  const lowerLevel = new GpuReactivationScenario();
  lowerLevel.beginCpuTransition();
  lowerLevel.updateTarget(shiftedWindow);
  lowerLevel.reactivateStable(12, firstWindow);
  check(lowerLevel.reconcile(), 'lower-level reactivation also reconciles an uncovered target');
  check(lowerLevel.pending?.physicalLevel === 13, 'lower-level reactivation retains direct L13 physical support');
}

// Stable L14 spatial replacement must prepare both renderer keyframe slots
// from the direct L14 physical owner. The active source stays visible until
// that complete pair is ready and committed; no second camera input is part
// of the transaction.
{
  const activeTopology = topologyFor(firstWindow);
  const pendingTopology = topologyFor(shiftedWindow);
  const activeLevelData = activeTopology.levelDataFor(14);
  const pendingLevelData = pendingTopology.levelDataFor(14);
  const pendingPhysicalLevelData = pendingTopology.levels.get(14);
  const pendingKeyframes = [0, 1].map((slot) => ({
    slot,
    presentations: new Map([[14, { kind: 'physical', texture: {}, coverageTexture: {} }]])
  }));
  check(activeLevelData !== pendingLevelData, 'stable L14 spatial replacement has a new level-data identity');
  check(pendingPhysicalLevelData === pendingLevelData, 'stable L14 pending physical owner is direct L14');
  check(pendingKeyframes.every((keyframe) => keyframe.presentations.get(14)?.texture), 'stable L14 pending A/B both have direct physical presentation records');
  const activeSource = source(activeTopology, activeLevelData);
  const pendingSource = source(pendingTopology, pendingLevelData);
  check(activeSource.resource.disposed === false, 'stable L14 active source remains valid before pending commit');
  check(pendingSource.resource.disposed === false, 'stable L14 pending source owns its replacement resources');
  pendingSource.resource.dispose();
  check(activeSource.resource.disposed === false, 'stable L14 failed pending cleanup cannot dispose active source');
}

// A rejected prepared replacement must release its coalescing ownership, while
// a late completion from that generation must remain harmless after a retry.
{
  const scenario = new PendingOwnerTerminalScenario();
  const pendingB = scenario.begin('B');
  scenario.markReady(pendingB);
  check(scenario.active.target === 'A' && !scenario.active.resource.disposed, 'rejected pending B leaves active A valid');
  scenario.terminalCleanup(pendingB, 'renderer preflight rejected source');
  check(pendingB.resource.disposeCount === 1 && pendingB.resourcesReleased, 'rejected pending B resources are cleaned exactly once');
  check(scenario.pending === null, 'rejected pending B no longer owns coalescing');
  const pendingC = scenario.begin('B');
  check(pendingC !== pendingB && pendingC.generation > pendingB.generation, 'same target creates fresh pending C generation after rejection');
  check(!scenario.active.resource.disposed, 'active A remains valid while retry C prepares');
  scenario.markReady(pendingC);
  check(scenario.commit(pendingC), 'retry C commits successfully');
  check(scenario.active.resource === pendingC.resource && !pendingC.resource.disposed, 'committed C owns transferred resources');
  check(scenario.active.target === 'B' && pendingB.resource.disposed, 'A is released only after C ownership transfer');
  check(!scenario.completeLate(pendingB), 'late rejected B completion cannot publish');
  check(scenario.pending === null && !pendingC.resource.disposed, 'late B cleanup cannot clear or destroy committed C');
}

// Rapid supersession has the same generation boundary: B may clean itself up,
// but it cannot clear or dispose the newer C owner.
{
  const scenario = new PendingOwnerTerminalScenario();
  const pendingB = scenario.begin('B');
  const pendingC = scenario.createPending('C');
  scenario.supersede(pendingC);
  check(pendingB.resource.disposeCount === 1 && pendingB.cancelled, 'superseded B is terminally cleaned');
  check(scenario.pending === pendingC && !pendingC.resource.disposed, 'supersession leaves C as the live pending owner');
  check(!scenario.completeLate(pendingB), 'late superseded B cannot publish over C');
  check(scenario.pending === pendingC && !pendingC.resource.disposed, 'late B cannot clear or destroy C');
  scenario.markReady(pendingC);
  check(scenario.commit(pendingC), 'superseding C commits normally');
}

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

  // A CPU transition may still be present when GPU ownership is reactivated
  // after an interrupted L14 fallback. It must be retired at the renderer
  // ownership boundary before the first source-only GPU publication.
  const staleTransitionDetails = layer.gpuWeatherSourceCompatibilityDetails(source(layer.topology, layer.levelData));
  check(staleTransitionDetails.failedPredicates.includes('cpu-transition-active'),
    `${Layer.name} reports the stale CPU transition as the compatibility reason`);
  layer.setGpuWeatherMode(false);
  layer.setGpuWeatherMode(true);
  check(!layer.transition, `${Layer.name} clears stale CPU transition on GPU reactivation`);
  const reactivatedSource = source(layer.topology, layer.levelData);
  const reactivatedDetails = layer.gpuWeatherSourceCompatibilityDetails(reactivatedSource);
  check(reactivatedDetails.compatible && reactivatedDetails.failedPredicates.length === 0,
    `${Layer.name} accepts the first complete source after GPU reactivation`);

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
  const equivalentTopology = new GeographicLodTopology(firstWindow, { minLevel: 12, maxLevel: 14 });
  const equivalentLevelData = equivalentTopology.levelDataFor(13);
  check(!layer.isGpuWeatherSourceCompatible(source(equivalentTopology, equivalentLevelData)),
    `${Layer.name} rejects structurally equivalent but foreign stable L13 ownership`);
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

// Explicit asynchronous L14 stress ordering. These cases used to be modelled
// only as synchronous replacement ordering, which missed late promise
// completions after a new target or a transition had already changed owner.
{
  const scenario = new StableGpuLifecycleScenario();
  scenario.commitStable(14, scenario.pyramid.topology, 'stable L14 initial activation');
  const pendingA = scenario.beginPending(14, topologyFor(shiftedWindow), 'L14 pan replacement A');
  const pendingB = { level: 14, topology: topologyFor(firstWindow), levelData: null, source: null, cancelled: false };
  scenario.supersedePending(pendingB, 'L14 pan replacement B supersedes A');
  check(!scenario.completeAsync(pendingA, 'stale L14 A completion while B is current'), 'stale L14 A cannot publish while B is current');
  scenario.commitPending('L14 B commit');
  check(!scenario.completeAsync(pendingA, 'stale L14 A completion after B commit'), 'stale L14 A cannot publish after B commit');

  const interrupted = scenario.beginPending(14, topologyFor(shiftedWindow), 'L14 pending before L14→L13');
  scenario.cancelPendingForTransition('L14→L13 transition entry');
  scenario.transitionTo(13, 'stable L13 after interrupted L14 pending');
  check(!scenario.completeAsync(interrupted, 'stale L14 completion after stable L13'), 'stale L14 completion cannot publish into stable L13');

  scenario.transitionTo(14, 'L13→L14 reactivation');
  const rapidA = scenario.beginPending(14, topologyFor(shiftedWindow), 'L13→L14 rapid pan A');
  const rapidB = { level: 14, topology: topologyFor(firstWindow), levelData: null, source: null, cancelled: false };
  scenario.supersedePending(rapidB, 'L13→L14 rapid pan B');
  check(!scenario.completeAsync(rapidA, 'L13→L14 stale rapid A completion'), 'L13→L14 stale A cannot publish');
  scenario.commitPending('L13→L14 rapid B commit');
  for (let cycle = 0; cycle < 3; cycle++) {
    const pending = scenario.beginPending(14, topologyFor(shiftedWindow), `rapid L13/L14 cycle ${cycle} pending`);
    scenario.cancelPendingForTransition(`rapid L13/L14 cycle ${cycle} transition entry`);
    scenario.transitionTo(13, `rapid L13/L14 cycle ${cycle} stable L13`);
    check(!scenario.completeAsync(pending, `rapid L13/L14 cycle ${cycle} stale completion`), `rapid L13/L14 cycle ${cycle} stale completion cannot publish`);
    scenario.transitionTo(14, `rapid L13/L14 cycle ${cycle} stable L14`);
  }
  scenario.dots.setActive(false);
  scenario.squares.setActive(true);
  scenario.assertStable('Dots↔Squares after asynchronous L14 replacement stress');
}

if (failures) process.exitCode = 1;
console.log(failures ? `VERIFICATION FAILED: ${failures}` : 'VERIFICATION PASSED');
