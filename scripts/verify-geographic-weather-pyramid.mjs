import fs from 'node:fs';
import {
  RAIN_COVERAGE_THRESHOLDS_MMH,
  GeographicWeatherPyramid,
  aggregateWeatherSummary,
  createWeatherSummary
} from '../src/engine/geographic-weather-pyramid.js';
import { prepareGeographicFieldFrame, setActiveWeatherField } from '../src/engine/geography.js';
import { parseRealWeatherCsv } from '../src/engine/real-weather.js';
import { GeographicDotsLayer, mapDotsWeatherSummary } from '../src/engine/geographic-dots-layer.js';
import { GeographicSquaresLayer, mapSquaresWeatherSummary } from '../src/engine/geographic-squares-layer.js';
import { DOTS_STRONG_RAIN_FULL_MMH_DEFAULT, INTENSITY_THRESHOLDS, dotsStrongRainMmhToRadius, rainMmhToRadius } from '../src/engine/precipitation-mapping.js';
import { geographicHazardRadii } from '../src/engine/hazard-renderer.js';

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
const FLOAT64_TOLERANCE = 1e-9;
const RELATIVE_FLOOR = 1e-9;
const FLOAT32_RELATIVE_TOLERANCE = 1e-5;

function float32AbsoluteTolerance(name) {
  if (name === 'rainWeightedSumMmh') return 2e-4;
  if (name === 'rainMeanMmh') return 1e-5;
  if (name === 'rainMaxMmh') return 2e-6;
  if (name.includes('WeightedSeverity')) return 1e-5;
  if (name.includes('MaxSeverity')) return 1e-6;
  return 1e-5;
}

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
  return summary.totalWeight[index] > 0 ? summary.rainWeightedSumMmh[index] / summary.totalWeight[index] : 0;
}

const SUMMARY_STATISTICS = [
  ['totalWeight', (summary, index) => summary.totalWeight[index]],
  ['rainWeightedSumMmh', (summary, index) => summary.rainWeightedSumMmh[index]],
  ['rainMeanMmh', mean],
  ['rainMaxMmh', (summary, index) => summary.rainMaxMmh[index]],
  ...RAIN_COVERAGE_THRESHOLDS_MMH.map((threshold, thresholdIndex) => [
    `rainCoverageWeight@${threshold}mmh`,
    (summary, index) => summary.rainCoverageWeight[thresholdIndex][index]
  ]),
  ['stormCoverageWeight', (summary, index) => summary.stormCoverageWeight[index]],
  ['stormWeightedSeverity', (summary, index) => summary.stormWeightedSeverity[index]],
  ['stormMaxSeverity', (summary, index) => summary.stormMaxSeverity[index]],
  ['hailCoverageWeight', (summary, index) => summary.hailCoverageWeight[index]],
  ['hailWeightedSeverity', (summary, index) => summary.hailWeightedSeverity[index]],
  ['hailMaxSeverity', (summary, index) => summary.hailMaxSeverity[index]]
];

function compareSummaryStatistics(reference, candidate, level, label) {
  const metrics = new Map();
  for (const [name, read] of SUMMARY_STATISTICS) {
    let absolute = 0;
    let relative = 0;
    for (let index = 0; index < reference.samples.length; index++) {
      const referenceValue = read(reference, index);
      const candidateValue = read(candidate, index);
      absolute = Math.max(absolute, Math.abs(referenceValue - candidateValue));
      relative = Math.max(relative, Math.abs(referenceValue - candidateValue) / Math.max(Math.abs(referenceValue), RELATIVE_FLOOR));
    }
    metrics.set(name, { absolute, relative });
    console.log(`${label} L${level} ${name}: maxAbs=${absolute} maxRel=${relative}`);
  }
  return metrics;
}

function checkFloat32SummaryStatistics(reference, candidate, level, label) {
  const metrics = compareSummaryStatistics(reference, candidate, level, label);
  for (const [name, { absolute, relative }] of metrics) {
    check(absolute <= float32AbsoluteTolerance(name), `${label} L${level} ${name} absolute precision`);
    check(relative <= FLOAT32_RELATIVE_TOLERANCE, `${label} L${level} ${name} relative precision`);
  }
}

