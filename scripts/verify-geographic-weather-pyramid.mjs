import fs from 'node:fs';
import { RAIN_COVERAGE_THRESHOLDS_MMH, WEATHER_REFERENCE_LEVEL, GeographicWeatherPyramid, aggregateWeatherSummary, createWeatherSummary } from '../src/engine/geographic-weather-pyramid.js';
import { prepareGeographicFieldFrame, setActiveWeatherField, WEATHER_REGION } from '../src/engine/geography.js';
import { parseRealWeatherCsv } from '../src/engine/real-weather.js';
import { GeographicDotsLayer, mapDotsWeatherSummary } from '../src/engine/geographic-dots-layer.js';
import { GeographicSquaresLayer, mapSquaresWeatherSummary } from '../src/engine/geographic-squares-layer.js';
import { DOTS_STRONG_RAIN_FULL_MMH, dotsStrongRainMmhToRadius, rainMmhToRadius } from '../src/engine/precipitation-mapping.js';
import { geographicHazardRadii } from '../src/engine/hazard-renderer.js';
import { canonicalWindowFromMercatorBounds, GeographicLodTopology, MAX_DISPLAY_GRID_LEVEL, MAX_GRID_LEVEL, MIN_GRID_LEVEL, mercatorToLngLat, lngLatToMercator } from '../src/engine/geographic-lod.js';
import { SCALAR_GRID_LEVEL } from '../src/engine/geographic-scalar-lattice.js';

const LEVELS = [10, 11, 12, 13, 14, 15];
const AGGREGATE_LEVELS = [10, 11, 12];
const DIRECT_LEVELS = [13, 14, 15];
const FLOAT64_TOLERANCE = 1e-9;
const FLOAT32_TOLERANCE = 1e-4;
let failures = 0;
function check(condition, message) { if (!condition) { failures++; console.error(`FAIL ${message}`); } }
function max(value, candidate) { return Math.max(value, candidate); }
function sum(values) { let total = 0; for (const value of values) total += value; return total; }
function maximum(values) { let result = 0; for (const value of values) result = Math.max(result, value); return result; }
function rainMean(summary, index) { return summary.totalWeight[index] ? summary.rainWeightedSumMmh[index] / summary.totalWeight[index] : 0; }
function coverageIndex(threshold) { return RAIN_COVERAGE_THRESHOLDS_MMH.indexOf(threshold); }

function directFixture(level, rainValues, stormValues = [], hailValues = [], ArrayType = Float64Array) {
  const levelData = { level, samples: rainValues.map(() => ({ spacing: 0.01 })) };
  const summary = createWeatherSummary(levelData, null, ArrayType);
  for (let index = 0; index < rainValues.length; index++) {
    const rainMmh = rainValues[index]; const storm = stormValues[index] || 0; const hail = hailValues[index] || 0;
    summary.totalWeight[index] = 1; summary.rainWeightedSumMmh[index] = rainMmh; summary.rainMaxMmh[index] = rainMmh;
    for (let threshold = 0; threshold < RAIN_COVERAGE_THRESHOLDS_MMH.length; threshold++) summary.rainCoverageWeight[threshold][index] = rainMmh >= RAIN_COVERAGE_THRESHOLDS_MMH[threshold] ? 1 : 0;
    summary.stormCoverageWeight[index] = storm > 0 ? 1 : 0; summary.stormWeightedSeverity[index] = storm; summary.stormMaxSeverity[index] = storm;
    summary.hailCoverageWeight[index] = hail > 0 ? 1 : 0; summary.hailWeightedSeverity[index] = hail; summary.hailMaxSeverity[index] = hail;
  }
  return summary;
}

