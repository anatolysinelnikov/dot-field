import {
  buildDirectPairsReference,
  canonicalWindowFromMercatorBounds,
  forEachDirectTransitionPair,
  GeographicLodTopology,
  lngLatToMercator
} from '../src/engine/geographic-lod.js';
import {
  buildDirectTemporalInstances,
  buildDirectTemporalInstancesReference
} from '../src/engine/geographic-dots-layer.js';

const KEYS = ['rainRadius', 'strongRadius', 'stormRadius', 'hailRadius'];
let failures = 0;
function check(condition, message) { if (condition) console.log(`PASS ${message}`); else { failures++; console.error(`FAIL ${message}`); } }

class Writer {
  constructor() { this.values = new Float32Array(); this.length = 0; }
  reset() { this.length = 0; }
  push(...values) {
    const next = this.length + values.length;
    if (next > this.values.length) { const expanded = new Float32Array(Math.max(next, this.values.length * 2, 256)); expanded.set(this.values); this.values = expanded; }
    this.values.set(values, this.length); this.length = next;
  }
  finish() { return this.values.subarray(0, this.length); }
}

function state(count, seed) {
  const result = {};
  for (let keyIndex = 0; keyIndex < KEYS.length; keyIndex++) {
    const values = new Float32Array(count);
    for (let index = 0; index < count; index++) {
      // Include zero-only, lower-only, higher-only, and both-visible temporal values.
      const code = (index * 13 + seed * 7 + keyIndex * 5) % 11;
      values[index] = code < 4 ? 0 : (code + 1) * 0.00001;
    }
    result[KEYS[keyIndex]] = values;
  }
  return result;
}

function equalBytes(left, right) {
  return left.byteLength === right.byteLength
    && new Uint8Array(left.buffer, left.byteOffset, left.byteLength).every((value, index) => value === new Uint8Array(right.buffer, right.byteOffset, right.byteLength)[index]);
}

function verifyWindow(name, window) {
  const topology = new GeographicLodTopology(window, { minLevel: 13, maxLevel: 14 });
  const lower = topology.levelDataFor(13);
  const higher = topology.levelDataFor(14);
  const relation = topology.directTransitionRelationFor(13, 14);
  const referencePairs = buildDirectPairsReference(lower, higher);
  const compactPairs = [];
  forEachDirectTransitionPair(relation, (low, high) => compactPairs.push(low, high));
  check(equalBytes(Int32Array.from(compactPairs), referencePairs), `${name} exact L13/L14 direct pair sequence`);
  for (const fromIsLower of [true, false]) {
    const fromCount = fromIsLower ? lower.count : higher.count;
    const toCount = fromIsLower ? higher.count : lower.count;
    const from0 = state(fromCount, 1); const from1 = state(fromCount, 2);
    const to0 = state(toCount, 3); const to1 = state(toCount, 4);
    for (const key of KEYS) {
      const reference = buildDirectTemporalInstancesReference(from0, to0, from1, to1, fromIsLower ? lower : higher, fromIsLower ? higher : lower, referencePairs, fromIsLower, key, new Writer());
      const compact = buildDirectTemporalInstances(from0, to0, from1, to1, relation, fromIsLower, key, new Writer());
      check(equalBytes(compact, reference), `${name} ${fromIsLower ? 'refining' : 'coarsening'} ${key} Float32 instance bytes`);
    }
  }
}

const [x, y] = lngLatToMercator(45.03, 43.35);
const interior = canonicalWindowFromMercatorBounds({ minX: x - 0.004, maxX: x + 0.004, minY: y - 0.004, maxY: y + 0.004 });
const support = new GeographicLodTopology(undefined, { minLevel: 13, maxLevel: 13 }).canonicalWindow;
verifyWindow('interior', interior);
verifyWindow('support corner', { minX: support.minX, maxX: support.minX + 96, minY: support.minY, maxY: support.minY + 96 });
verifyWindow('translated clipped', { minX: support.minX + 73, maxX: support.minX + 211, minY: support.minY + 41, maxY: support.minY + 179 });
if (failures) process.exitCode = 1;
else console.log('DIRECT TRANSITION INSTANCE EQUIVALENCE PASSED');
