import fs from 'node:fs';
import {
  RAIN_COVERAGE_THRESHOLDS_MMH,
  GeographicWeatherPyramid,
  aggregateWeatherSummary,
  createWeatherSummary
} from '../src/engine/geographic-weather-pyramid.js';
import { prepareGeographicFieldFrame, setActiveWeatherField } from '../src/engine/geography.js';
import { parseRealWeatherCsv } from '../src/engine/real-weather.js';

const LEVELS = [10, 11, 12, 13, 14];
const CHANNELS = [
  'totalWeight',
  'rainWeightedSumMmh',
  'rainMaxMmh',
  'stormCoverageWeight',
  'stormWeightedSeverity',
  'stormMaxSeverity',
  'hailCoverageWeight',
  'hailWeightedSeverity',
  'hailMaxSeverity'
];
const TOLERANCE = 1e-9;

let failures = 0;
function check(condition, message) {
  if (!condition) {
    failures++;
    console.error(`FAIL ${message}`);
  }
}

function maxAbsDiff(left, right) {
  if (left.length !== right.length) return Infinity;
  let maximum = 0;
  for (let index = 0; index < left.length; index++) maximum = Math.max(maximum, Math.abs(left[index] - right[index]));
  return maximum;
}

function sum(values) {
  let result = 0;
  for (const value of values) result += value;
  return result;
}

function maximum(values) {
  let result = 0;
  for (const value of values) result = Math.max(result, value);
  return result;
}

function mean(summary, index) {
  return summary.rainWeightedSumMmh[index] / summary.totalWeight[index];
}

function directFixture(rainValues, stormValues = [], hailValues = []) {
  const levelData = { level: 0, samples: rainValues.map(() => ({})) };
  const summary = createWeatherSummary(levelData);
  for (let index = 0; index < rainValues.length; index++) {
    const rainMmh = rainValues[index];
    const storm = stormValues[index] || 0;
    const hail = hailValues[index] || 0;
    summary.totalWeight[index] = 1;
    summary.rainWeightedSumMmh[index] = rainMmh;
    summary.rainMaxMmh[index] = rainMmh;
    for (let thresholdIndex = 0; thresholdIndex < RAIN_COVERAGE_THRESHOLDS_MMH.length; thresholdIndex++) {
      summary.rainCoverageWeight[thresholdIndex][index] = rainMmh >= RAIN_COVERAGE_THRESHOLDS_MMH[thresholdIndex] ? 1 : 0;
    }
    summary.stormCoverageWeight[index] = storm > 0 ? 1 : 0;
    summary.stormWeightedSeverity[index] = storm;
    summary.stormMaxSeverity[index] = storm;
    summary.hailCoverageWeight[index] = hail > 0 ? 1 : 0;
    summary.hailWeightedSeverity[index] = hail;
    summary.hailMaxSeverity[index] = hail;
  }
  return { levelData, summary };
}

const fourToOne = {
  offsets: new Uint32Array([0, 1, 2, 3, 4]),
  parentIndices: new Uint32Array([0, 0, 0, 0]),
  weights: new Float64Array([0.25, 0.25, 0.25, 0.25])
};
const fixtureParent = { level: 0, samples: [{}] };

const uniform = aggregateWeatherSummary(fixtureParent, directFixture([5, 5, 5, 5]).summary, fourToOne);
const localized = aggregateWeatherSummary(fixtureParent, directFixture([0, 0, 0, 20]).summary, fourToOne);
console.log(`uniform moderate rain: mean=${mean(uniform, 0)}, max=${uniform.rainMaxMmh[0]}, coverage@2.5=${uniform.rainCoverageWeight[4][0]}`);
console.log(`localized intense rain: mean=${mean(localized, 0)}, max=${localized.rainMaxMmh[0]}, coverage@2.5=${localized.rainCoverageWeight[4][0]}`);
check(mean(uniform, 0) === 5 && uniform.rainMaxMmh[0] === 5, 'uniform moderate rain summary');
check(mean(localized, 0) === 5 && localized.rainMaxMmh[0] === 20, 'localized intense rain mean/max summary');
check(uniform.rainCoverageWeight[4][0] === 1 && localized.rainCoverageWeight[4][0] === 0.25, 'rain coverage distinguishes distribution');