function composeContributions(first, second) {
  const offsets = new Uint32Array(first.offsets.length); const parentIndices = []; const weights = [];
  for (let child = 0; child < first.offsets.length - 1; child++) {
    for (let index = first.offsets[child]; index < first.offsets[child + 1]; index++) {
      const middle = first.parentIndices[index];
      for (let next = second.offsets[middle]; next < second.offsets[middle + 1]; next++) { parentIndices.push(second.parentIndices[next]); weights.push(first.weights[index] * second.weights[next]); }
    }
    offsets[child + 1] = parentIndices.length;
  }
  return { offsets, parentIndices: Uint32Array.from(parentIndices), weights: Float64Array.from(weights) };
}

function maxSummaryDifference(left, right) {
  let error = 0;
  for (const field of ['totalWeight', 'rainWeightedSumMmh', 'rainMaxMmh', 'stormCoverageWeight', 'stormWeightedSeverity', 'stormMaxSeverity', 'hailCoverageWeight', 'hailWeightedSeverity', 'hailMaxSeverity']) {
    for (let index = 0; index < left[field].length; index++) error = max(error, Math.abs(left[field][index] - right[field][index]));
  }
  for (let threshold = 0; threshold < RAIN_COVERAGE_THRESHOLDS_MMH.length; threshold++) for (let index = 0; index < left.samples.length; index++) error = max(error, Math.abs(left.rainCoverageWeight[threshold][index] - right.rainCoverageWeight[threshold][index]));
  return error;
}

function localGridSpacingKm(level, latitude) {
  const step = 1 / 2 ** level;
  const centerY = (1 - Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360)) / Math.PI) / 2;
  const [, north] = mercatorToLngLat(0.5, centerY - step / 2);
  const [, south] = mercatorToLngLat(0.5, centerY + step / 2);
  return { eastWest: 111.32 * Math.cos(latitude * Math.PI / 180) * 360 * step, northSouth: 111.32 * Math.abs(north - south) };
}

const field = parseRealWeatherCsv(fs.readFileSync(new URL('../data/mrl_z3_t+40min_376x239.csv', import.meta.url), 'utf8'));
setActiveWeatherField(field);
const frame = prepareGeographicFieldFrame(0);
const [referenceLongitude, referenceLatitude] = WEATHER_REGION.center;
const [referenceX, referenceY] = lngLatToMercator(referenceLongitude, referenceLatitude);
const testWindow = canonicalWindowFromMercatorBounds({ minX: referenceX - 0.004, maxX: referenceX + 0.004, minY: referenceY - 0.004, maxY: referenceY + 0.004 });
const sourceEastWestKm = 111.32 * Math.cos(referenceLatitude * Math.PI / 180) * field.longitudeSpacing;
const sourceNorthSouthKm = 111.32 * field.latitudeSpacing;
console.log(`source grid: ${field.longitudes.length}x${field.latitudes.length}, longitudeSpacing=${field.longitudeSpacing}°, latitudeSpacing=${field.latitudeSpacing}°`);
console.log(`source ground spacing near ${referenceLongitude},${referenceLatitude}: east-west=${sourceEastWestKm.toFixed(4)} km, north-south=${sourceNorthSouthKm.toFixed(4)} km`);
for (const level of [12, 13, 14, 15]) { const spacing = localGridSpacingKm(level, referenceLatitude); console.log(`L${level} local Mercator spacing: east-west=${spacing.eastWest.toFixed(4)} km, north-south=${spacing.northSouth.toFixed(4)} km`); }
console.log(`WEATHER_REFERENCE_LEVEL=L${WEATHER_REFERENCE_LEVEL}; parsed source spacing supports L13 as the closest practical dyadic canonical scale.`);
check(WEATHER_REFERENCE_LEVEL === 13, 'L13 is the explicit weather reference level');
check(MAX_DISPLAY_GRID_LEVEL === 15 && MAX_GRID_LEVEL === 15, 'display and canonical identity both stop at L15');
check(SCALAR_GRID_LEVEL === 14, 'scalar lattice remains explicitly fixed at L14');

