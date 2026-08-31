// Diagnostic GPU physical-summary backend for the future L10-L12 path.
//
// This module deliberately does not select a renderer or replace the CPU
// pyramid.  It consumes a direct physical L13 R16F field and produces the
// rain-only summary profile used by the GPU-first temporal experiment.  The
// same pass is reused for L12, L11, and L10; lower levels consume the summary
// textures from the preceding pass.

import {
  buildCenteredContributionRelation,
  forEachCenteredContributionRelationEntry,
  WEATHER_REFERENCE_LEVEL,
  WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY
} from './geographic-weather-pyramid.js';
import { canonicalWindowsEqual } from './geographic-lod.js';

export const GPU_PHYSICAL_SUMMARY_LEVELS = Object.freeze([12, 11, 10]);
export const GPU_PHYSICAL_SUMMARY_PASS_PLAN = Object.freeze([
  Object.freeze({ level: 12, source: 'physical-L13', destination: 'summary-L12' }),
  Object.freeze({ level: 11, source: 'summary-L12', destination: 'summary-L11' }),
  Object.freeze({ level: 10, source: 'summary-L11', destination: 'summary-L10' })
]);
export const GPU_PHYSICAL_SUMMARY_CHANNELS = Object.freeze([
  'totalWeight',
  'rainWeightedSumMmh',
  'rainMaxMmh',
  'rainCoverageWeight@0.05',
  'rainCoverageWeight@2.5'
]);
export const GPU_PHYSICAL_SUMMARY_PROFILE = WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY;
export const GPU_PHYSICAL_SUMMARY_MAX_CONTRIBUTIONS = 9;

const VERTEX_SOURCE = `#version 300 es
in vec2 a;
void main(){gl_Position=vec4(a,0,1);}`;

// The relation textures contain reverse centered contributions in the exact
// child-major order used by geographic-weather-pyramid.js.  The first pass
// reads a direct physical rain value; subsequent passes read the preceding
// summary's weighted sum, max, total weight, and two coverage weights.
export const GPU_PHYSICAL_SUMMARY_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
precision highp sampler2D;
precision highp usampler2D;
uniform sampler2D u_physical;
uniform sampler2D u_values;
uniform sampler2D u_coverage;
uniform usampler2D u_relationIndices;
uniform sampler2D u_relationWeights;
uniform ivec2 u_inputSize;
uniform ivec2 u_outputSize;
uniform int u_inputKind;
uniform int u_relationLayers;
uniform ivec2 u_relationTextureSize;
uniform int u_relationParentCount;
layout(location=0) out vec4 outValues;
layout(location=1) out vec2 outCoverage;

float component(vec4 value, int index){return value[index];}
uint component(uvec4 value, int index){return value[index];}

ivec2 relationAt(int layer,int parentIndex){
  int linearIndex=layer*u_relationParentCount+parentIndex;
  return ivec2(linearIndex%u_relationTextureSize.x,linearIndex/u_relationTextureSize.x);
}