function directFixture(rainValues, stormValues = [], hailValues = [], ArrayType = Float64Array) {
  const levelData = { level: 0, samples: rainValues.map(() => ({})) };
  const summary = createWeatherSummary(levelData, null, ArrayType);
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

function aggregateFixture(rainValues, stormValues, hailValues, contributions, ArrayType) {
  const fixture = directFixture(rainValues, stormValues, hailValues, ArrayType);
  return aggregateWeatherSummary(fixture.levelData, fixture.summary, contributions, null, ArrayType);
}

const fourToOne = {
  offsets: new Uint32Array([0, 1, 2, 3, 4]),
  parentIndices: new Uint32Array([0, 0, 0, 0]),
  weights: new Float64Array([0.25, 0.25, 0.25, 0.25])
};
const fixtureParent = { level: 0, samples: [{}] };

const uniform = aggregateWeatherSummary(fixtureParent, directFixture([5, 5, 5, 5]).summary, fourToOne, null, Float64Array);
const localized = aggregateWeatherSummary(fixtureParent, directFixture([0, 0, 0, 20]).summary, fourToOne, null, Float64Array);
console.log(`uniform moderate rain: mean=${mean(uniform, 0)}, max=${uniform.rainMaxMmh[0]}, coverage@2.5=${uniform.rainCoverageWeight[4][0]}`);
console.log(`localized intense rain: mean=${mean(localized, 0)}, max=${localized.rainMaxMmh[0]}, coverage@2.5=${localized.rainCoverageWeight[4][0]}`);
check(mean(uniform, 0) === 5 && uniform.rainMaxMmh[0] === 5, 'uniform moderate rain summary');
check(mean(localized, 0) === 5 && localized.rainMaxMmh[0] === 20, 'localized intense rain mean/max summary');
check(uniform.rainCoverageWeight[4][0] === 1 && localized.rainCoverageWeight[4][0] === 0.25, 'rain coverage distinguishes distribution');

const highValues = aggregateWeatherSummary(fixtureParent, directFixture([80, 120]).summary, {
  offsets: new Uint32Array([0, 1, 2]),
  parentIndices: new Uint32Array([0, 0]),
  weights: new Float64Array([0.5, 0.5])
}, null, Float64Array);
console.log(`physical high rain: weightedSum=${highValues.rainWeightedSumMmh[0]}, max=${highValues.rainMaxMmh[0]}`);
check(highValues.rainWeightedSumMmh[0] === 100 && highValues.rainMaxMmh[0] === 120, '80 and 120 remain distinct above presentation scale');
const highDirect = directFixture([80, 120]).summary;
check(highDirect.rainWeightedSumMmh[0] === 80 && highDirect.rainWeightedSumMmh[1] === 120
  && highDirect.rainMaxMmh[0] === 80 && highDirect.rainMaxMmh[1] === 120, 'direct 80 and 120 remain distinct in the shared schema');

const stormSeverity = 0.6977377;
const hazard = aggregateWeatherSummary(fixtureParent, directFixture([0, 0, 0, 0], [0, 0, 0, stormSeverity]).summary, fourToOne, null, Float64Array);
console.log(`localized storm: coverage=${hazard.stormCoverageWeight[0]}, weightedSeverity=${hazard.stormWeightedSeverity[0]}, max=${hazard.stormMaxSeverity[0]}`);
check(hazard.stormCoverageWeight[0] === 0.25, 'localized storm coverage');
check(hazard.stormWeightedSeverity[0] === stormSeverity * 0.25, 'localized storm weighted severity');
check(hazard.stormMaxSeverity[0] === stormSeverity, 'localized storm maximum severity');

const empty = aggregateWeatherSummary(fixtureParent, directFixture([0, 0, 0, 0]).summary, fourToOne, null, Float64Array);
check(Math.abs(empty.totalWeight[0] - 1) <= FLOAT64_TOLERANCE, 'empty summary retains support weight');
for (const channel of CHANNELS.filter((name) => name !== 'totalWeight')) check(empty[channel][0] === 0, `empty summary ${channel}`);

const fixtureCases = [
  ['uniform moderate rain', [5, 5, 5, 5], [], [], fourToOne],
  ['localized intense rain', [0, 0, 0, 20], [], [], fourToOne],
  ['high physical rain', [80, 120], [], [], {
    offsets: new Uint32Array([0, 1, 2]),
    parentIndices: new Uint32Array([0, 0]),
    weights: new Float64Array([0.5, 0.5])
  }],
  ['localized storm', [0, 0, 0, 0], [0, 0, 0, stormSeverity], [], fourToOne],
  ['localized hail', [0, 0, 0, 0], [], [0, 0, 0, 0.61], fourToOne],
  ['empty field', [0, 0, 0, 0], [], [], fourToOne]
];
for (const [name, rainValues, stormValues, hailValues, contributions] of fixtureCases) {
  const reference = aggregateFixture(rainValues, stormValues, hailValues, contributions, Float64Array);
  const candidate = aggregateFixture(rainValues, stormValues, hailValues, contributions, Float32Array);
  checkFloat32SummaryStatistics(reference, candidate, 0, `fixture ${name}`);
}
const productionUniform = aggregateFixture([5, 5, 5, 5], [], [], fourToOne, Float32Array);
const productionLocalized = aggregateFixture([0, 0, 0, 20], [], [], fourToOne, Float32Array);
check(mean(productionUniform, 0) === 5 && productionUniform.rainMaxMmh[0] === 5, 'Float32 uniform moderate rain remains distinct');
check(mean(productionLocalized, 0) === 5 && productionLocalized.rainMaxMmh[0] === 20, 'Float32 localized intense rain remains distinct');
const productionHighDirect = directFixture([80, 120], [], [], Float32Array).summary;
check(productionHighDirect.rainWeightedSumMmh[0] === 80 && productionHighDirect.rainWeightedSumMmh[1] === 120
  && productionHighDirect.rainMaxMmh[0] === 80 && productionHighDirect.rainMaxMmh[1] === 120, 'Float32 direct 80 and 120 remain distinct');
const productionHazard = aggregateFixture([0, 0, 0, 0], [0, 0, 0, stormSeverity], [0, 0, 0, 0.61], fourToOne, Float32Array);
check(productionHazard.stormCoverageWeight[0] > 0 && productionHazard.stormMaxSeverity[0] > 0
  && productionHazard.hailCoverageWeight[0] > 0 && productionHazard.hailMaxSeverity[0] > 0, 'Float32 localized hazards remain represented');

const pyramid = new GeographicWeatherPyramid();
const referencePyramid = new GeographicWeatherPyramid(Float64Array);
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
check(centeredWeightError <= FLOAT64_TOLERANCE, 'centered contributions conserve each child support weight');

const field = parseRealWeatherCsv(fs.readFileSync(new URL('../data/mrl_z3_t+40min_376x239.csv', import.meta.url), 'utf8'));
setActiveWeatherField(field);
const frame = prepareGeographicFieldFrame(0);
const summaries = referencePyramid.evaluate([10], frame);
const float32Summaries = pyramid.evaluate([10], frame);
check(float32Summaries[14].rainWeightedSumMmh instanceof Float32Array, 'production summary uses Float32Array');
for (const level of LEVELS) checkFloat32SummaryStatistics(summaries[level], float32Summaries[level], level, 'real Float32-vs-Float64');

const float32WeightPyramid = new GeographicWeatherPyramid(Float64Array);
for (let level = 11; level <= 14; level++) {
  const contributions = float32WeightPyramid.topologyFor(level).contributionsToParent;
  contributions.weights = Float32Array.from(contributions.weights);
}
const float32WeightSummaries = float32WeightPyramid.evaluate([10], frame);
for (const level of LEVELS) {
  compareSummaryStatistics(summaries[level], float32WeightSummaries[level], level, 'real Float32 contribution weights');
}

function addGlobalConservationChecks(summary, reference, level) {
  for (const channel of ['totalWeight', 'rainWeightedSumMmh', 'stormCoverageWeight', 'stormWeightedSeverity', 'hailCoverageWeight', 'hailWeightedSeverity']) {
    const error = Math.abs(sum(summary[channel]) - sum(reference[channel]));
    console.log(`L${level} ${channel} global conservation error: ${error}`);
    check(error <= FLOAT64_TOLERANCE, `L${level} ${channel} global conservation`);
  }
  for (let thresholdIndex = 0; thresholdIndex < RAIN_COVERAGE_THRESHOLDS_MMH.length; thresholdIndex++) {
    const error = Math.abs(sum(summary.rainCoverageWeight[thresholdIndex]) - sum(reference.rainCoverageWeight[thresholdIndex]));
    console.log(`L${level} rain coverage@${RAIN_COVERAGE_THRESHOLDS_MMH[thresholdIndex]} global conservation error: ${error}`);
    check(error <= FLOAT64_TOLERANCE, `L${level} rain coverage global conservation`);
  }
  for (const channel of ['rainMaxMmh', 'stormMaxSeverity', 'hailMaxSeverity']) {
    const error = Math.abs(maximum(summary[channel]) - maximum(reference[channel]));
    console.log(`L${level} ${channel} maximum preservation error: ${error}`);
    check(error <= FLOAT64_TOLERANCE, `L${level} ${channel} maximum preservation`);
  }
}

const direct = summaries[14];
for (const level of LEVELS.slice(0, -1)) addGlobalConservationChecks(summaries[level], direct, level);

function reportFloat32GlobalConservation(summary, reference, level) {
  for (const channel of ['totalWeight', 'rainWeightedSumMmh', 'stormCoverageWeight', 'stormWeightedSeverity', 'hailCoverageWeight', 'hailWeightedSeverity']) {
    const error = Math.abs(sum(summary[channel]) - sum(reference[channel]));
    const relative = error / Math.max(Math.abs(sum(reference[channel])), RELATIVE_FLOOR);
    console.log(`Float32 L${level} ${channel} global conservation error: ${error} (relative ${relative})`);
    check(error <= float32AbsoluteTolerance(channel) && relative <= FLOAT32_RELATIVE_TOLERANCE, `Float32 L${level} ${channel} global conservation`);
  }
  for (let thresholdIndex = 0; thresholdIndex < RAIN_COVERAGE_THRESHOLDS_MMH.length; thresholdIndex++) {
    const error = Math.abs(sum(summary.rainCoverageWeight[thresholdIndex]) - sum(reference.rainCoverageWeight[thresholdIndex]));
    const relative = error / Math.max(Math.abs(sum(reference.rainCoverageWeight[thresholdIndex])), RELATIVE_FLOOR);
    console.log(`Float32 L${level} rain coverage@${RAIN_COVERAGE_THRESHOLDS_MMH[thresholdIndex]} global conservation error: ${error} (relative ${relative})`);
    check(error <= float32AbsoluteTolerance('rainCoverageWeight') && relative <= FLOAT32_RELATIVE_TOLERANCE, `Float32 L${level} rain coverage global conservation`);
  }
  for (const channel of ['rainMaxMmh', 'stormMaxSeverity', 'hailMaxSeverity']) {
    const error = Math.abs(maximum(summary[channel]) - maximum(reference[channel]));
    const relative = error / Math.max(Math.abs(maximum(reference[channel])), RELATIVE_FLOOR);
    console.log(`Float32 L${level} ${channel} maximum preservation error: ${error} (relative ${relative})`);
    check(error <= float32AbsoluteTolerance(channel) && relative <= FLOAT32_RELATIVE_TOLERANCE, `Float32 L${level} ${channel} maximum preservation`);
  }
}

const float32Direct = float32Summaries[14];
for (const level of LEVELS.slice(0, -1)) reportFloat32GlobalConservation(float32Summaries[level], float32Direct, level);

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
check(directL14Error <= FLOAT64_TOLERANCE, 'real L14 direct-sampling equivalence');

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
const composedL12 = aggregateWeatherSummary(pyramid.levels.get(12), direct, composedL14ToL12, null, Float64Array);
let recursiveError = 0;
for (const channel of CHANNELS) recursiveError = Math.max(recursiveError, maxAbsDiff(composedL12[channel], summaries[12][channel]));
for (let thresholdIndex = 0; thresholdIndex < RAIN_COVERAGE_THRESHOLDS_MMH.length; thresholdIndex++) {
  recursiveError = Math.max(recursiveError, maxAbsDiff(composedL12.rainCoverageWeight[thresholdIndex], summaries[12].rainCoverageWeight[thresholdIndex]));
}
console.log(`L14→L13→L12 recursive/composed maximum error: ${recursiveError}`);
check(recursiveError <= FLOAT64_TOLERANCE, 'recursive/composed aggregation equivalence');

const composedFloat32L12 = aggregateWeatherSummary(
  pyramid.levels.get(12),
  float32Direct,
  composedL14ToL12,
  null,
  Float32Array
);
let float32RecursiveError = 0;
for (const channel of CHANNELS) float32RecursiveError = Math.max(float32RecursiveError, maxAbsDiff(composedFloat32L12[channel], float32Summaries[12][channel]));
for (let thresholdIndex = 0; thresholdIndex < RAIN_COVERAGE_THRESHOLDS_MMH.length; thresholdIndex++) {
  float32RecursiveError = Math.max(float32RecursiveError, maxAbsDiff(composedFloat32L12.rainCoverageWeight[thresholdIndex], float32Summaries[12].rainCoverageWeight[thresholdIndex]));
}
console.log(`Float32 L14→L13→L12 recursive/composed maximum error: ${float32RecursiveError}`);
checkFloat32SummaryStatistics(composedFloat32L12, float32Summaries[12], 12, 'Float32 recursive-vs-composed');

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

// Phase 4 renderer mappings consume physical summaries only; no WebGL is needed.
const sharedDots = new GeographicDotsLayer(pyramid);
const sharedSquares = new GeographicSquaresLayer(pyramid);
check(sharedDots.weatherPyramid === pyramid && sharedSquares.weatherPyramid === pyramid, 'Dots and Squares share one GeographicWeatherPyramid instance');

function mapFixture(summary) {
  summary.samples = summary.samples.map(() => ({ spacing: 0.01 }));
  return { dots: mapDotsWeatherSummary(summary), squares: mapSquaresWeatherSummary(summary) };
}

function mapDotsFixture(summary, level, spacing = 0.01) {
  summary.level = level;
  summary.samples = summary.samples.map(() => ({ spacing }));
  return mapDotsWeatherSummary(summary);
}

let dotsL14Error = 0;
let squaresL14Error = 0;
let hazardL14Error = 0;
const directDots = mapDotsWeatherSummary(float32Summaries[14]);
const directSquares = mapSquaresWeatherSummary(float32Summaries[14]);
for (let index = 0; index < float32Summaries[14].samples.length; index++) {
  const sample = float32Summaries[14].samples[index];
  const value = frame.sample(sample.lngLat[0], sample.lngLat[1]);
  dotsL14Error = Math.max(dotsL14Error,
    Math.abs(directDots.rainRadius[index] - Math.fround(rainMmhToRadius(Math.fround(value.rainMmh), sample.spacing))),
    Math.abs(directDots.strongRadius[index] - Math.fround(dotsStrongRainMmhToRadius(Math.fround(value.rainMmh), sample.spacing, DOTS_STRONG_RAIN_FULL_MMH_DEFAULT))));
  const directHazard = { stormRadius: 0, hailRadius: 0 };
  geographicHazardRadii({ storm: Math.fround(value.storm), hail: Math.fround(value.hail) }, sample.spacing, directHazard);
  hazardL14Error = Math.max(hazardL14Error,
    Math.abs(directDots.stormRadius[index] - Math.fround(directHazard.stormRadius)),
    Math.abs(directDots.hailRadius[index] - Math.fround(directHazard.hailRadius)));
  squaresL14Error = Math.max(squaresL14Error,
    Math.abs(directSquares.rainWetMeanMmh[index] - Math.fround(value.rainMmh)),
    Math.abs(directSquares.rainCoverage[index] - (value.rainMmh >= 0.05 ? 1 : 0)),
    Math.abs(directSquares.stormMeanSeverity[index] - Math.fround(value.storm)),
    Math.abs(directSquares.stormCoverage[index] - (value.storm > 0 ? 1 : 0)),
    Math.abs(directSquares.hailMeanSeverity[index] - Math.fround(value.hail)),
    Math.abs(directSquares.hailCoverage[index] - (value.hail > 0 ? 1 : 0)));
}
console.log(`Phase 4 L14 errors: Dots rain/strong=${dotsL14Error}, Dots hazards=${hazardL14Error}, Squares inputs=${squaresL14Error}`);
// Weather summaries are Float32. These bounds cover the final Float32 glyph
// state and the largest observed physical rain value's Float32 ULP.
check(dotsL14Error <= 1e-5, 'Dots L14 rain/strong mapping equivalence');
check(hazardL14Error <= 5e-5, 'Dots L14 hazard mapping equivalence');
check(squaresL14Error <= 0.1, 'Squares L14 mapping equivalence');

const l14StrongRainValues = [1.6, 2.0, 2.5, 3.0];
let l14StrongFixtureError = 0;
for (const rainMmh of l14StrongRainValues) {
  const fixture = directFixture([rainMmh], [], [], Float32Array);
  const mapped = mapDotsFixture(fixture.summary, 14);
  const expected = Math.fround(dotsStrongRainMmhToRadius(Math.fround(rainMmh), 0.01, DOTS_STRONG_RAIN_FULL_MMH_DEFAULT));
  const error = Math.abs(mapped.strongRadius[0] - expected);
  l14StrongFixtureError = Math.max(l14StrongFixtureError, error);
  console.log(`Dots L14 strong fixture rain=${rainMmh}: mapped=${mapped.strongRadius[0]}, expected=${expected}, error=${error}`);
  check(error <= 1e-7, `Dots L14 strong fixture ${rainMmh} mm/h direct equivalence`);
}
console.log(`Dots L14 strong fixture maximum error around onset/coarse threshold: ${l14StrongFixtureError}`);

const directHazardFixtures = [
  { name: 'below visual threshold', storm: INTENSITY_THRESHOLDS.storm * 0.45 - 0.001, hail: INTENSITY_THRESHOLDS.hail * 0.45 - 0.001 },
  { name: 'just above visual threshold', storm: INTENSITY_THRESHOLDS.storm * 0.45 + 0.001, hail: INTENSITY_THRESHOLDS.hail * 0.45 + 0.001 },
  { name: 'clearly strong', storm: 0.8, hail: 0.7 }
];
let directHazardFixtureError = 0;
for (const fixtureValues of directHazardFixtures) {
  const fixture = directFixture([0], [fixtureValues.storm], [fixtureValues.hail], Float32Array);
  const mapped = mapDotsFixture(fixture.summary, 14);
  const expected = { stormRadius: 0, hailRadius: 0 };
  geographicHazardRadii({ storm: Math.fround(fixtureValues.storm), hail: Math.fround(fixtureValues.hail) }, 0.01, expected);
  const stormError = Math.abs(mapped.stormRadius[0] - Math.fround(expected.stormRadius));
  const hailError = Math.abs(mapped.hailRadius[0] - Math.fround(expected.hailRadius));
  directHazardFixtureError = Math.max(directHazardFixtureError, stormError, hailError);
  console.log(`Dots L14 hazard fixture ${fixtureValues.name}: stormError=${stormError}, hailError=${hailError}`);
  check(stormError <= 1e-7 && hailError <= 1e-7, `Dots L14 hazard fixture ${fixtureValues.name} direct equivalence`);
}
console.log(`Dots L14 direct hazard fixture maximum error: ${directHazardFixtureError}`);

const tinyHailFixture = directFixture([0], [0.8], [0.01], Float32Array);
const tinyHailMapped = mapDotsFixture(tinyHailFixture.summary, 13);
console.log(`Dots tiny-hail priority fixture: storm=${tinyHailMapped.stormRadius[0]}, hail=${tinyHailMapped.hailRadius[0]}`);
check(tinyHailMapped.stormRadius[0] > 0 && tinyHailMapped.hailRadius[0] === 0, 'tiny hail does not suppress visible storm');

const localizedCoarseHazard = createWeatherSummary({ level: 13, samples: [{}] }, null, Float64Array);
localizedCoarseHazard.totalWeight[0] = 1;
localizedCoarseHazard.stormCoverageWeight[0] = 0.25;
localizedCoarseHazard.stormWeightedSeverity[0] = 0.25 * 0.025;
localizedCoarseHazard.stormMaxSeverity[0] = 0.1;
const localizedCoarseMapped = mapDotsFixture(localizedCoarseHazard, 13);
const denserCoarseHazard = createWeatherSummary({ level: 13, samples: [{}] }, null, Float64Array);
denserCoarseHazard.totalWeight[0] = 1;
denserCoarseHazard.stormCoverageWeight[0] = 1;
denserCoarseHazard.stormWeightedSeverity[0] = 0.025;
denserCoarseHazard.stormMaxSeverity[0] = 0.1;
const denserCoarseMapped = mapDotsFixture(denserCoarseHazard, 13);
console.log(`Dots localized coarse hazard: lowCoverage=${localizedCoarseMapped.stormRadius[0]}, fullCoverage=${denserCoarseMapped.stormRadius[0]}`);
check(localizedCoarseMapped.stormRadius[0] > 0, 'localized coarse hazard retains a visible peak');
check(localizedCoarseMapped.stormRadius[0] < denserCoarseMapped.stormRadius[0], 'coarse hazard radius decreases with coverage');

const visibleHailFixture = directFixture([0], [0.8], [0.7], Float32Array);
const visibleHailMapped = mapDotsFixture(visibleHailFixture.summary, 13);
console.log(`Dots visible-hail priority fixture: storm=${visibleHailMapped.stormRadius[0]}, hail=${visibleHailMapped.hailRadius[0]}`);
check(visibleHailMapped.hailRadius[0] > 0 && visibleHailMapped.stormRadius[0] === 0, 'visible hail wins Dots priority');

const mappingUniform = mapFixture(aggregateWeatherSummary(fixtureParent, directFixture([5, 5, 5, 5]).summary, fourToOne, null, Float64Array));
const mappingLocalized = mapFixture(aggregateWeatherSummary(fixtureParent, directFixture([0, 0, 0, 20]).summary, fourToOne, null, Float64Array));
console.log(`Phase 4 uniform: dots=${mappingUniform.dots.rainRadius[0]}, square wet=${mappingUniform.squares.rainWetMeanMmh[0]}, coverage=${mappingUniform.squares.rainCoverage[0]}`);
console.log(`Phase 4 localized: dots=${mappingLocalized.dots.rainRadius[0]}, strong=${mappingLocalized.dots.strongRadius[0]}, square wet=${mappingLocalized.squares.rainWetMeanMmh[0]}, coverage=${mappingLocalized.squares.rainCoverage[0]}`);
check(mappingUniform.dots.rainRadius[0] !== mappingLocalized.dots.rainRadius[0], 'Dots distinguish uniform and localized rain');
check(mappingUniform.squares.rainCoverage[0] === 1 && mappingLocalized.squares.rainCoverage[0] === 0.25, 'Squares retain uniform/localized coverage distinction');
check(mappingUniform.squares.rainWetMeanMmh[0] === 5 && mappingLocalized.squares.rainWetMeanMmh[0] === 20, 'Squares retain wet-area intensity distinction');
check(mappingLocalized.dots.strongRadius[0] > 0, 'localized strong rain remains present');

const mappingHazard = mapFixture(aggregateWeatherSummary(fixtureParent, directFixture([0, 0, 0, 0], [0, 0, 0, stormSeverity], [0, 0, 0, 0.61]).summary, fourToOne, null, Float64Array));
console.log(`Phase 4 localized hazards: dots storm=${mappingHazard.dots.stormRadius[0]}, hail=${mappingHazard.dots.hailRadius[0]}, square stormCoverage=${mappingHazard.squares.stormCoverage[0]}, hailCoverage=${mappingHazard.squares.hailCoverage[0]}`);
check(mappingHazard.dots.hailRadius[0] > 0 && mappingHazard.dots.stormRadius[0] === 0, 'localized hail retains Dots priority');
check(mappingHazard.squares.stormCoverage[0] > 0 && mappingHazard.squares.hailCoverage[0] > 0, 'localized hazards remain in Squares summaries');

const mappingHigh = mapFixture(aggregateWeatherSummary(fixtureParent, directFixture([80, 120]).summary, {
  offsets: new Uint32Array([0, 1, 2]), parentIndices: new Uint32Array([0, 0]), weights: new Float64Array([0.5, 0.5])
}, null, Float64Array));
check(mappingHigh.dots.strongRadius[0] > 0 && mappingHigh.squares.rainWetMeanMmh[0] === 100, 'renderer mapping preserves physical high-rain inputs');

const dotsSource = fs.readFileSync(new URL('../src/engine/geographic-dots-layer.js', import.meta.url), 'utf8');
const squaresSource = fs.readFileSync(new URL('../src/engine/geographic-squares-layer.js', import.meta.url), 'utf8');
check(!dotsSource.includes('GeographicSymbolPyramid') && !dotsSource.includes('reduceState('), 'Dots has no renderer-owned weather reduction');
check(!squaresSource.includes('GeographicSquarePyramid') && !squaresSource.includes('stormMax *'), 'Squares has no renderer-owned weather reduction');

console.log(failures ? `VERIFICATION FAILED: ${failures}` : 'VERIFICATION PASSED');
if (failures) process.exitCode = 1;