let sourceNodeError = 0;
for (const longitudeIndex of [0, Math.floor(field.longitudes.length / 2), field.longitudes.length - 1]) for (const latitudeIndex of [0, Math.floor(field.latitudes.length / 2), field.latitudes.length - 1]) {
  const index = field.index(longitudeIndex, latitudeIndex); const value = field.sample(field.longitudes[longitudeIndex], field.latitudes[latitudeIndex]);
  sourceNodeError = max(sourceNodeError, Math.abs(value.rainMmh - field.rainMmh[index])); sourceNodeError = max(sourceNodeError, Math.abs(value.storm - field.storm[index])); sourceNodeError = max(sourceNodeError, Math.abs(value.hail - field.hail[index]));
}
console.log(`representative exact source-node error: ${sourceNodeError}`); check(sourceNodeError <= FLOAT64_TOLERANCE, 'source nodes preserve rain, storm, and hail values');

const fullTopology = new GeographicLodTopology(testWindow, { minLevel: MIN_GRID_LEVEL, maxLevel: MAX_DISPLAY_GRID_LEVEL });
const pyramid = new GeographicWeatherPyramid(Float32Array, fullTopology); const referencePyramid = new GeographicWeatherPyramid(Float64Array, fullTopology);
const summaries = referencePyramid.evaluate(LEVELS, frame); const float32Summaries = pyramid.evaluate(LEVELS, frame);
check(float32Summaries[15].rainWeightedSumMmh instanceof Float32Array, 'production summaries use Float32 storage at L15');
for (const requested of [[12, 13], [13, 14], [14, 15]]) {
  const mixed = referencePyramid.evaluate(requested, frame);
  for (const level of requested) check(maxSummaryDifference(mixed[level], summaries[level]) <= FLOAT64_TOLERANCE, `mixed request [${requested.join(', ')}] evaluates L${level} with the correct side of the boundary`);
}

let centeredWeightError = 0; let centeredEntries = 0; let centeredMappingBytes = 0;
for (let level = MIN_GRID_LEVEL + 1; level <= WEATHER_REFERENCE_LEVEL; level++) {
  const contributions = pyramid.topologyFor(level).contributionsToParent; check(Boolean(contributions), `L${level}->L${level - 1} has centered aggregate contributions`);
  for (let child = 0; child < contributions.offsets.length - 1; child++) { let weight = 0; for (let index = contributions.offsets[child]; index < contributions.offsets[child + 1]; index++) { weight += contributions.weights[index]; centeredEntries++; } centeredWeightError = max(centeredWeightError, Math.abs(weight - 1)); }
  centeredMappingBytes += contributions.offsets.byteLength + contributions.parentIndices.byteLength + contributions.weights.byteLength;
}
check(pyramid.topologyFor(14).contributionsToParent === null && pyramid.topologyFor(15).contributionsToParent === null, 'L14/L15 have no physical centered aggregation mapping');
console.log(`aggregate contribution support error: ${centeredWeightError}; entries=${centeredEntries}; bytes=${centeredMappingBytes}`); check(centeredWeightError <= FLOAT64_TOLERANCE, 'aggregate contribution weights conserve each child support');

for (const level of DIRECT_LEVELS) {
  const summary = summaries[level]; const compact = float32Summaries[level]; let directError = 0; let compactError = 0; let highRain = 0;
  for (let index = 0; index < summary.samples.length; index++) {
    const sample = summary.samples[index]; const value = frame.sample(sample.lngLat[0], sample.lngLat[1]);
    directError = max(directError, Math.abs(rainMean(summary, index) - value.rainMmh)); directError = max(directError, Math.abs(summary.rainMaxMmh[index] - value.rainMmh)); directError = max(directError, Math.abs(summary.stormWeightedSeverity[index] - value.storm)); directError = max(directError, Math.abs(summary.hailWeightedSeverity[index] - value.hail));
    compactError = max(compactError, Math.abs(compact.rainWeightedSumMmh[index] - value.rainMmh)); compactError = max(compactError, Math.abs(compact.stormWeightedSeverity[index] - value.storm)); compactError = max(compactError, Math.abs(compact.hailWeightedSeverity[index] - value.hail)); highRain = Math.max(highRain, value.rainMmh);
  }
  console.log(`L${level} direct field error=${directError}, Float32 storage error=${compactError}, maximum sampled physical rain=${highRain}`); check(directError <= FLOAT64_TOLERANCE, `L${level} direct field equivalence`); check(compactError <= FLOAT32_TOLERANCE, `L${level} Float32 direct storage equivalence`);
}

