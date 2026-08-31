import { setActiveWeatherField } from '../src/engine/geography.js';
import { loadRealWeatherFixture } from './real-weather-fixture.mjs';
import {
  aggregateWeatherSummary,
  buildCenteredContributionRelation,
  evaluateDirectWeatherSummary,
  GeographicWeatherPyramid,
  WEATHER_REFERENCE_LEVEL,
  WEATHER_SUMMARY_PROFILE_GENERIC,
  WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY
} from '../src/engine/geographic-weather-pyramid.js';
import {
  canonicalWindowFromMercatorBounds,
  GeographicLodTopology,
  lngLatToMercator,
  lodRangeForStableLevel
} from '../src/engine/geographic-lod.js';
import { mapDotsWeatherSummary } from '../src/engine/geographic-dots-layer.js';
import { mapSquaresWeatherSummary } from '../src/engine/geographic-squares-layer.js';
import {
  GPU_PHYSICAL_SUMMARY_CHANNELS,
  GPU_PHYSICAL_SUMMARY_LEVELS,
  GPU_PHYSICAL_SUMMARY_MAX_CONTRIBUTIONS,
  GPU_PHYSICAL_SUMMARY_FRAGMENT_SOURCE,
  validateReverseCenteredRelation
} from '../src/engine/gpu-physical-summary.js';

const { metadata, weather } = await loadRealWeatherFixture();
setActiveWeatherField(weather);

function fail(ok, message) {
  if (!ok) throw new Error(message);
}

function maxError(left, right) {
  fail(left.length === right.length, 'reference arrays have different lengths.');
  let result = 0;
  for (let index = 0; index < left.length; index++) result = Math.max(result, Math.abs(left[index] - right[index]));
  return result;
}

function cpuSummarySchema(summary, level) {
  fail(summary?.profile === WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY, `L${level} is not using the explicit rain-only profile.`);
  fail(summary.level === level && summary.representation === 'dense-summary', `L${level} summary representation changed.`);
  fail(summary.rainCoverageWeight.length === 2, `L${level} rain-only summary does not have exactly two coverage channels.`);
  for (const field of ['totalWeight', 'rainWeightedSumMmh', 'rainMaxMmh']) {
    fail(summary[field].length === summary.levelData.count, `L${level} summary field has the wrong length.`);
  }
  for (const coverage of summary.rainCoverageWeight) {
    fail(coverage.length === summary.levelData.count, `L${level} coverage field has the wrong length.`);
  }
}

function equivalentMapped(reference, comparison, fields) {
  return fields.reduce((result, field) => Math.max(result, maxError(reference[field], comparison[field])), 0);
}

const [centerX, centerY] = lngLatToMercator(45, 43);
const windows = [
  canonicalWindowFromMercatorBounds({ minX: centerX - .004, maxX: centerX + .004, minY: centerY - .004, maxY: centerY + .004 }),
  canonicalWindowFromMercatorBounds({ minX: centerX - .006, maxX: centerX + .003, minY: centerY - .003, maxY: centerY + .005 }),
  canonicalWindowFromMercatorBounds({ minX: centerX - .002, maxX: centerX + .007, minY: centerY - .006, maxY: centerY + .002 })
];
const times = [0, 1 / (metadata.time.count - 1), .123, .347, .5, .777, .91, 1];
let summaryChecks = 0;
let mappedChecks = 0;
let relationChecks = 0;
let maximumCpuChainError = 0;
let firstWindowCost = null;