const highValues = aggregateWeatherSummary(fixtureParent, directFixture([80, 120]).summary, {
  offsets: new Uint32Array([0, 1, 2]),
  parentIndices: new Uint32Array([0, 0]),
  weights: new Float64Array([0.5, 0.5])
});
console.log(`physical high rain: weightedSum=${highValues.rainWeightedSumMmh[0]}, max=${highValues.rainMaxMmh[0]}`);
check(highValues.rainWeightedSumMmh[0] === 100 && highValues.rainMaxMmh[0] === 120, '80 and 120 remain distinct above presentation scale');
const highDirect = directFixture([80, 120]).summary;
check(highDirect.rainWeightedSumMmh[0] === 80 && highDirect.rainWeightedSumMmh[1] === 120
  && highDirect.rainMaxMmh[0] === 80 && highDirect.rainMaxMmh[1] === 120, 'direct 80 and 120 remain distinct in the shared schema');

const stormSeverity = 0.6977377;
const hazard = aggregateWeatherSummary(fixtureParent, directFixture([0, 0, 0, 0], [0, 0, 0, stormSeverity]).summary, fourToOne);
console.log(`localized storm: coverage=${hazard.stormCoverageWeight[0]}, weightedSeverity=${hazard.stormWeightedSeverity[0]}, max=${hazard.stormMaxSeverity[0]}`);
check(hazard.stormCoverageWeight[0] === 0.25, 'localized storm coverage');
check(hazard.stormWeightedSeverity[0] === stormSeverity * 0.25, 'localized storm weighted severity');
check(hazard.stormMaxSeverity[0] === stormSeverity, 'localized storm maximum severity');

const empty = aggregateWeatherSummary(fixtureParent, directFixture([0, 0, 0, 0]).summary, fourToOne);
check(Math.abs(empty.totalWeight[0] - 1) <= TOLERANCE, 'empty summary retains support weight');
for (const channel of CHANNELS.filter((name) => name !== 'totalWeight')) check(empty[channel][0] === 0, `empty summary ${channel}`);

const pyramid = new GeographicWeatherPyramid();
let centeredWeightError = 0;
let centeredEntries = 0;
let centeredMappingBytes = 0;
for (let level = 11; level <= 14; level++) {
  const contributions = pyramid.topologyFor(level).contributionsToParent;
  for (let childIndex = 0; childIndex < contributions.offsets.length - 1; childIndex++) {
    let childWeight = 0;
    for (let index = contributions.offsets[childIndex]; index < contributions.offsets[childIndex + 1]; index++) {
      childWeight += contributions.weights[index];
      centeredEntries++;
    }
    centeredWeightError = Math.max(centeredWeightError, Math.abs(childWeight - 1));
  }
  const mappingBytes = contributions.offsets.byteLength + contributions.parentIndices.byteLength + contributions.weights.byteLength;
  centeredMappingBytes += mappingBytes;
  console.log(`L${level}->L${level - 1}: ${contributions.parentIndices.length} centered contributions, ${mappingBytes} mapping bytes, max child weight error ${centeredWeightError}`);
}
check(centeredWeightError <= TOLERANCE, 'centered contributions conserve each child support weight');

const field = parseRealWeatherCsv(fs.readFileSync(new URL('../data/mrl_z3_t+40min_376x239.csv', import.meta.url), 'utf8'));
setActiveWeatherField(field);
const frame = prepareGeographicFieldFrame(0);
const summaries = pyramid.evaluate([10], frame);

function addGlobalConservationChecks(summary, reference, level) {
  for (const channel of ['totalWeight', 'rainWeightedSumMmh', 'stormCoverageWeight', 'stormWeightedSeverity', 'hailCoverageWeight', 'hailWeightedSeverity']) {
    const error = Math.abs(sum(summary[channel]) - sum(reference[channel]));
    console.log(`L${level} ${channel} global conservation error: ${error}`);
    check(error <= TOLERANCE, `L${level} ${channel} global conservation`);
  }
  for (let thresholdIndex = 0; thresholdIndex < RAIN_COVERAGE_THRESHOLDS_MMH.length; thresholdIndex++) {
    const error = Math.abs(sum(summary.rainCoverageWeight[thresholdIndex]) - sum(reference.rainCoverageWeight[thresholdIndex]));
    console.log(`L${level} rain coverage@${RAIN_COVERAGE_THRESHOLDS_MMH[thresholdIndex]} global conservation error: ${error}`);
    check(error <= TOLERANCE, `L${level} rain coverage global conservation`);
  }
  for (const channel of ['rainMaxMmh', 'stormMaxSeverity', 'hailMaxSeverity']) {
    const error = Math.abs(maximum(summary[channel]) - maximum(reference[channel]));
    console.log(`L${level} ${channel} maximum preservation error: ${error}`);
    check(error <= TOLERANCE, `L${level} ${channel} maximum preservation`);
  }
}