function inheritedIdentityCheck(lowerLevel, higherLevel) {
  const lower = summaries[lowerLevel]; const higher = summaries[higherLevel]; const higherById = new Map(higher.samples.map((sample, index) => [sample.id, index])); let missing = 0; let positionError = 0; let valueError = 0;
  for (let index = 0; index < lower.samples.length; index++) {
    const higherIndex = higherById.get(lower.samples[index].id); if (higherIndex === undefined) { missing++; continue; }
    positionError = max(positionError, Math.abs(lower.samples[index].mercator[0] - higher.samples[higherIndex].mercator[0])); positionError = max(positionError, Math.abs(lower.samples[index].mercator[1] - higher.samples[higherIndex].mercator[1]));
    valueError = max(valueError, Math.abs(lower.rainWeightedSumMmh[index] - higher.rainWeightedSumMmh[higherIndex])); valueError = max(valueError, Math.abs(lower.stormWeightedSeverity[index] - higher.stormWeightedSeverity[higherIndex])); valueError = max(valueError, Math.abs(lower.hailWeightedSeverity[index] - higher.hailWeightedSeverity[higherIndex]));
  }
  console.log(`L${lowerLevel}->L${higherLevel} inherited identity: missing=${missing}, position=${positionError}, value=${valueError}`); check(missing === 0 && positionError === 0 && valueError <= FLOAT64_TOLERANCE, `L${lowerLevel}->L${higherLevel} exact inherited identity`);
}
inheritedIdentityCheck(13, 14); inheritedIdentityCheck(14, 15);

function directRefinementCheck(lowerLevel, higherLevel) {
  const lower = summaries[lowerLevel]; const higher = summaries[higherLevel]; const lowerById = new Set(lower.samples.map((sample) => sample.id)); const lowerByCanonical = new Map(lower.samples.map((sample, index) => [`${sample.canonicalX}:${sample.canonicalY}`, index])); let directError = 0; let interpolationDifference = 0; let newPoints = 0;
  for (let index = 0; index < higher.samples.length; index++) {
    const sample = higher.samples[index]; if (lowerById.has(sample.id)) continue; newPoints++;
    const value = frame.sample(sample.lngLat[0], sample.lngLat[1]); directError = max(directError, Math.abs(higher.rainWeightedSumMmh[index] - value.rainMmh));
    const parentStep = 2 ** (MAX_GRID_LEVEL - lowerLevel); const parentX = Math.floor(sample.canonicalX / parentStep) * parentStep; const parentY = Math.floor(sample.canonicalY / parentStep) * parentStep;
    const xFraction = (sample.canonicalX - parentX) / parentStep; const yFraction = (sample.canonicalY - parentY) / parentStep;
    const indices = [lowerByCanonical.get(`${parentX}:${parentY}`), lowerByCanonical.get(`${parentX + parentStep}:${parentY}`), lowerByCanonical.get(`${parentX}:${parentY + parentStep}`), lowerByCanonical.get(`${parentX + parentStep}:${parentY + parentStep}`)];
    if (indices.every((candidate) => candidate !== undefined)) {
      const [a, b, c, d] = indices.map((candidate) => lower.rainWeightedSumMmh[candidate]);
      const interpolated = (a + (b - a) * xFraction) + ((c + (d - c) * xFraction) - (a + (b - a) * xFraction)) * yFraction;
      interpolationDifference = max(interpolationDifference, Math.abs(higher.rainWeightedSumMmh[index] - interpolated));
    }
  }
  console.log(`L${lowerLevel}->L${higherLevel} new direct samples=${newPoints}, direct error=${directError}, maximum difference from lower-summary bilinear interpolation=${interpolationDifference}`); check(newPoints > 0 && directError <= FLOAT64_TOLERANCE, `L${higherLevel}-only points sample the reconstructed field directly`); check(interpolationDifference > 1e-6, `L${higherLevel}-only points are not interpolated from lower summaries`);
}
directRefinementCheck(13, 14); directRefinementCheck(14, 15);

