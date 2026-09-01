import { setActiveWeatherField } from '../src/engine/geography.js';
import { loadRealWeatherFixture } from './real-weather-fixture.mjs';
import {
  aggregateWeatherSummary,
  buildCenteredContributionRelation,
  centeredContributionStructuralKey,
  evaluateDirectWeatherSummary,
  forEachCenteredContributionRelationEntry,
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
  GPU_PHYSICAL_SUMMARY_PASS_PLAN,
  GpuPhysicalSummaryBackend,
  relationTextureLayout,
  validateReverseCenteredRelation
} from '../src/engine/gpu-physical-summary.js';

const { metadata, weather } = await loadRealWeatherFixture();
setActiveWeatherField(weather);

function fail(ok, message) {
  if (!ok) throw new Error(message);
}

function check(condition, message) {
  fail(condition, message);
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
let relationLayoutChecks = 0;
let maximumCpuChainError = 0;
let firstWindowCost = null;

function reverseRelationForVerification(fineLevel, coarseLevel, relation) {
  const entries = Array.from({ length: coarseLevel.count }, () => []);
  for (let childIndex = 0; childIndex < fineLevel.count; childIndex++) {
    forEachCenteredContributionRelationEntry(relation, childIndex, (parentIndex, weight) => {
      entries[parentIndex].push({ childIndex, weight });
    });
  }
  return entries;
}

function relationSignature(fineLevel, coarseLevel) {
  const relation = buildCenteredContributionRelation(fineLevel, coarseLevel);
  const forward = [];
  for (let childIndex = 0; childIndex < fineLevel.count; childIndex++) {
    forEachCenteredContributionRelationEntry(relation, childIndex, (parentIndex, weight) => {
      forward.push([childIndex, parentIndex, weight]);
    });
  }
  const reverse = reverseRelationForVerification(fineLevel, coarseLevel, relation);
  return {
    key: centeredContributionStructuralKey(fineLevel, coarseLevel),
    relation,
    forward,
    reverse,
    maximumContributions: Math.max(...reverse.map((entries) => entries.length)),
    layout: relationTextureLayout(coarseLevel.count, 4096)
  };
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

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
        const relationLayout = relationTextureLayout(output.count, 4096);
        firstWindowCost[outputLevel] = {
          outputSamples: output.count,
          finerSamplesProcessed: fine.count,
          passes: 1,
          persistentABBytes: output.count * 24,
          relationMetadataGpuBytes: relationLayout.paddedTexelCount * 24,
          relationTexture: {
            target: relationLayout.target,
            width: relationLayout.width,
            height: relationLayout.height,
            depth: relationLayout.depth,
            semanticTexelCount: relationLayout.semanticTexelCount,
            paddedTexelCount: relationLayout.paddedTexelCount
          },
          peakTransientScratchBytes: 0,
          maximumReverseContributions: relationInfo.maximumContributions
        };
      }
    }
    for (const outputLevel of GPU_PHYSICAL_SUMMARY_LEVELS) {
      const output = topology.levels.get(outputLevel);
      const layout = relationTextureLayout(output.count, 4096);
      fail(layout.target === 'TEXTURE_2D' && layout.depth === 1, `L${outputLevel} relation layout is not packed 2D metadata.`);
      fail(layout.width <= 4096 && layout.height <= 4096, `L${outputLevel} relation layout exceeds the configured WebGL limit.`);
      fail(layout.semanticTexelCount === output.count * Math.ceil(GPU_PHYSICAL_SUMMARY_MAX_CONTRIBUTIONS / 4), `L${outputLevel} relation layout changed its semantic texel count.`);
      fail(layout.paddedTexelCount >= layout.semanticTexelCount, `L${outputLevel} relation layout truncated metadata.`);
      relationLayoutChecks++;
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
fail(GPU_PHYSICAL_SUMMARY_FRAGMENT_SOURCE.includes('u_relationTextureSize') && GPU_PHYSICAL_SUMMARY_FRAGMENT_SOURCE.includes('u_relationParentCount'), 'GPU summary shader does not use packed relation dimensions.');
fail(!GPU_PHYSICAL_SUMMARY_FRAGMENT_SOURCE.includes('sampler2DArray'), 'GPU summary shader still requires array relation textures.');
fail(GPU_PHYSICAL_SUMMARY_PASS_PLAN.length === 3, 'GPU summary pass plan changed unexpectedly.');
fail(GPU_PHYSICAL_SUMMARY_PASS_PLAN.every(({ source, destination }) => source !== destination), 'GPU summary pass has an attached source/destination collision.');
fail(GPU_PHYSICAL_SUMMARY_PASS_PLAN.map(({ level }) => level).join(',') === '12,11,10', 'GPU summary pass ordering changed unexpectedly.');

// Structural translation invariance and live relation ownership are verified
// with a minimal WebGL2-shaped test context. The context records texture
// deletion, but does not attempt to execute shaders; readback remains a
// browser-only validation path.
class FakeWebGL2 {
  constructor() {
    Object.assign(this, {
      NO_ERROR: 0, ACTIVE_TEXTURE: 1, TEXTURE_BINDING_2D: 2, TEXTURE_BINDING_2D_ARRAY: 3,
      DRAW_FRAMEBUFFER_BINDING: 4, READ_FRAMEBUFFER_BINDING: 5, FRAMEBUFFER_BINDING: 6,
      VIEWPORT: 7, CURRENT_PROGRAM: 8, VERTEX_ARRAY_BINDING: 9, BLEND: 10, SCISSOR_TEST: 11,
      DEPTH_TEST: 12, STENCIL_TEST: 13, CULL_FACE: 14, DEPTH_WRITEMASK: 15, COLOR_WRITEMASK: 16,
      BLEND_SRC_RGB: 17, BLEND_DST_RGB: 18, BLEND_SRC_ALPHA: 19, BLEND_DST_ALPHA: 20,
      BLEND_EQUATION_RGB: 21, BLEND_EQUATION_ALPHA: 22, PACK_ALIGNMENT: 23, PACK_ROW_LENGTH: 24,
      PACK_SKIP_PIXELS: 25, PACK_SKIP_ROWS: 26, UNPACK_ALIGNMENT: 27, MAX_TEXTURE_SIZE: 28,
      MAX_3D_TEXTURE_SIZE: 29, MAX_ARRAY_TEXTURE_LAYERS: 30, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 31,
      TEXTURE0: 100, TEXTURE_2D: 101, TEXTURE_2D_ARRAY: 102, FRAMEBUFFER: 103,
      DRAW_FRAMEBUFFER: 104, READ_FRAMEBUFFER: 105, ARRAY_BUFFER: 106, STATIC_DRAW: 107,
      RGBA32UI: 108, RGBA_INTEGER: 109, UNSIGNED_INT: 110, RGBA16F: 111, RGBA: 112,
      FLOAT: 113, HALF_FLOAT: 114, RG16F: 115, RG: 116, TRIANGLES: 117,
      COLOR_ATTACHMENT0: 118, COLOR_ATTACHMENT1: 119, FRAMEBUFFER_COMPLETE: 120,
      COMPILE_STATUS: 121, LINK_STATUS: 122
    });
    this.active = this.TEXTURE0;
    this.bindings = new Map();
    this.framebuffer = null;
    this.viewportValue = [0, 0, 1, 1];
    this.deletedTextures = [];
    this.nextId = 1;
  }

  getParameter(parameter) {
    if (parameter === this.ACTIVE_TEXTURE) return this.active;
    if (parameter === this.TEXTURE_BINDING_2D || parameter === this.TEXTURE_BINDING_2D_ARRAY) return this.bindings.get(`${this.active}:${parameter}`) || null;
    if (parameter === this.DRAW_FRAMEBUFFER_BINDING || parameter === this.READ_FRAMEBUFFER_BINDING || parameter === this.FRAMEBUFFER_BINDING) return this.framebuffer;
    if (parameter === this.VIEWPORT) return this.viewportValue;
    if (parameter === this.MAX_TEXTURE_SIZE) return 4096;
    if (parameter === this.MAX_3D_TEXTURE_SIZE) return 2048;
    if (parameter === this.MAX_ARRAY_TEXTURE_LAYERS) return 256;
    if (parameter === this.MAX_COMBINED_TEXTURE_IMAGE_UNITS) return 8;
    if (parameter === this.DEPTH_WRITEMASK) return true;
    if (parameter === this.COLOR_WRITEMASK) return [true, true, true, true];
    if ([this.PACK_ALIGNMENT, this.UNPACK_ALIGNMENT].includes(parameter)) return 4;
    if ([this.PACK_ROW_LENGTH, this.PACK_SKIP_PIXELS, this.PACK_SKIP_ROWS].includes(parameter)) return 0;
    return null;
  }

  activeTexture(value) { this.active = value; }
  bindTexture(target, texture) { this.bindings.set(`${this.active}:${target === this.TEXTURE_2D ? this.TEXTURE_BINDING_2D : this.TEXTURE_BINDING_2D_ARRAY}`, texture); }
  createTexture() { return { type: 'texture', id: this.nextId++ }; }
  texParameteri() {}
  texImage2D() {}
  pixelStorei() {}
  createShader() { return {}; }
  shaderSource() {}
  compileShader() {}
  getShaderParameter() { return true; }
  getShaderInfoLog() { return ''; }
  createProgram() { return {}; }
  attachShader() {}
  bindAttribLocation() {}
  linkProgram() {}
  getProgramParameter() { return true; }
  getProgramInfoLog() { return ''; }
  useProgram() {}
  getUniformLocation() { return {}; }
  createVertexArray() { return {}; }
  bindVertexArray() {}
  createBuffer() { return {}; }
  bindBuffer() {}
  bufferData() {}
  enableVertexAttribArray() {}
  vertexAttribPointer() {}
  bindFramebuffer(_target, framebuffer) { this.framebuffer = framebuffer; }
  viewport(x, y, width, height) { this.viewportValue = [x, y, width, height]; }
  framebufferTexture2D() {}
  drawBuffers() {}
  checkFramebufferStatus() { return this.FRAMEBUFFER_COMPLETE; }
  isEnabled() { return false; }
  enable() {}
  disable() {}
  depthMask() {}
  colorMask() {}
  blendFuncSeparate() {}
  blendEquationSeparate() {}
  createFramebuffer() { return { type: 'framebuffer', id: this.nextId++ }; }
  deleteFramebuffer() {}
  deleteTexture(texture) { this.deletedTextures.push(texture); }
  deleteProgram() {}
  deleteBuffer() {}
  deleteVertexArray() {}
  getExtension(name) { return name === 'EXT_color_buffer_float' ? {} : null; }
  getError() { return this.NO_ERROR; }
}

const [invariantX, invariantY] = lngLatToMercator(45, 55);
const invariantWindow = canonicalWindowFromMercatorBounds({
  minX: invariantX - .001, maxX: invariantX + .001,
  minY: invariantY - .001, maxY: invariantY + .001
});
const translatedWindow = {
  minX: invariantWindow.minX + 32,
  maxX: invariantWindow.maxX + 32,
  minY: invariantWindow.minY,
  maxY: invariantWindow.maxY
};
const invariantA = new GeographicLodTopology(invariantWindow, lodRangeForStableLevel(10));
const invariantB = new GeographicLodTopology(translatedWindow, lodRangeForStableLevel(10));
for (const level of GPU_PHYSICAL_SUMMARY_LEVELS) {
  const left = relationSignature(invariantA.levels.get(level + 1), invariantA.levels.get(level));
  const right = relationSignature(invariantB.levels.get(level + 1), invariantB.levels.get(level));
  check(left.key === right.key, `L${level} translated windows retain the same GPU structural key`);
  check(equalJson(left.relation.x.candidateCounts, right.relation.x.candidateCounts)
    && equalJson(left.relation.x.rawCandidateCounts, right.relation.x.rawCandidateCounts)
    && equalJson(left.relation.x.candidateIndices, right.relation.x.candidateIndices)
    && equalJson(left.relation.y.candidateCounts, right.relation.y.candidateCounts)
    && equalJson(left.relation.y.rawCandidateCounts, right.relation.y.rawCandidateCounts)
    && equalJson(left.relation.y.candidateIndices, right.relation.y.candidateIndices),
  `L${level} translated windows retain identical local forward contribution enumeration`);
  check(equalJson(left.forward, right.forward), `L${level} translated windows retain identical local parent indices and weights`);
  check(equalJson(left.reverse, right.reverse)
    && left.maximumContributions === right.maximumContributions,
  `L${level} translated windows retain identical reverse ordering, weights, and maximum contribution count`);
  check(equalJson(left.layout, right.layout), `L${level} translated windows retain identical relation texture layout`);
}

const changedWidthWindow = { ...invariantWindow, maxX: invariantWindow.maxX + 32 };
const changedHeightWindow = { ...invariantWindow, maxY: invariantWindow.maxY + 32 };
const changedWidthTopology = new GeographicLodTopology(changedWidthWindow, lodRangeForStableLevel(10));
const changedHeightTopology = new GeographicLodTopology(changedHeightWindow, lodRangeForStableLevel(10));
for (const level of GPU_PHYSICAL_SUMMARY_LEVELS) {
  const baseKey = centeredContributionStructuralKey(invariantA.levels.get(level + 1), invariantA.levels.get(level));
  check(baseKey !== centeredContributionStructuralKey(changedWidthTopology.levels.get(level + 1), changedWidthTopology.levels.get(level)),
    `L${level} changed width is structurally incompatible`);
  check(baseKey !== centeredContributionStructuralKey(changedHeightTopology.levels.get(level + 1), changedHeightTopology.levels.get(level)),
    `L${level} changed height is structurally incompatible`);
}
const parityFixtureFine = { ...invariantA.levels.get(13), minI: invariantA.levels.get(13).minI + 1, maxI: invariantA.levels.get(13).maxI + 1 };
check(centeredContributionStructuralKey(parityFixtureFine, invariantA.levels.get(12))
  !== centeredContributionStructuralKey(invariantA.levels.get(13), invariantA.levels.get(12)),
`changed relevant fine parity is structurally incompatible`);
const originFixtureCoarse = { ...invariantA.levels.get(12), minI: invariantA.levels.get(12).minI + 1, maxI: invariantA.levels.get(12).maxI + 1 };
check(centeredContributionStructuralKey(invariantA.levels.get(13), originFixtureCoarse)
  !== centeredContributionStructuralKey(invariantA.levels.get(13), invariantA.levels.get(12)),
`changed relative origin and edge clipping are structurally incompatible`);

const fakeGl = new FakeWebGL2();
const backendA = new GpuPhysicalSummaryBackend(fakeGl, invariantA, { maximumLevels: GPU_PHYSICAL_SUMMARY_LEVELS });
const backendB = new GpuPhysicalSummaryBackend(fakeGl, invariantB, {
  maximumLevels: GPU_PHYSICAL_SUMMARY_LEVELS,
  relationReuseSource: backendA
});
check(backendB.relationReuseHits === 3 && backendB.relationReuseMisses === 0, 'full compatible backend reuse hits every summary edge');
check(backendB.relationBuildCount === 0 && backendB.relationUploadCount === 0
  && backendB.temporaryCpuStagingBytesAvoided > 0,
'full compatible backend skips relation build, staging, and uploads');
for (const level of GPU_PHYSICAL_SUMMARY_LEVELS) {
  check(backendA.relations.get(level) === backendB.relations.get(level), `L${level} shares one retained relation resource`);
  check(backendA.outputs.get(level).slots[0].values !== backendB.outputs.get(level).slots[0].values,
    `L${level} output summary textures remain backend-private on a relation hit`);
}
const partialLevels = new Map(invariantB.levels);
const partialL10 = partialLevels.get(10);
partialLevels.set(10, Object.freeze({ ...partialL10, maxI: partialL10.maxI + 1, width: partialL10.width + 1, count: partialL10.count + partialL10.height }));
const partialTopology = { ...invariantB, levels: partialLevels };
const partialBackend = new GpuPhysicalSummaryBackend(fakeGl, partialTopology, {
  maximumLevels: GPU_PHYSICAL_SUMMARY_LEVELS,
  relationReuseSource: backendA
});
check(partialBackend.relationReuseHits === 2 && partialBackend.relationReuseMisses === 1, 'partial reuse is evaluated independently per summary edge');
check(partialBackend.relations.get(12) === backendA.relations.get(12)
  && partialBackend.relations.get(11) === backendA.relations.get(11)
  && partialBackend.relations.get(10) !== backendA.relations.get(10),
'partial reuse retains only the compatible L12 and L11 relations');

const foreignGl = new FakeWebGL2();
const foreignBackend = new GpuPhysicalSummaryBackend(foreignGl, invariantA, {
  maximumLevels: GPU_PHYSICAL_SUMMARY_LEVELS,
  relationReuseSource: backendA
});
check(foreignBackend.relationReuseHits === 0 && foreignBackend.relationBuildCount === 3,
  'relation resources are never reused across WebGL contexts');
const relationTextures = GPU_PHYSICAL_SUMMARY_LEVELS.flatMap((level) => [
  backendA.relations.get(level).indexTexture,
  backendA.relations.get(level).weightTexture
]);
const activeRelation = backendA.relations.get(12);
const ownershipDiagnostics = backendB.diagnostics();
const unrelatedBinding = { type: 'maplibre-texture' };
fakeGl.activeTexture(fakeGl.TEXTURE0 + 6);
fakeGl.bindTexture(fakeGl.TEXTURE_2D, unrelatedBinding);
fakeGl.activeTexture(fakeGl.TEXTURE0);
fakeGl.bindTexture(fakeGl.TEXTURE_2D, relationTextures[0]);
backendB.destroy();
check(relationTextures.every((texture) => !fakeGl.deletedTextures.includes(texture)),
  'releasing one owner does not prematurely delete shared relations');
check(activeRelation.ownerCount === 2 && !activeRelation.destroyed,
  'active predecessor remains valid while another pending owner retains the relation');
backendA.destroy();
check(activeRelation.ownerCount === 1 && !activeRelation.destroyed,
  'predecessor release cannot destroy a relation retained by another pending owner');
// backendA's relation map is cleared by destroy(), so the L10 resource is
// retained here through the original texture list and the L12 resource above.
check(relationTextures.slice(4).every((texture) => fakeGl.deletedTextures.filter((candidate) => candidate === texture).length === 1)
  && relationTextures.slice(0, 4).every((texture) => !fakeGl.deletedTextures.includes(texture)),
  'only the last owner of the partial-reuse miss deletes its relation');
partialBackend.destroy();
check(relationTextures.every((texture) => fakeGl.deletedTextures.filter((candidate) => candidate === texture).length === 1),
  'final active/pending owner release deletes every shared texture exactly once');
fakeGl.activeTexture(fakeGl.TEXTURE0 + 6);
check(fakeGl.getParameter(fakeGl.TEXTURE_BINDING_2D) === unrelatedBinding,
  'last-owner cleanup preserves unrelated MapLibre texture bindings');
fakeGl.activeTexture(fakeGl.TEXTURE0);
check(fakeGl.getParameter(fakeGl.TEXTURE_BINDING_2D) === null,
  'last-owner cleanup removes deleted relation textures from captured texture units');
const deletionCountAfterDestroy = fakeGl.deletedTextures.length;
backendA.destroy();
check(fakeGl.deletedTextures.length === deletionCountAfterDestroy, 'backend destroy is idempotent and does not double-delete');

const supersessionA = new GpuPhysicalSummaryBackend(fakeGl, invariantA, { maximumLevels: GPU_PHYSICAL_SUMMARY_LEVELS });
const supersessionB = new GpuPhysicalSummaryBackend(fakeGl, invariantB, { maximumLevels: GPU_PHYSICAL_SUMMARY_LEVELS, relationReuseSource: supersessionA });
const supersessionC = new GpuPhysicalSummaryBackend(fakeGl, invariantA, { maximumLevels: GPU_PHYSICAL_SUMMARY_LEVELS, relationReuseSource: supersessionA });
const supersededRelation = supersessionA.relations.get(12);
supersessionB.destroy();
check(supersededRelation.ownerCount === 2 && !supersededRelation.destroyed, 'superseded pending owner release leaves active and newer owners valid');
supersessionA.destroy();
check(supersededRelation.ownerCount === 1 && !supersededRelation.destroyed, 'predecessor release cannot destroy replacement retained relations');
supersessionC.destroy();
check(supersededRelation.destroyed && supersededRelation.ownerCount === 0, 'final superseding owner release destroys the relation');
foreignBackend.destroy();

check(ownershipDiagnostics.levels[12].reused === true
  && ownershipDiagnostics.levels[12].relationBuildSkipped
  && ownershipDiagnostics.levels[12].stagingBytesAvoided > 0
  && ownershipDiagnostics.levels[12].relationUploadBytesAvoided > 0,
  'reuse diagnostics expose per-level hit and avoided work');

console.log(`GPU physical-summary contract verification passed: windows=${windows.length}, times=${times.length}, summaries=${summaryChecks}, mappings=${mappedChecks}, relations=${relationChecks}, layouts=${relationLayoutChecks}, maxCpuOrderingError=${maximumCpuChainError}`);
console.log(`GPU summary cost for first window: ${JSON.stringify(firstWindowCost)}`);
console.log('CPU reference contract: direct reconstructed L13 -> recursive centered physical summaries L12/L11/L10 -> per-keyframe Dots/Squares mapping -> renderer temporal interpolation.');
console.log('GPU readback metrics: not run in Node; browser-only window.__dotFieldGpuWeather.validatePhysicalSummary() provides explicit diagnostic readback and presentation comparison.');