const direct = summaries[14];
for (const level of LEVELS.slice(0, -1)) addGlobalConservationChecks(summaries[level], direct, level);

let directL14Error = 0;
for (let index = 0; index < direct.samples.length; index++) {
  const sample = direct.samples[index];
  const value = frame.sample(sample.lngLat[0], sample.lngLat[1]);
  directL14Error = Math.max(
    directL14Error,
    Math.abs(mean(direct, index) - value.rainMmh),
    Math.abs(direct.rainMaxMmh[index] - value.rainMmh),
    Math.abs(direct.stormWeightedSeverity[index] - value.storm),
    Math.abs(direct.stormMaxSeverity[index] - value.storm),
    Math.abs(direct.hailWeightedSeverity[index] - value.hail),
    Math.abs(direct.hailMaxSeverity[index] - value.hail),
    Math.abs(direct.totalWeight[index] - 1)
  );
  for (let thresholdIndex = 0; thresholdIndex < RAIN_COVERAGE_THRESHOLDS_MMH.length; thresholdIndex++) {
    const expected = value.rainMmh >= RAIN_COVERAGE_THRESHOLDS_MMH[thresholdIndex] ? 1 : 0;
    directL14Error = Math.max(directL14Error, Math.abs(direct.rainCoverageWeight[thresholdIndex][index] - expected));
  }
}
console.log(`real L14 direct-sampling maximum error: ${directL14Error}`);
check(directL14Error <= TOLERANCE, 'real L14 direct-sampling equivalence');

function composeContributions(first, second) {
  const offsets = new Uint32Array(first.offsets.length);
  const parentIndices = [];
  const weights = [];
  for (let childIndex = 0; childIndex < first.offsets.length - 1; childIndex++) {
    for (let firstIndex = first.offsets[childIndex]; firstIndex < first.offsets[childIndex + 1]; firstIndex++) {
      const middleIndex = first.parentIndices[firstIndex];
      for (let secondIndex = second.offsets[middleIndex]; secondIndex < second.offsets[middleIndex + 1]; secondIndex++) {
        parentIndices.push(second.parentIndices[secondIndex]);
        weights.push(first.weights[firstIndex] * second.weights[secondIndex]);
      }
    }
    offsets[childIndex + 1] = parentIndices.length;
  }
  return { offsets, parentIndices: Uint32Array.from(parentIndices), weights: Float64Array.from(weights) };
}

const composedL14ToL12 = composeContributions(pyramid.topologyFor(14).contributionsToParent, pyramid.topologyFor(13).contributionsToParent);
const composedL12 = aggregateWeatherSummary(pyramid.levels.get(12), direct, composedL14ToL12);
let recursiveError = 0;
for (const channel of CHANNELS) recursiveError = Math.max(recursiveError, maxAbsDiff(composedL12[channel], summaries[12][channel]));
for (let thresholdIndex = 0; thresholdIndex < RAIN_COVERAGE_THRESHOLDS_MMH.length; thresholdIndex++) {
  recursiveError = Math.max(recursiveError, maxAbsDiff(composedL12.rainCoverageWeight[thresholdIndex], summaries[12].rainCoverageWeight[thresholdIndex]));
}
console.log(`L14→L13→L12 recursive/composed maximum error: ${recursiveError}`);
check(recursiveError <= TOLERANCE, 'recursive/composed aggregation equivalence');

const bytesPerSample = pyramid.summaryMemoryBytesPerSample();
let totalSummaryBytes = 0;
for (const level of LEVELS) {
  const sampleCount = pyramid.samplesFor(level).length;
  const bytes = sampleCount * bytesPerSample;
  totalSummaryBytes += bytes;
  console.log(`L${level}: ${sampleCount} samples, ${bytes} summary bytes`);
}
console.log(`summary schema: ${bytesPerSample} bytes/sample, ${totalSummaryBytes} bytes (${(totalSummaryBytes / 1024 / 1024).toFixed(3)} MiB) per state, ${(totalSummaryBytes * 2 / 1024 / 1024).toFixed(3)} MiB for two states`);
console.log(`centered contribution entries: ${centeredEntries}, ${centeredMappingBytes} topology mapping bytes (${(centeredMappingBytes / 1024 / 1024).toFixed(3)} MiB)`);

console.log(failures ? `VERIFICATION FAILED: ${failures}` : 'VERIFICATION PASSED');
if (failures) process.exitCode = 1;