for (const level of AGGREGATE_LEVELS) {
  for (const fieldName of ['totalWeight', 'rainWeightedSumMmh', 'stormCoverageWeight', 'stormWeightedSeverity', 'hailCoverageWeight', 'hailWeightedSeverity']) { const error = Math.abs(sum(summaries[level][fieldName]) - sum(summaries[13][fieldName])); console.log(`L13->L${level} ${fieldName} conservation error=${error}`); check(error <= FLOAT64_TOLERANCE, `L13->L${level} ${fieldName} conservation`); }
  for (let threshold = 0; threshold < RAIN_COVERAGE_THRESHOLDS_MMH.length; threshold++) check(Math.abs(sum(summaries[level].rainCoverageWeight[threshold]) - sum(summaries[13].rainCoverageWeight[threshold])) <= FLOAT64_TOLERANCE, `L13->L${level} rain coverage conservation at ${RAIN_COVERAGE_THRESHOLDS_MMH[threshold]}`);
  for (const fieldName of ['rainMaxMmh', 'stormMaxSeverity', 'hailMaxSeverity']) check(Math.abs(maximum(summaries[level][fieldName]) - maximum(summaries[13][fieldName])) <= FLOAT64_TOLERANCE, `L13->L${level} ${fieldName} maximum preservation`);
}
const composed = composeContributions(pyramid.topologyFor(13).contributionsToParent, pyramid.topologyFor(12).contributionsToParent);
const composedL11 = aggregateWeatherSummary(pyramid.levels.get(11), summaries[13], composed, null, Float64Array);
let recursiveError = maxSummaryDifference(composedL11, summaries[11]); console.log(`L13->L12->L11 recursive/composed error=${recursiveError}`); check(recursiveError <= FLOAT64_TOLERANCE, 'aggregate recursive/composed equivalence');

