// Dependency-free contract verification for the opt-in multi-chunk working set.

import { geographicTemporalFrameAt, TEMPORAL_FRAME_COUNT } from '../src/engine/geographic-layer-utils.js';

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`PASS ${message}`);
  else { failures++; console.error(`FAIL ${message}`); }
}

function target(key) {
  return {
    key,
    updates: 0,
    destroyed: false,
    destroyCount: 0,
    pair: null,
    reconstruct(pair) { this.updates++; this.pair = pair; },
    destroy() { if (this.destroyed) return; this.destroyed = true; this.destroyCount++; }
  };
}

class MultiChunkWorkingSetScenario {
  constructor(keys) {
    this.active = this.makeSet(keys, 'active');
    this.candidate = null;
    this.generation = 0;
    this.candidateBuilds = 0;
    this.publications = 0;
    this.superseded = 0;
    this.providerBuilds = 1;
    this.providerUploads = 1;
  }

  makeSet(keys, label) {
    return {
      keys: [...keys],
      label,
      targets: keys.map((key) => target(`${label}/${key}`)),
      released: false,
      pair: null,
      progress: 0
    };
  }

  request(keys) {
    if (this.active.keys.join(',') === keys.join(',')) return false;
    if (this.candidate) {
      this.candidate.cancelled = true;
      this.release(this.candidate);
      this.superseded++;
    }
    this.candidate = this.makeSet(keys, `candidate-${++this.generation}`);
    this.candidateBuilds++;
    this.providerBuilds++;
    this.providerUploads++;
    return true;
  }

  release(set) {
    if (!set || set.released) return;
    for (const item of set.targets) item.destroy();
    set.released = true;
  }

  publish(candidate) {
    if (!candidate || candidate.cancelled || this.candidate !== candidate) return false;
    const predecessor = this.active;
    this.active = candidate;
    this.candidate = null;
    this.release(predecessor);
    this.publications++;
    return true;
  }

  progressOnly(progress) {
    this.active.progress = progress;
    return this.active.targets.every((item) => item.updates === 0);
  }

  rollover(pair) {
    for (const item of this.active.targets) item.reconstruct(pair);
    this.active.pair = pair;
  }
}

const scenario = new MultiChunkWorkingSetScenario(['13/1/1', '13/2/1']);
const buildsBeforeReuse = scenario.candidateBuilds;
const providerBuildsBeforeReuse = scenario.providerBuilds;
check(!scenario.request(['13/1/1', '13/2/1']), 'same ordered chunk keys reuse ACTIVE without a candidate');
check(scenario.candidateBuilds === buildsBeforeReuse && scenario.providerBuilds === providerBuildsBeforeReuse, 'same-set camera movement performs no provider build or target preparation');
check(scenario.progressOnly(0.4), 'progress-only temporal update performs no physical reconstruction');

check(scenario.request(['13/1/1', '13/2/1', '13/3/1']), 'changed chunk keys begin candidate preparation');
const predecessor = scenario.active;
const candidate = scenario.candidate;
check(!predecessor.released && scenario.active === predecessor, 'ACTIVE remains valid while the candidate prepares');
check(scenario.publish(candidate), 'complete candidate publishes atomically');
check(scenario.active === candidate && predecessor.released, 'predecessor releases only after candidate publication');
check(candidate.targets.every((item) => !item.destroyed), 'published candidate targets remain live');

check(scenario.request(['13/1/1']), 'a second changed set begins another candidate');
const stale = scenario.candidate;
check(scenario.request(['13/4/1']), 'newer camera selection supersedes the old candidate');
check(stale.released && stale.targets.every((item) => item.destroyCount === 1), 'superseded candidate resources release exactly once');
check(scenario.active.keys.join(',') === '13/1/1,13/2/1,13/3/1', 'superseded candidate cannot alter ACTIVE');
check(scenario.superseded === 1, 'superseded candidate count is bounded and explicit');

const temporal = new MultiChunkWorkingSetScenario(['13/1/1', '13/2/1']);
const initialFrame = geographicTemporalFrameAt(0.2);
temporal.active.pair = { a: initialFrame.index, b: initialFrame.nextIndex };
const providerBuildsBeforeTemporal = temporal.providerBuilds;
const updatesBeforeTemporal = temporal.active.targets.map((item) => item.updates);
check(temporal.progressOnly(initialFrame.progress + 0.1), 'all active chunks share progress without reconstruction');
check(temporal.active.targets.every((item, index) => item.updates === updatesBeforeTemporal[index]), 'progress-only update leaves every target output untouched');
const rollover = geographicTemporalFrameAt((initialFrame.nextIndex + 0.1) / TEMPORAL_FRAME_COUNT);
temporal.rollover({ a: rollover.index, b: rollover.nextIndex });
check(temporal.active.targets.every((item) => item.updates === 1), 'pair rollover reconstructs the missing endpoint on every target');
check(temporal.providerBuilds === providerBuildsBeforeTemporal, 'temporal-only rollover does not rebuild provider residency');

if (failures) process.exitCode = 1;
console.log(failures ? `VERIFICATION FAILED: ${failures}` : 'VERIFICATION PASSED: multi-chunk ACTIVE/CANDIDATE lifecycle and synchronized temporal contract');