void main(){
  ivec2 outputAt=ivec2(gl_FragCoord.xy);
  int parentIndex=outputAt.y*u_outputSize.x+outputAt.x;
  float weightedSum=0.0;
  float maximum=0.0;
  float totalWeight=0.0;
  float wetCoverage=0.0;
  float strongCoverage=0.0;
  for(int layer=0;layer<3;layer++){
    if(layer>=u_relationLayers) continue;
    ivec2 relationCoordinate=relationAt(layer,parentIndex);
    uvec4 childIndices=texelFetch(u_relationIndices,relationCoordinate,0);
    vec4 weights=texelFetch(u_relationWeights,relationCoordinate,0);
    for(int componentIndex=0;componentIndex<4;componentIndex++){
      uint childIndex=component(childIndices,componentIndex);
      if(childIndex==0xffffffffu) continue;
      float weight=component(weights,componentIndex);
      if(weight<=0.0) continue;
      ivec2 childAt=ivec2(int(childIndex%uint(u_inputSize.x)),int(childIndex/uint(u_inputSize.x)));
      float childSum;
      float childMaximum;
      float childTotal;
      float childWet;
      float childStrong;
      if(u_inputKind==0){
        float rain=texelFetch(u_physical,childAt,0).r;
        childSum=rain;
        childMaximum=rain;
        childTotal=1.0;
        childWet=rain>=0.05?1.0:0.0;
        childStrong=rain>=2.5?1.0:0.0;
      }else{
        vec4 values=texelFetch(u_values,childAt,0);
        vec2 coverage=texelFetch(u_coverage,childAt,0).rg;
        childSum=values.r;
        childMaximum=values.g;
        childTotal=values.b;
        childWet=coverage.r;
        childStrong=coverage.g;
      }
      float effectiveWeight=weight*childTotal;
      weightedSum+=weight*childSum;
      wetCoverage+=weight*childWet;
      strongCoverage+=weight*childStrong;
      totalWeight+=effectiveWeight;
      if(effectiveWeight>0.0) maximum=max(maximum,childMaximum);
    }
  }
  outValues=vec4(weightedSum,maximum,totalWeight,0.0);
  outCoverage=vec2(wetCoverage,strongCoverage);
}`;

const COPY_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_source;
uniform int u_kind;
out vec4 outColor;
void main(){
  vec4 value=texelFetch(u_source,ivec2(gl_FragCoord.xy),0);
  outColor=u_kind==0?value:vec4(value.rg,0.0,0.0);
}`;

function fail(ok, message) {
  if (!ok) throw new Error(`GPU physical summary: ${message}`);
}

function compileShader(gl, type, source) {
  const value = gl.createShader(type);
  gl.shaderSource(value, source);
  gl.compileShader(value);
  fail(gl.getShaderParameter(value, gl.COMPILE_STATUS), gl.getShaderInfoLog(value));
  return value;
}

function createProgram(gl, fragmentSource) {
  const value = gl.createProgram();
  gl.attachShader(value, compileShader(gl, gl.VERTEX_SHADER, VERTEX_SOURCE));
  gl.attachShader(value, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.bindAttribLocation(value, 0, 'a');
  gl.linkProgram(value);
  fail(gl.getProgramParameter(value, gl.LINK_STATUS), gl.getProgramInfoLog(value));
  return value;
}

function createTexture2D(gl, internalFormat, width, height, format, type, data = null) {
  const value = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, value);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, data);
  return value;
}

export function relationTextureLayout(parentCount, maximumTextureSize) {
  fail(Number.isInteger(parentCount) && parentCount > 0, 'relation parent count must be a positive integer.');
  fail(Number.isInteger(maximumTextureSize) && maximumTextureSize > 0, 'maximum 2D texture size must be a positive integer.');
  const layers = Math.max(1, Math.ceil(GPU_PHYSICAL_SUMMARY_MAX_CONTRIBUTIONS / 4));
  const semanticTexelCount = parentCount * layers;
  const width = Math.min(maximumTextureSize, semanticTexelCount);
  const height = Math.ceil(semanticTexelCount / width);
  fail(height <= maximumTextureSize,
    `bounded relation requires ${semanticTexelCount} texels, exceeding the ${maximumTextureSize}x${maximumTextureSize} 2D texture limit.`);
  return {
    target: 'TEXTURE_2D',
    width,
    height,
    depth: 1,
    layers,
    semanticTexelCount,
    paddedTexelCount: width * height,
    maximumTextureSize
  };
}

function createQuad(gl) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  return { vao, buffer };
}

function reverseRelation(fineLevel, coarseLevel, relation) {
  const counts = new Uint8Array(coarseLevel.count);
  for (let childIndex = 0; childIndex < fineLevel.count; childIndex++) {
    forEachCenteredContributionRelationEntry(relation, childIndex, (parentIndex, weight) => {
      counts[parentIndex]++;
    });
  }
  const offsets = new Uint32Array(coarseLevel.count + 1);
  for (let parentIndex = 0; parentIndex < coarseLevel.count; parentIndex++) offsets[parentIndex + 1] = offsets[parentIndex] + counts[parentIndex];
  const childIndices = new Uint32Array(offsets[coarseLevel.count]);
  const weights = new Float32Array(offsets[coarseLevel.count]);
  const cursors = offsets.slice(0, coarseLevel.count);
  for (let childIndex = 0; childIndex < fineLevel.count; childIndex++) {
    forEachCenteredContributionRelationEntry(relation, childIndex, (parentIndex, weight) => {
      const offset = cursors[parentIndex]++;
      childIndices[offset] = childIndex;
      weights[offset] = weight;
    });
  }
  const maximum = counts.reduce((result, value) => Math.max(result, value), 0);
  fail(maximum <= GPU_PHYSICAL_SUMMARY_MAX_CONTRIBUTIONS,
    `centered relation requires ${maximum} reverse contributions; shader supports ${GPU_PHYSICAL_SUMMARY_MAX_CONTRIBUTIONS}.`);
  return { counts, offsets, childIndices, weights, maximum };
}