const fourToOne = { offsets: new Uint32Array([0, 1, 2, 3, 4]), parentIndices: new Uint32Array([0, 0, 0, 0]), weights: new Float64Array([0.25, 0.25, 0.25, 0.25]) };
const fixtureParent = { level: 12, samples: [{ spacing: 0.01 }] };
const uniform = aggregateWeatherSummary(fixtureParent, directFixture(13, [5, 5, 5, 5]), fourToOne, null, Float64Array);
const localized = aggregateWeatherSummary(fixtureParent, directFixture(13, [0, 0, 0, 20]), fourToOne, null, Float64Array);
console.log(`aggregate fixtures: uniform mean=${rainMean(uniform, 0)} max=${uniform.rainMaxMmh[0]}, localized mean=${rainMean(localized, 0)} max=${localized.rainMaxMmh[0]} coverage@2.5=${localized.rainCoverageWeight[coverageIndex(2.5)][0]}`);
check(rainMean(uniform, 0) === 5 && uniform.rainMaxMmh[0] === 5, 'uniform rain fixture'); check(rainMean(localized, 0) === 5 && localized.rainMaxMmh[0] === 20 && localized.rainCoverageWeight[coverageIndex(2.5)][0] === 0.25, 'localized rain fixture');
const hazards = aggregateWeatherSummary(fixtureParent, directFixture(13, [0, 0, 0, 0], [0, 0, 0, 0.6977377], [0, 0, 0, 0.61]), fourToOne, null, Float64Array);
check(hazards.stormCoverageWeight[0] === 0.25 && hazards.stormMaxSeverity[0] === 0.6977377 && hazards.hailCoverageWeight[0] === 0.25, 'localized storm/hail fixture');
const uniformDots = mapDotsWeatherSummary(uniform); const localizedDots = mapDotsWeatherSummary(localized); const uniformSquares = mapSquaresWeatherSummary(uniform); const localizedSquares = mapSquaresWeatherSummary(localized);
check(uniformDots.rainRadius[0] !== localizedDots.rainRadius[0], 'Dots retain uniform/localized coarse rain distinction');
check(uniformSquares.rainCoverage[0] === 1 && localizedSquares.rainCoverage[0] === 0.25 && localizedSquares.rainWetMeanMmh[0] === 20, 'Squares retain coarse coverage and wet-mean distinction');
const coarseHazards = mapDotsWeatherSummary(hazards); check(coarseHazards.hailRadius[0] > 0 && coarseHazards.stormRadius[0] === 0, 'visible coarse hail retains Dots priority');
const tinyHail = mapDotsWeatherSummary(directFixture(13, [0], [0.8], [0.01], Float32Array)); check(tinyHail.stormRadius[0] > 0 && tinyHail.hailRadius[0] === 0, 'tiny direct hail does not suppress visible storm');
for (const level of DIRECT_LEVELS) {
  const high = directFixture(level, [80, 120]);
  check(high.rainWeightedSumMmh[0] === 80 && high.rainWeightedSumMmh[1] === 120 && high.rainMaxMmh[1] === 120, `L${level} direct physical rain remains unclamped above 50 mm/h`);
}

for (const level of DIRECT_LEVELS) {
  const dots = mapDotsWeatherSummary(float32Summaries[level]); const squares = mapSquaresWeatherSummary(float32Summaries[level]); let dotsError = 0; let hazardError = 0; let squaresError = 0;
  for (let index = 0; index < float32Summaries[level].samples.length; index++) {
    const sample = float32Summaries[level].samples[index]; const value = frame.sample(sample.lngLat[0], sample.lngLat[1]);
    dotsError = max(dotsError, Math.abs(dots.rainRadius[index] - Math.fround(rainMmhToRadius(Math.fround(value.rainMmh), sample.spacing)))); dotsError = max(dotsError, Math.abs(dots.strongRadius[index] - Math.fround(dotsStrongRainMmhToRadius(Math.fround(value.rainMmh), sample.spacing))));
    const expectedHazards = geographicHazardRadii({ storm: Math.fround(value.storm), hail: Math.fround(value.hail) }, sample.spacing, {}); hazardError = max(hazardError, Math.abs(dots.stormRadius[index] - Math.fround(expectedHazards.stormRadius))); hazardError = max(hazardError, Math.abs(dots.hailRadius[index] - Math.fround(expectedHazards.hailRadius)));
    squaresError = max(squaresError, Math.abs(squares.rainWetMeanMmh[index] - Math.fround(value.rainMmh))); squaresError = max(squaresError, Math.abs(squares.stormMeanSeverity[index] - Math.fround(value.storm))); squaresError = max(squaresError, Math.abs(squares.hailMeanSeverity[index] - Math.fround(value.hail)));
  }
  console.log(`L${level} direct mappings: Dots=${dotsError}, hazards=${hazardError}, Squares=${squaresError}`); check(dotsError <= 1e-5 && hazardError <= 5e-5 && squaresError <= 0.1, `L${level} direct Dots/Squares mapping equivalence`);
}

