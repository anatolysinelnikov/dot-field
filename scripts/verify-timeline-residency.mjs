import { residentSourceFrameIntervals } from '../src/timeline-residency.js';

const FRAME_COUNT = 19;
const UNIT = 1 / (FRAME_COUNT - 1);

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIntervals(actual, expected, message) {
  check(actual.length === expected.length, `${message}: interval count mismatch`);
  for (let index = 0; index < expected.length; index++) {
    check(Math.abs(actual[index].start - expected[index][0]) < 1e-12, `${message}: start mismatch at ${index}`);
    check(Math.abs(actual[index].end - expected[index][1]) < 1e-12, `${message}: end mismatch at ${index}`);
  }
}

assertIntervals(residentSourceFrameIntervals([], FRAME_COUNT), [], 'no resident pairs');
assertIntervals(residentSourceFrameIntervals([0], FRAME_COUNT), [], 'one resident frame');
assertIntervals(residentSourceFrameIntervals([0, 1], FRAME_COUNT), [[0, UNIT]], '0,1');
assertIntervals(residentSourceFrameIntervals([0, 1, 2], FRAME_COUNT), [[0, 2 * UNIT]], '0,1,2');
assertIntervals(
  residentSourceFrameIntervals([0, 1, 2, 8, 9], FRAME_COUNT),
  [[0, 2 * UNIT], [8 * UNIT, 9 * UNIT]],
  'disconnected resident ranges'
);
assertIntervals(
  residentSourceFrameIntervals(Array.from({ length: FRAME_COUNT }, (_, index) => index), FRAME_COUNT),
  [[0, 1]],
  'all frames resident'
);
assertIntervals(
  residentSourceFrameIntervals([9, 2, 1, 0, 8, 2, 0], FRAME_COUNT),
  [[0, 2 * UNIT], [8 * UNIT, 9 * UNIT]],
  'unsorted resident snapshot'
);

console.log('timeline residency verification passed: pair-based intervals, disconnected ranges, full residency, and unsorted snapshots');