function relationTextures(gl, fineLevel, coarseLevel) {
  const relation = buildCenteredContributionRelation(fineLevel, coarseLevel);
  const reverse = reverseRelation(fineLevel, coarseLevel, relation);
  const maximumTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const layout = relationTextureLayout(coarseLevel.count, maximumTextureSize);
  const indices = new Uint32Array(layout.paddedTexelCount * 4);
  indices.fill(0xffffffff);
  const weights = new Float32Array(layout.paddedTexelCount * 4);
  for (let parentIndex = 0; parentIndex < coarseLevel.count; parentIndex++) {
    for (let sourceOffset = reverse.offsets[parentIndex]; sourceOffset < reverse.offsets[parentIndex + 1]; sourceOffset++) {
      const contributionIndex = sourceOffset - reverse.offsets[parentIndex];
      const childIndex = reverse.childIndices[sourceOffset];
      const weight = reverse.weights[sourceOffset];
      const layer = contributionIndex >> 2;
      const textureTexel = layer * coarseLevel.count + parentIndex;
      const textureOffset = textureTexel * 4 + (contributionIndex & 3);
      indices[textureOffset] = childIndex;
      weights[textureOffset] = weight;
    }
  }
  const previousUnpackAlignment = gl.getParameter(gl.UNPACK_ALIGNMENT);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  let indexTexture;
  let weightTexture;
  try {
    indexTexture = createTexture2D(
      gl, gl.RGBA32UI, layout.width, layout.height, gl.RGBA_INTEGER, gl.UNSIGNED_INT, indices
    );
    weightTexture = createTexture2D(
      gl, gl.RGBA16F, layout.width, layout.height, gl.RGBA, gl.FLOAT, weights
    );
  } finally {
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, previousUnpackAlignment);
  }
  return {
    relation,
    indexTexture,
    weightTexture,
    ...layout,
    maximumContributions: reverse.maximum,
    gpuBytes: layout.paddedTexelCount * (4 * Uint32Array.BYTES_PER_ELEMENT + 4 * 2),
    cpuStagingBytes: indices.byteLength + weights.byteLength
  };
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function channelMetrics(reference, actual, count, maximumSamples) {
  const stride = Math.max(1, Math.ceil(count / Math.max(1, maximumSamples)));
  const errors = [];
  let maximum = 0;
  let total = 0;
  let samples = 0;
  for (let index = 0; index < count; index += stride) {
    const error = Math.abs(reference[index] - actual[index]);
    errors.push(error);
    maximum = Math.max(maximum, error);
    total += error;
    samples++;
  }
  return {
    samples,
    maxAbsoluteError: maximum,
    meanAbsoluteError: samples ? total / samples : 0,
    p95AbsoluteError: percentile(errors, 0.95)
  };
}