for (const [lower, higher, hierarchical] of [[12, 13, true], [13, 14, false], [14, 15, false]]) {
  const pairs = pyramid.topology.directPairsFor(lower, higher); let inheritedPositionError = 0; let inheritedPairs = 0; let introducedPairs = 0; const lowAnchors = pyramid.topology.levels.get(lower).canonicalAnchors; const highAnchors = pyramid.topology.levels.get(higher).canonicalAnchors;
  for (let index = 0; index < pairs.length; index += 2) { const low = pairs[index]; const high = pairs[index + 1]; if (low >= 0 && high >= 0) { inheritedPairs++; inheritedPositionError = max(inheritedPositionError, Math.abs(lowAnchors[low * 2] - highAnchors[high * 2])); inheritedPositionError = max(inheritedPositionError, Math.abs(lowAnchors[low * 2 + 1] - highAnchors[high * 2 + 1])); } else introducedPairs++; }
  console.log(`transition L${lower}<->L${higher}: ${hierarchical ? 'hierarchical' : 'direct pairs'}, inherited=${inheritedPairs}, introduced=${introducedPairs}, inherited position error=${inheritedPositionError}`); check(inheritedPositionError === 0 && (hierarchical ? pyramid.topology.transitionParentsFor(higher) : introducedPairs > 0), `L${lower}<->L${higher} transition topology`);
}

console.log(`scalar isolation: L${SCALAR_GRID_LEVEL} implementation retained but allocation skipped because Blur/Areas are inactive for the full-domain sequence`);

const summaryBytesPerSample = pyramid.summaryMemoryBytesPerSample(); let topologyAnchorBytes = 0;
for (const level of LEVELS) { const count = pyramid.samplesFor(level).length; topologyAnchorBytes += pyramid.topology.levels.get(level).canonicalAnchors.byteLength; console.log(`L${level}: ${count} samples; shared summary=${(count * summaryBytesPerSample / 1024 / 1024).toFixed(3)} MiB`); }
const count14 = pyramid.samplesFor(14).length; const count15 = pyramid.samplesFor(15).length; const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(3)} MiB`;
console.log(`L15 stable memory: one shared summary=${mib(count15 * summaryBytesPerSample)}, two temporal summaries=${mib(count15 * summaryBytesPerSample * 2)}, Dots mapped states=${mib(count15 * 4 * 4 * 2)}, Squares mapped states=${mib(count15 * 8 * 4 * 2)}, Squares CPU instances=${mib(count15 * 18 * 4)}, Squares GPU instance buffer=${mib(count15 * 18 * 4)}`);
console.log(`L14<->L15 transition memory: two temporal summaries=${mib((count14 + count15) * summaryBytesPerSample * 2)}, Dots mapped states=${mib((count14 + count15) * 4 * 4 * 2)}, Squares mapped states=${mib((count14 + count15) * 8 * 4 * 2)}, Squares CPU/GPU instances each=${mib((count14 + count15) * 18 * 4)}, shared typed topology anchors=${mib(topologyAnchorBytes)}, centered aggregate topology=${mib(centeredMappingBytes)}`);

const dotsSource = fs.readFileSync(new URL('../src/engine/geographic-dots-layer.js', import.meta.url), 'utf8'); const appSource = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8'); const htmlSource = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
check(!dotsSource.includes('setStrongFullMmh') && !appSource.includes('dotsStrong') && !htmlSource.includes('dotsStrong'), 'Dots strong-rain tuning UI and mutable state are removed'); check(DOTS_STRONG_RAIN_FULL_MMH === 35, 'Dots strong-rain full saturation is fixed at 35 mm/h');
const shared = new GeographicWeatherPyramid(Float32Array, new GeographicLodTopology(testWindow, { minLevel: 13, maxLevel: 13 })); check(new GeographicDotsLayer(shared).weatherPyramid === new GeographicSquaresLayer(shared).weatherPyramid, 'Dots and Squares share one GeographicWeatherPyramid instance');
console.log(failures ? `VERIFICATION FAILED: ${failures}` : 'VERIFICATION PASSED'); if (failures) process.exitCode = 1;