for (const window of windows) {
  const topology = new GeographicLodTopology(window, lodRangeForStableLevel(10));
  const pyramid = new GeographicWeatherPyramid(Float32Array, topology);
  for (const level of GPU_PHYSICAL_SUMMARY_LEVELS) {
    const relation = buildCenteredContributionRelation(topology.levels.get(level + 1), topology.levels.get(level));
    const relationResult = validateReverseCenteredRelation(topology.levels.get(level + 1), topology.levels.get(level));
    fail(relationResult.maximumContributions <= GPU_PHYSICAL_SUMMARY_MAX_CONTRIBUTIONS, `L${level} exceeds shader relation capacity.`);
    fail(relation.kind === 'separable-centered', `L${level} did not use centered separable contributions.`);
    if (!firstWindowCost) {
      firstWindowCost = {};
      for (const outputLevel of GPU_PHYSICAL_SUMMARY_LEVELS) {
        const output = topology.levels.get(outputLevel);
        const fine = topology.levels.get(outputLevel + 1);
        const relationInfo = validateReverseCenteredRelation(fine, output);
        firstWindowCost[outputLevel] = {
          outputSamples: output.count,
          finerSamplesProcessed: fine.count,
          passes: 1,
          persistentABBytes: output.count * 24,
          relationMetadataGpuBytes: output.count * 72,
          peakTransientScratchBytes: 0,
          maximumReverseContributions: relationInfo.maximumContributions
        };
      }
    }
    relationChecks++;
  }
  for (const normalizedTime of times) {
    const frame = weather.prepareFrame(normalizedTime);
    const summaries = pyramid.evaluate([10, 11, 12], frame);
    for (const level of GPU_PHYSICAL_SUMMARY_LEVELS) {
      cpuSummarySchema(summaries[level], level);
      const dots = mapDotsWeatherSummary(summaries[level]);
      const squares = mapSquaresWeatherSummary(summaries[level]);
      fail(dots.layout === 'rain-only' && squares.layout === 'rain-only', `L${level} presentation mapping left the rain-only profile.`);
      fail(Number.isFinite(equivalentMapped(dots, dots, ['rainRadius', 'strongRadius'])), `L${level} Dots mapping is not finite.`);
      fail(Number.isFinite(equivalentMapped(squares, squares, ['rainWetMeanMmh', 'rainCoverage'])), `L${level} Squares mapping is not finite.`);
      summaryChecks++;
      mappedChecks++;
    }

    // Establish the exact non-fused reference ordering independently: direct
    // physical L13 values are stored first, then the same centered relation
    // is applied recursively. This is the oracle used by the GPU passes.
    const level13 = topology.levels.get(WEATHER_REFERENCE_LEVEL);
    const geometry = pyramid.prepareSamplingGeometry(WEATHER_REFERENCE_LEVEL, frame);
    const genericFrame = Object.create(frame);
    genericFrame.weatherSummaryProfile = WEATHER_SUMMARY_PROFILE_GENERIC;
    const direct = evaluateDirectWeatherSummary(
      level13,
      genericFrame,
      null,
      Float32Array,
      geometry,
      pyramid.totalWeights.get(WEATHER_REFERENCE_LEVEL)
    );
    let chain = direct;
    for (const level of [12, 11, 10]) {
      chain = aggregateWeatherSummary(
        topology.levels.get(level),
        chain,
        pyramid.centeredRelations.get(level + 1),
        null,
        Float32Array,
        pyramid.totalWeights.get(level)
      );
      maximumCpuChainError = Math.max(
        maximumCpuChainError,
        maxError(chain.totalWeight, summaries[level].totalWeight),
        maxError(chain.rainWeightedSumMmh, summaries[level].rainWeightedSumMmh),
        maxError(chain.rainMaxMmh, summaries[level].rainMaxMmh),
        maxError(chain.rainCoverageWeight[0], summaries[level].rainCoverageWeight[0]),
        maxError(chain.rainCoverageWeight[4], summaries[level].rainCoverageWeight[1])
      );
    }
    fail(maximumCpuChainError <= 1e-6, 'fused CPU summary no longer matches direct-L13 recursive ordering.');
  }
}

fail(GPU_PHYSICAL_SUMMARY_CHANNELS.length === 5, 'GPU summary channel contract changed unexpectedly.');
fail(GPU_PHYSICAL_SUMMARY_FRAGMENT_SOURCE.includes('u_inputKind'), 'GPU summary shader does not distinguish direct and recursive inputs.');
fail(GPU_PHYSICAL_SUMMARY_FRAGMENT_SOURCE.includes('rain>=0.05') && GPU_PHYSICAL_SUMMARY_FRAGMENT_SOURCE.includes('rain>=2.5'), 'GPU summary shader lost threshold coverage semantics.');

console.log(`GPU physical-summary contract verification passed: windows=${windows.length}, times=${times.length}, summaries=${summaryChecks}, mappings=${mappedChecks}, relations=${relationChecks}, maxCpuOrderingError=${maximumCpuChainError}`);
console.log(`GPU summary cost for first window: ${JSON.stringify(firstWindowCost)}`);
console.log('CPU reference contract: direct reconstructed L13 -> recursive centered physical summaries L12/L11/L10 -> per-keyframe Dots/Squares mapping -> renderer temporal interpolation.');
console.log('GPU readback metrics: not run in Node; browser-only window.__dotFieldGpuWeather.validatePhysicalSummary() provides explicit diagnostic readback and presentation comparison.');