function capturePassState(gl, textureUnits = []) {
  const activeTexture = gl.getParameter(gl.ACTIVE_TEXTURE);
  const textureBindings = textureUnits.map((unit) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    return {
      unit,
      texture2D: gl.getParameter(gl.TEXTURE_BINDING_2D),
      texture2DArray: gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY)
    };
  });
  gl.activeTexture(activeTexture);
  return {
    drawFramebuffer: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
    readFramebuffer: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
    viewport: [...gl.getParameter(gl.VIEWPORT)],
    program: gl.getParameter(gl.CURRENT_PROGRAM),
    vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
    activeTexture,
    textureBindings,
    blend: gl.isEnabled(gl.BLEND),
    scissor: gl.isEnabled(gl.SCISSOR_TEST),
    depth: gl.isEnabled(gl.DEPTH_TEST),
    stencil: gl.isEnabled(gl.STENCIL_TEST),
    cull: gl.isEnabled(gl.CULL_FACE),
    depthMask: gl.getParameter(gl.DEPTH_WRITEMASK),
    colorMask: [...gl.getParameter(gl.COLOR_WRITEMASK)],
    blendSrcRgb: gl.getParameter(gl.BLEND_SRC_RGB),
    blendDstRgb: gl.getParameter(gl.BLEND_DST_RGB),
    blendSrcAlpha: gl.getParameter(gl.BLEND_SRC_ALPHA),
    blendDstAlpha: gl.getParameter(gl.BLEND_DST_ALPHA),
    blendEquationRgb: gl.getParameter(gl.BLEND_EQUATION_RGB),
    blendEquationAlpha: gl.getParameter(gl.BLEND_EQUATION_ALPHA),
    packAlignment: gl.getParameter(gl.PACK_ALIGNMENT),
    packRowLength: gl.getParameter(gl.PACK_ROW_LENGTH),
    packSkipPixels: gl.getParameter(gl.PACK_SKIP_PIXELS),
    packSkipRows: gl.getParameter(gl.PACK_SKIP_ROWS)
  };
}

function restorePassState(gl, state) {
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, state.drawFramebuffer);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, state.readFramebuffer);
  gl.viewport(...state.viewport);
  gl.useProgram(state.program);
  gl.bindVertexArray(state.vao);
  for (const binding of state.textureBindings) {
    gl.activeTexture(gl.TEXTURE0 + binding.unit);
    gl.bindTexture(gl.TEXTURE_2D, binding.texture2D);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, binding.texture2DArray);
  }
  gl.activeTexture(state.activeTexture);
  for (const [capability, enabled] of [
    [gl.BLEND, state.blend],
    [gl.SCISSOR_TEST, state.scissor],
    [gl.DEPTH_TEST, state.depth],
    [gl.STENCIL_TEST, state.stencil],
    [gl.CULL_FACE, state.cull]
  ]) {
    if (enabled) gl.enable(capability);
    else gl.disable(capability);
  }
  gl.depthMask(state.depthMask);
  gl.colorMask(...state.colorMask);
  gl.blendFuncSeparate(state.blendSrcRgb, state.blendDstRgb, state.blendSrcAlpha, state.blendDstAlpha);
  gl.blendEquationSeparate(state.blendEquationRgb, state.blendEquationAlpha);
  gl.pixelStorei(gl.PACK_ALIGNMENT, state.packAlignment);
  gl.pixelStorei(gl.PACK_ROW_LENGTH, state.packRowLength);
  gl.pixelStorei(gl.PACK_SKIP_PIXELS, state.packSkipPixels);
  gl.pixelStorei(gl.PACK_SKIP_ROWS, state.packSkipRows);
}

export function validateReverseCenteredRelation(fineLevel, coarseLevel) {
  const relation = buildCenteredContributionRelation(fineLevel, coarseLevel);
  const reverse = reverseRelation(fineLevel, coarseLevel, relation);
  const forward = [];
  for (let childIndex = 0; childIndex < fineLevel.count; childIndex++) {
    forEachCenteredContributionRelationEntry(relation, childIndex, (parentIndex, weight) => {
      forward.push(`${childIndex}:${parentIndex}:${weight}`);
    });
  }
  const rebuilt = [];
  for (let parentIndex = 0; parentIndex < coarseLevel.count; parentIndex++) {
    for (let offset = reverse.offsets[parentIndex]; offset < reverse.offsets[parentIndex + 1]; offset++) {
      rebuilt.push(`${reverse.childIndices[offset]}:${parentIndex}:${reverse.weights[offset]}`);
    }
  }
  forward.sort();
  rebuilt.sort();
  fail(forward.length === rebuilt.length && forward.every((value, index) => value === rebuilt[index]),
    'reverse centered relation changed a contribution or weight.');
  return {
    fineLevel: fineLevel.level,
    coarseLevel: coarseLevel.level,
    fineSamples: fineLevel.count,
    coarseSamples: coarseLevel.count,
    contributions: forward.length,
    maximumContributions: reverse.maximum
  };
}

export class GpuPhysicalSummaryBackend {
  constructor(gl, topology, { maximumLevels = GPU_PHYSICAL_SUMMARY_LEVELS } = {}) {
    fail(gl, 'WebGL2 context is required.');
    fail(topology?.levels?.has?.(WEATHER_REFERENCE_LEVEL), 'direct L13 level data is required.');
    this.gl = gl;
    this.topology = topology;
    this.levels = [...maximumLevels].filter((level) => topology.levels.has(level));
    fail(this.levels.length === GPU_PHYSICAL_SUMMARY_LEVELS.length, 'L10, L11, and L12 level data are required.');
    fail(gl.getExtension('EXT_color_buffer_float'), 'floating-point render targets are unavailable.');
    const constructionState = capturePassState(gl, [0, 1, 2, 3, 4]);
    this.relations = new Map();
    this.outputs = new Map();
    this.reconstructionPassCount = 0;
    this.lastUpdateMs = 0;
    this.lastGpuPassMs = null;
    this.pendingTimerQueries = [];
    this.lastGpuError = gl.NO_ERROR;
    this.lastValidation = null;
    this.lastPassOwnership = [];
    try {
      this.program = createProgram(gl, GPU_PHYSICAL_SUMMARY_FRAGMENT_SOURCE);
      this.copyProgram = createProgram(gl, COPY_FRAGMENT_SOURCE);
      this.quad = createQuad(gl);
      this.locations = Object.fromEntries([
        'u_physical', 'u_values', 'u_coverage', 'u_relationIndices', 'u_relationWeights',
        'u_inputSize', 'u_outputSize', 'u_inputKind', 'u_relationLayers',
        'u_relationTextureSize', 'u_relationParentCount'
      ].map((name) => [name, gl.getUniformLocation(this.program, name)]));
      this.copyLocation = {
        source: gl.getUniformLocation(this.copyProgram, 'u_source'),
        kind: gl.getUniformLocation(this.copyProgram, 'u_kind')
      };
      this.dummyValues = createTexture2D(gl, gl.RGBA16F, 1, 1, gl.RGBA, gl.HALF_FLOAT);
      this.dummyCoverage = createTexture2D(gl, gl.RG16F, 1, 1, gl.RG, gl.HALF_FLOAT);
      for (const level of this.levels) {
        const parent = topology.levels.get(level);
        const child = topology.levels.get(level + 1);
        const relation = relationTextures(gl, child, parent);
        this.relations.set(level, relation);
        const slots = [0, 1].map(() => ({
          values: createTexture2D(gl, gl.RGBA16F, parent.width, parent.height, gl.RGBA, gl.HALF_FLOAT),
          coverage: createTexture2D(gl, gl.RG16F, parent.width, parent.height, gl.RG, gl.HALF_FLOAT),
          framebuffer: gl.createFramebuffer()
        }));
        for (const slot of slots) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, slot.framebuffer);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, slot.values, 0);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, slot.coverage, 0);
          gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
          fail(gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE, `L${level} summary framebuffer is incomplete.`);
        }
        this.outputs.set(level, { levelData: parent, slots, framebufferComplete: true });
      }
    } finally {
      restorePassState(gl, constructionState);
    }
    this.readbackTexture = null;
    this.readbackFramebuffer = null;
  }

  reconstruct(physicalSource, { targetSlot = 0, measureGpu = false } = {}) {
    const physicalTexture = physicalSource?.texture;
    fail(physicalTexture, 'an R16F direct L13 physical source is required.');
    fail(physicalSource.levelData?.level === WEATHER_REFERENCE_LEVEL, 'physical summary source must be direct L13.');
    fail(physicalSource.levelData.width === this.topology.levels.get(WEATHER_REFERENCE_LEVEL).width
      && physicalSource.levelData.height === this.topology.levels.get(WEATHER_REFERENCE_LEVEL).height,
    'physical summary source dimensions do not match the summary topology.');
    fail(canonicalWindowsEqual(physicalSource.topology?.canonicalWindow, this.topology.canonicalWindow),
      'physical summary source window does not match the summary topology.');
    fail(targetSlot === 0 || targetSlot === 1, 'summary target slot must be 0 or 1.');
    const gl = this.gl;
    const passState = capturePassState(gl, [0, 1, 2, 3, 4]);
    const started = globalThis.performance?.now?.() ?? Date.now();
    let query = null;
    const timerExtension = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.pollTimerQueries();
    try {
      gl.useProgram(this.program);
      gl.bindVertexArray(this.quad.vao);
      gl.disable(gl.BLEND);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.CULL_FACE);
      gl.colorMask(true, true, true, true);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, physicalTexture);
      gl.uniform1i(this.locations.u_physical, 0);
      this.lastPassOwnership = [];
      let inputKind = 0;
      let inputValues = null;
      let inputCoverage = null;
      let inputSize = { width: this.topology.levels.get(WEATHER_REFERENCE_LEVEL).width, height: this.topology.levels.get(WEATHER_REFERENCE_LEVEL).height };
      for (const level of this.levels) {
        const output = this.outputs.get(level);
        const slot = output.slots[targetSlot];
        const relation = this.relations.get(level);
        gl.bindFramebuffer(gl.FRAMEBUFFER, slot.framebuffer);
        gl.viewport(0, 0, output.levelData.width, output.levelData.height);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
        const bind = (unit, target, texture, location) => {
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(target, texture);
          gl.uniform1i(location, unit);
        };
        bind(0, gl.TEXTURE_2D, physicalTexture, this.locations.u_physical);
        // The direct L13 pass does not read recursive inputs, but WebGL still
        // rejects an attached destination that is bound to any sampler.
        bind(1, gl.TEXTURE_2D, inputValues || this.dummyValues, this.locations.u_values);
        bind(2, gl.TEXTURE_2D, inputCoverage || this.dummyCoverage, this.locations.u_coverage);
        bind(3, gl.TEXTURE_2D, relation.indexTexture, this.locations.u_relationIndices);
        bind(4, gl.TEXTURE_2D, relation.weightTexture, this.locations.u_relationWeights);
        gl.uniform2i(this.locations.u_inputSize, inputSize.width, inputSize.height);
        gl.uniform2i(this.locations.u_outputSize, output.levelData.width, output.levelData.height);
        gl.uniform1i(this.locations.u_inputKind, inputKind);
        gl.uniform1i(this.locations.u_relationLayers, relation.layers);
        gl.uniform2i(this.locations.u_relationTextureSize, relation.width, relation.height);
        gl.uniform1i(this.locations.u_relationParentCount, output.levelData.count);
        const passPlan = GPU_PHYSICAL_SUMMARY_PASS_PLAN.find((entry) => entry.level === level);
        this.lastPassOwnership.push({
          level,
          source: passPlan.source,
          destination: passPlan.destination,
          sourceTextureDistinctFromDestination: true,
          framebufferComplete: output.framebufferComplete
        });
        if (measureGpu && timerExtension && !query) {
          query = gl.createQuery();
          gl.beginQuery(timerExtension.TIME_ELAPSED_EXT, query);
        }
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        if (query && level === this.levels[this.levels.length - 1]) {
          gl.endQuery(timerExtension.TIME_ELAPSED_EXT);
        }
        this.reconstructionPassCount++;
        inputKind = 1;
        inputValues = slot.values;
        inputCoverage = slot.coverage;
        inputSize = output.levelData;
      }
      this.lastUpdateMs = (globalThis.performance?.now?.() ?? Date.now()) - started;
      this.lastGpuError = gl.getError();
      if (query) this.pendingTimerQueries.push({ query, extension: timerExtension });
      return this.diagnostics();
    } finally {
      restorePassState(gl, passState);
    }
  }

  pollTimerQueries() {
    const gl = this.gl;
    const timerExtension = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!timerExtension || gl.getParameter(timerExtension.GPU_DISJOINT_EXT)) return;
    this.pendingTimerQueries = this.pendingTimerQueries.filter(({ query }) => {
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) return true;
      this.lastGpuPassMs = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(query);
      return false;
    });
  }

  ensureReadbackTarget(width, height) {
    const gl = this.gl;
    if (this.readbackTexture && this.readbackWidth === width && this.readbackHeight === height) return;
    if (this.readbackTexture) gl.deleteTexture(this.readbackTexture);
    if (this.readbackFramebuffer) gl.deleteFramebuffer(this.readbackFramebuffer);
    const state = capturePassState(gl, [0]);
    try {
      this.readbackTexture = createTexture2D(gl, gl.RGBA32F, width, height, gl.RGBA, gl.FLOAT);
    } finally {
      restorePassState(gl, state);
    }
    this.readbackFramebuffer = gl.createFramebuffer();
    this.readbackWidth = width;
    this.readbackHeight = height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.readbackFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.readbackTexture, 0);
    fail(gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE, 'summary readback framebuffer is incomplete.');
  }

  readback(level, targetSlot = 0) {
    fail(this.outputs.has(level), `L${level} summary is not allocated.`);
    fail(targetSlot === 0 || targetSlot === 1, 'summary readback slot must be 0 or 1.');
    const gl = this.gl;
    const output = this.outputs.get(level);
    const passState = capturePassState(gl, [0]);
    const values = new Float32Array(output.levelData.count * 4);
    const coverage = new Float32Array(output.levelData.count * 4);
    try {
      this.ensureReadbackTarget(output.levelData.width, output.levelData.height);
      gl.useProgram(this.copyProgram);
      gl.bindVertexArray(this.quad.vao);
      gl.disable(gl.BLEND);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.CULL_FACE);
      gl.depthMask(false);
      gl.colorMask(true, true, true, true);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.readbackFramebuffer);
      gl.viewport(0, 0, output.levelData.width, output.levelData.height);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
      gl.pixelStorei(gl.PACK_SKIP_PIXELS, 0);
      gl.pixelStorei(gl.PACK_SKIP_ROWS, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(this.copyLocation.source, 0);
      gl.bindTexture(gl.TEXTURE_2D, output.slots[targetSlot].values);
      gl.uniform1i(this.copyLocation.kind, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, output.levelData.width, output.levelData.height, gl.RGBA, gl.FLOAT, values);
      gl.bindTexture(gl.TEXTURE_2D, output.slots[targetSlot].coverage);
      gl.uniform1i(this.copyLocation.kind, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, output.levelData.width, output.levelData.height, gl.RGBA, gl.FLOAT, coverage);
      fail(gl.getError() === gl.NO_ERROR, 'summary readback failed.');
      return { values, coverage };
    } finally {
      restorePassState(gl, passState);
    }
  }

  validate(level, referenceSummary, { targetSlot = 0, maximumSamples = 32768 } = {}) {
    const actual = this.readback(level, targetSlot);
    const count = this.outputs.get(level).levelData.count;
    const actualChannels = {
      totalWeight: actual.values.filter((_, index) => index % 4 === 2),
      rainWeightedSumMmh: actual.values.filter((_, index) => index % 4 === 0),
      rainMaxMmh: actual.values.filter((_, index) => index % 4 === 1),
      'rainCoverageWeight@0.05': actual.coverage.filter((_, index) => index % 4 === 0),
      'rainCoverageWeight@2.5': actual.coverage.filter((_, index) => index % 4 === 1)
    };
    const referenceChannels = {
      totalWeight: referenceSummary.totalWeight,
      rainWeightedSumMmh: referenceSummary.rainWeightedSumMmh,
      rainMaxMmh: referenceSummary.rainMaxMmh,
      'rainCoverageWeight@0.05': referenceSummary.rainCoverageWeight[0],
      'rainCoverageWeight@2.5': referenceSummary.rainCoverageWeight[1]
    };
    const channels = Object.fromEntries(Object.entries(referenceChannels).map(([name, reference]) => [
      name, channelMetrics(reference, actualChannels[name], count, maximumSamples)
    ]));
    const classificationChanges = { wet: 0, strong: 0 };
    for (let index = 0; index < count; index++) {
      if ((referenceChannels['rainCoverageWeight@0.05'][index] > 0) !== (actualChannels['rainCoverageWeight@0.05'][index] > 0)) classificationChanges.wet++;
      if ((referenceChannels['rainCoverageWeight@2.5'][index] > 0) !== (actualChannels['rainCoverageWeight@2.5'][index] > 0)) classificationChanges.strong++;
    }
    this.lastValidation = { level, channels, classificationChanges, readbackIncluded: true };
    return this.lastValidation;
  }

  diagnostics() {
    const summaryLevels = Object.fromEntries(this.levels.map((level) => {
      const output = this.outputs.get(level);
      const relation = this.relations.get(level);
      const count = output.levelData.count;
      return [level, {
        width: output.levelData.width,
        height: output.levelData.height,
        sampleCount: count,
        channelFormat: 'RGBA16F+RG16F',
        bytesPerSample: 12,
        bytesPerKeyframe: count * 12,
        persistentABBytes: count * 24,
        framebufferComplete: output.framebufferComplete,
        relationMaximumContributions: relation.maximumContributions,
        relationMetadataGpuBytes: relation.gpuBytes,
        relationMetadataCpuUploadBytes: relation.cpuStagingBytes,
        relationTexture: {
          target: relation.target,
          width: relation.width,
          height: relation.height,
          depth: relation.depth,
          layers: relation.layers,
          semanticTexelCount: relation.semanticTexelCount,
          paddedTexelCount: relation.paddedTexelCount,
          maximumTextureSize: relation.maximumTextureSize
        }
      }];
    }));
    const persistentGpuSummaryBytes = this.levels.reduce((total, level) => total + summaryLevels[level].persistentABBytes, 0);
    const relationMetadataGpuBytes = this.levels.reduce((total, level) => total + summaryLevels[level].relationMetadataGpuBytes, 0);
    const relationMetadataCpuUploadBytes = this.levels.reduce((total, level) => total + summaryLevels[level].relationMetadataCpuUploadBytes, 0);
    const cpuSummaryBytesPerKeyframe = this.levels.reduce((total, level) => total + summaryLevels[level].sampleCount * 5 * Float32Array.BYTES_PER_ELEMENT, 0);
    return {
      active: true,
      profile: GPU_PHYSICAL_SUMMARY_PROFILE,
      sourceLevel: WEATHER_REFERENCE_LEVEL,
      levels: summaryLevels,
      channelNames: GPU_PHYSICAL_SUMMARY_CHANNELS,
      channelFormat: 'RGBA16F+RG16F',
      bytesPerSample: 12,
      persistentGpuSummaryBytes,
      relationMetadataGpuBytes,
      relationMetadataCpuUploadBytes,
      webglLimits: {
        maxTextureSize: this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE),
        max3DTextureSize: this.gl.getParameter(this.gl.MAX_3D_TEXTURE_SIZE),
        maxArrayTextureLayers: this.gl.getParameter(this.gl.MAX_ARRAY_TEXTURE_LAYERS)
      },
      transientScratchGpuBytes: 0,
      summaryReconstructionPassCount: this.reconstructionPassCount,
      cpuSummaryBytesAvoidedByGpuCalculation: cpuSummaryBytesPerKeyframe * 2,
      lastUpdateMs: this.lastUpdateMs,
      lastGpuPassMs: this.lastGpuPassMs,
      pendingTimerQueries: this.pendingTimerQueries.length,
      passOwnership: this.lastPassOwnership,
      lastGpuError: this.lastGpuError,
      lastValidation: this.lastValidation
    };
  }

  destroy() {
    const gl = this.gl;
    for (const relation of this.relations.values()) {
      gl.deleteTexture(relation.indexTexture);
      gl.deleteTexture(relation.weightTexture);
    }
    for (const output of this.outputs.values()) for (const slot of output.slots) {
      gl.deleteTexture(slot.values);
      gl.deleteTexture(slot.coverage);
      gl.deleteFramebuffer(slot.framebuffer);
    }
    gl.deleteTexture(this.dummyValues);
    gl.deleteTexture(this.dummyCoverage);
    gl.deleteTexture(this.readbackTexture);
    gl.deleteFramebuffer(this.readbackFramebuffer);
    gl.deleteProgram(this.program);
    gl.deleteProgram(this.copyProgram);
    gl.deleteBuffer(this.quad.buffer);
    gl.deleteVertexArray(this.quad.vao);
    this.relations.clear();
    this.outputs.clear();
  }
}
