import { setGeographicProjection } from './geographic-layer-utils.js';
import {
  DOTS_BASE_RAIN_MAX_RADIUS_FRACTION,
  DOTS_STRONG_RAIN_FULL_MMH,
  DOTS_STRONG_RAIN_ONSET_MMH,
  DOTS_STRONG_RAIN_SHAPE_ANCHORS,
  RAIN_VISIBILITY_SHADER
} from './precipitation-mapping.js';

export const TILED_RAIN_SCHEMA = 'dot-field-tiled-rain-v0';
export const TILED_RAIN_LOD_LEVEL = 13;
export const TILED_RAIN_TILE_SIZE = 128;
export const TILED_RAIN_GRID_SIZE = 2 ** TILED_RAIN_LOD_LEVEL;
// This is a hard ready-block ceiling. Current visible target pairs fit within
// it; fallback blocks are best-effort when a large jump would exceed it.
const MAX_RESIDENT_BLOCKS = 320;
const MAX_BLOCK_BYTES = TILED_RAIN_TILE_SIZE * TILED_RAIN_TILE_SIZE * 4 * Uint16Array.BYTES_PER_ELEMENT;
const MAX_CPU_RESIDENT_BYTES = MAX_RESIDENT_BLOCKS * MAX_BLOCK_BYTES;
const MAX_GPU_RESIDENT_BYTES = MAX_CPU_RESIDENT_BYTES;
export const TILED_RAIN_MAX_CONCURRENT_FETCHES = 8;
const VIEWPORT_OVERSCAN_SAMPLES = 64;
const QUAD = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
const COLORS = { rain: [0, 0.565, 1, 1], strong: [0, 0, 1, 1] };
const now = () => globalThis.performance?.now?.() ?? Date.now();

function clearError(message) {
  throw new Error(`Tiled rain asset validation failed: ${message}`);
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) clearError(`${name} must be a positive integer.`);
  return value;
}

function resolveAssetUrl(manifestUrl, asset) {
  return new URL(asset, new URL(manifestUrl, globalThis.location?.href || manifestUrl)).href;
}

function sourceFrameForTime(frameCount, time) {
  const position = Math.max(0, Math.min(1, Number.isFinite(time) ? time : 0)) * (frameCount - 1);
  const frame0 = Math.floor(position);
  const progress = position - frame0;
  return {
    frame0,
    frame1: progress === 0 ? frame0 : Math.min(frameCount - 1, frame0 + 1),
    progress
  };
}

function validateManifest(manifest) {
  if (!manifest || manifest.schema !== TILED_RAIN_SCHEMA || manifest.version !== 0) clearError('schema/version is not supported.');
  if (manifest.lod_level !== TILED_RAIN_LOD_LEVEL) clearError('only L13 is supported.');
  if (manifest.tile_size !== TILED_RAIN_TILE_SIZE || manifest.grid_size !== TILED_RAIN_GRID_SIZE) clearError('tile/grid dimensions are invalid.');
  positiveInteger(manifest.frame_count, 'frame_count');
  positiveInteger(manifest.temporal_block_size, 'temporal_block_size');
  if (!Array.isArray(manifest.timestamps) || manifest.timestamps.length !== manifest.frame_count) clearError('timestamps do not match frame_count.');
  if (!Array.isArray(manifest.tiles) || !manifest.tiles.length) clearError('tiles are missing.');
  if (manifest.physical_units !== 'mm/h' || manifest.byte_order !== 'little-endian') clearError('physical units or byte order are invalid.');
  const encoding = manifest.encoding;
  if (!encoding || encoding.dtype !== 'UInt16' || encoding.nodata_code !== 0 || encoding.dry_code !== 1
    || encoding.positive_code_min !== 2 || encoding.positive_code_max !== 65535
    || encoding.positive_quantized_range !== 65534
    || !Number.isFinite(encoding.physical_max_mmh) || encoding.physical_max_mmh <= 0) {
    clearError('UInt16 encoding semantics are invalid.');
  }
  const seenTiles = new Set();
  const seenBlocks = new Set();
  for (const tile of manifest.tiles) {
    if (!Number.isInteger(tile.x) || !Number.isInteger(tile.y) || !Array.isArray(tile.blocks)) clearError('tile descriptor is invalid.');
    const tileKey = `${tile.x}:${tile.y}`;
    if (seenTiles.has(tileKey)) clearError(`duplicate tile ${tileKey}.`);
    seenTiles.add(tileKey);
    for (const block of tile.blocks) {
      const key = `${tileKey}:${block.index}`;
      if (!Number.isInteger(block.index) || !Number.isInteger(block.frame_start) || !Number.isInteger(block.frame_count)
        || block.frame_count < 1 || block.frame_start < 0 || block.frame_start + block.frame_count > manifest.frame_count
        || typeof block.asset !== 'string' || block.sample_count !== TILED_RAIN_TILE_SIZE ** 2
        || block.byte_length !== block.sample_count * block.frame_count * Uint16Array.BYTES_PER_ELEMENT) {
        clearError(`block ${key} is invalid.`);
      }
      if (seenBlocks.has(key)) clearError(`duplicate block ${key}.`);
      seenBlocks.add(key);
    }
  }
  return manifest;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to load tiled rain manifest ${url} (${response.status}).`);
  try {
    return await response.json();
  } catch {
    clearError('manifest is not valid JSON.');
  }
}

async function loadAndValidateDataset(manifestUrl, timing) {
  timing('tiled-rain-manifest-fetch-start');
  const manifest = validateManifest(await fetchJson(manifestUrl));
  timing('tiled-rain-manifest-validation-complete');
  if (typeof manifest.source_generation_id !== 'string' || !manifest.source_generation_id) clearError('source_generation_id is missing.');
  if (typeof manifest.source_metadata_asset !== 'string') clearError('source_metadata_asset is missing.');
  timing('tiled-rain-source-metadata-fetch-start');
  const sourceMetadata = await fetchJson(resolveAssetUrl(manifestUrl, manifest.source_metadata_asset));
  if (sourceMetadata.generation_id !== manifest.source_generation_id) {
    clearError(`source generation mismatch: manifest=${manifest.source_generation_id}, current=${sourceMetadata.generation_id || '<missing>'}.`);
  }
  timing('tiled-rain-source-generation-verified');
  const tiles = new Map();
  for (const tile of manifest.tiles) tiles.set(`${tile.x}:${tile.y}`, tile);
  return Object.freeze({ manifest, manifestUrl, tiles });
}

export class TiledRainTileStore {
  constructor(dataset, { onTiming = null } = {}) {
    this.dataset = dataset;
    this.manifest = dataset.manifest;
    this.tiles = dataset.tiles;
    this.onTiming = typeof onTiming === 'function' ? onTiming : () => {};
    this.startedAt = now();
    this.blocks = new Map();
    this.lastUsed = 0;
    this.diagnosticsState = {
      sourceGenerationId: this.manifest.source_generation_id,
      visibleTileCount: 0,
      residentTileCount: 0,
      residentTileBlockCount: 0,
      pendingRequestCount: 0,
      logicalUInt16ResidentBytes: 0,
      estimatedGpuTextureBytes: 0,
      tileRequestCount: 0,
      tileFetchCount: 0,
      tileUploadCount: 0,
      latestGpuUploadMs: 0,
      cumulativeGpuUploadMs: 0,
      firstTiledWeatherVisibleMs: null,
      evictions: 0,
      staleDesiredStates: 0,
      sourceFrameStackFetched: false,
      maxResidentBlocks: MAX_RESIDENT_BLOCKS,
      maxCpuResidentBytes: MAX_CPU_RESIDENT_BYTES,
      maxGpuTextureBytes: MAX_GPU_RESIDENT_BYTES,
      peakResidentBlockCount: 0,
      peakLogicalUInt16ResidentBytes: 0,
      peakEstimatedGpuTextureBytes: 0,
      inFlightFetchCount: 0,
      queuedFetchCount: 0,
      abortedObsoleteRequestCount: 0,
      maxConcurrentFetches: TILED_RAIN_MAX_CONCURRENT_FETCHES,
      peakInFlightFetchCount: 0,
      lastError: null
    };
    this.fetchQueue = [];
    this.inFlightFetchCount = 0;
    this.latestUsefulBlockKeys = new Set();
    this.protectedBlockKeys = new Set();
    this.maxTargetBlocks = this.tiles.size * 2;
    this.maxTrackedBlocks = MAX_RESIDENT_BLOCKS + this.maxTargetBlocks + TILED_RAIN_MAX_CONCURRENT_FETCHES;
    this.diagnosticsState.maxPendingBlocks = this.maxTargetBlocks + TILED_RAIN_MAX_CONCURRENT_FETCHES;
    this.diagnosticsState.maxTrackedBlocks = this.maxTrackedBlocks;
    this.diagnosticsState.trackedBlockCount = 0;
    this.diagnosticsState.peakTrackedBlockCount = 0;
  }

  descriptor(tileKey, blockIndex) {
    const tile = this.tiles.get(tileKey);
    return tile?.blocks.find((block) => block.index === blockIndex) || null;
  }

  ensureBlock(tileKey, blockIndex) {
    const key = `${tileKey}:${blockIndex}`;
    let state = this.blocks.get(key);
    if (state?.status === 'ready') {
      state.lastUsed = ++this.lastUsed;
      return Promise.resolve(state);
    }
    if (state?.promise) return state.promise;
    const descriptor = this.descriptor(tileKey, blockIndex);
    if (!descriptor) throw new Error(`Tiled rain block ${key} is not present in the manifest.`);
    state = state || { key, tileKey, blockIndex, descriptor, status: 'queued', lastUsed: ++this.lastUsed, payload: null, gpuTexture: null };
    state.status = 'queued';
    state.obsolete = false;
    state.promise = new Promise((resolve, reject) => {
      state.resolve = resolve;
      state.reject = reject;
    });
    this.blocks.set(key, state);
    this.fetchQueue.push(state);
    this.diagnosticsState.pendingRequestCount++;
    this.diagnosticsState.queuedFetchCount++;
    this.pumpFetchQueue();
    return state.promise;
  }

  updateDesiredBlockKeys(usefulKeys) {
    this.latestUsefulBlockKeys = new Set(usefulKeys);
    for (const state of [...this.blocks.values()]) {
      if ((state.status === 'queued' || state.status === 'pending') && !this.latestUsefulBlockKeys.has(state.key)) {
        this.abortObsoleteState(state);
      }
    }
    this.fetchQueue = this.fetchQueue.filter((state) => state.status === 'queued' && !state.obsolete);
    this.diagnosticsState.queuedFetchCount = this.fetchQueue.length;
    this.pumpFetchQueue();
  }

  abortObsoleteState(state) {
    if (state.obsolete || state.status === 'ready' || state.status === 'error') return;
    state.obsolete = true;
    this.diagnosticsState.abortedObsoleteRequestCount++;
    if (state.status === 'queued') {
      state.status = 'aborted';
      this.diagnosticsState.pendingRequestCount = Math.max(0, this.diagnosticsState.pendingRequestCount - 1);
      this.diagnosticsState.queuedFetchCount = Math.max(0, this.diagnosticsState.queuedFetchCount - 1);
      state.resolve?.(null);
      state.promise = null;
      this.blocks.delete(state.key);
      return;
    }
    state.controller?.abort();
  }

  pumpFetchQueue() {
    while (this.inFlightFetchCount < TILED_RAIN_MAX_CONCURRENT_FETCHES && this.fetchQueue.length) {
      const state = this.fetchQueue.shift();
      this.diagnosticsState.queuedFetchCount = this.fetchQueue.length;
      if (!state || state.obsolete || state.status !== 'queued') continue;
      this.startFetch(state);
    }
  }

  startFetch(state) {
    state.status = 'pending';
    state.controller = new AbortController();
    this.inFlightFetchCount++;
    this.diagnosticsState.inFlightFetchCount = this.inFlightFetchCount;
    this.diagnosticsState.peakInFlightFetchCount = Math.max(this.diagnosticsState.peakInFlightFetchCount, this.inFlightFetchCount);
    this.diagnosticsState.tileRequestCount++;
    const url = resolveAssetUrl(this.dataset.manifestUrl, state.descriptor.asset);
    this.onTiming(`tiled-rain-block-${state.tileKey}-${state.blockIndex}-fetch-start`);
    void fetch(url, { signal: state.controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Unable to load tiled rain block ${url} (${response.status}).`);
        return response.arrayBuffer();
      })
      .then((payload) => {
        if (state.obsolete || !this.latestUsefulBlockKeys.has(state.key)) {
          state.status = 'aborted';
          state.resolve(null);
          return null;
        }
        if (payload.byteLength !== state.descriptor.byte_length) throw new Error(`Tiled rain block ${state.key} byte length is ${payload.byteLength}, expected ${state.descriptor.byte_length}.`);
        state.payload = payload;
        state.status = 'ready';
        state.lastUsed = ++this.lastUsed;
        this.diagnosticsState.tileFetchCount++;
        this.evict(this.protectedBlockKeys);
        this.onTiming(`tiled-rain-block-${state.tileKey}-${state.blockIndex}-fetch-complete`);
        state.resolve(state);
        return state;
      })
      .catch((error) => {
        if (state.obsolete || error?.name === 'AbortError') {
          state.status = 'aborted';
          state.resolve(null);
          return null;
        }
        state.status = 'error';
        this.diagnosticsState.lastError = error instanceof Error ? error.message : String(error);
        state.reject(error);
        return null;
      })
      .finally(() => {
        this.inFlightFetchCount = Math.max(0, this.inFlightFetchCount - 1);
        this.diagnosticsState.inFlightFetchCount = this.inFlightFetchCount;
        this.diagnosticsState.pendingRequestCount = Math.max(0, this.diagnosticsState.pendingRequestCount - 1);
        state.controller = null;
        state.promise = null;
        if (state.status === 'aborted' || state.status === 'error') this.blocks.delete(state.key);
        this.updateMemoryDiagnostics();
        this.pumpFetchQueue();
      });
  }

  evict(keepKeys) {
    const candidates = [...this.blocks.values()]
      .filter((state) => state.status === 'ready' && !keepKeys.has(state.key))
      .sort((left, right) => left.lastUsed - right.lastUsed);
    let readyBlockCount = [...this.blocks.values()].filter((state) => state.status === 'ready').length;
    while (readyBlockCount > MAX_RESIDENT_BLOCKS && candidates.length) {
      const state = candidates.shift();
      if (state.gpuTexture && this.gl) this.gl.deleteTexture(state.gpuTexture);
      this.blocks.delete(state.key);
      readyBlockCount--;
      this.diagnosticsState.evictions++;
    }
    this.updateMemoryDiagnostics();
  }

  setVisibleTileCount(count) {
    this.diagnosticsState.visibleTileCount = count;
  }

  setProtectedBlockKeys(keys) {
    this.protectedBlockKeys = new Set(keys);
    this.evict(this.protectedBlockKeys);
  }

  updateMemoryDiagnostics() {
    let bytes = 0;
    let gpuBytes = 0;
    const tileKeys = new Set();
    for (const state of this.blocks.values()) {
      if (state.status !== 'ready') continue;
      tileKeys.add(state.tileKey);
      bytes += state.payload?.byteLength || 0;
      gpuBytes += state.gpuTexture ? TILED_RAIN_TILE_SIZE * TILED_RAIN_TILE_SIZE * state.descriptor.frame_count * 2 : 0;
    }
    this.diagnosticsState.residentTileCount = tileKeys.size;
    this.diagnosticsState.residentTileBlockCount = [...this.blocks.values()].filter((state) => state.status === 'ready').length;
    this.diagnosticsState.logicalUInt16ResidentBytes = bytes;
    this.diagnosticsState.estimatedGpuTextureBytes = gpuBytes;
    this.diagnosticsState.peakResidentBlockCount = Math.max(this.diagnosticsState.peakResidentBlockCount, this.diagnosticsState.residentTileBlockCount);
    this.diagnosticsState.peakLogicalUInt16ResidentBytes = Math.max(this.diagnosticsState.peakLogicalUInt16ResidentBytes, bytes);
    this.diagnosticsState.peakEstimatedGpuTextureBytes = Math.max(this.diagnosticsState.peakEstimatedGpuTextureBytes, gpuBytes);
    this.diagnosticsState.trackedBlockCount = this.blocks.size;
    this.diagnosticsState.peakTrackedBlockCount = Math.max(this.diagnosticsState.peakTrackedBlockCount, this.blocks.size);
  }

  uploadBlock(gl, state) {
    if (state.gpuTexture) return state.gpuTexture;
    const started = now();
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(
      gl.TEXTURE_2D_ARRAY, 0, gl.R16UI,
      TILED_RAIN_TILE_SIZE, TILED_RAIN_TILE_SIZE, state.descriptor.frame_count,
      0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, new Uint16Array(state.payload)
    );
    state.gpuTexture = texture;
    this.gl = gl;
    this.diagnosticsState.tileUploadCount++;
    this.diagnosticsState.latestGpuUploadMs = now() - started;
    this.diagnosticsState.cumulativeGpuUploadMs += this.diagnosticsState.latestGpuUploadMs;
    this.updateMemoryDiagnostics();
    return texture;
  }

  diagnostics() {
    this.updateMemoryDiagnostics();
    return { ...this.diagnosticsState };
  }
}

function strongRainShader() {
  const lines = [`float strongRain(float value) {`, `  if (value <= ${DOTS_STRONG_RAIN_ONSET_MMH.toFixed(6)}) return 0.0;`];
  for (let index = 1; index < DOTS_STRONG_RAIN_SHAPE_ANCHORS.length; index++) {
    const lower = DOTS_STRONG_RAIN_SHAPE_ANCHORS[index - 1];
    const upper = DOTS_STRONG_RAIN_SHAPE_ANCHORS[index];
    const threshold = DOTS_STRONG_RAIN_ONSET_MMH + upper.progress * (DOTS_STRONG_RAIN_FULL_MMH - DOTS_STRONG_RAIN_ONSET_MMH);
    const lowerThreshold = DOTS_STRONG_RAIN_ONSET_MMH + lower.progress * (DOTS_STRONG_RAIN_FULL_MMH - DOTS_STRONG_RAIN_ONSET_MMH);
    lines.push(`  if (value <= ${threshold.toFixed(6)}) {`);
    lines.push(`    float t = (value - ${lowerThreshold.toFixed(6)}) / ${(threshold - lowerThreshold).toFixed(6)};`);
    lines.push(`    return sqrt(mix(${(lower.radius * lower.radius).toFixed(6)}, ${(upper.radius * upper.radius).toFixed(6)}, clamp(t, 0.0, 1.0)));`);
    lines.push('  }');
  }
  lines.push(`  return ${DOTS_STRONG_RAIN_SHAPE_ANCHORS.at(-1).radius.toFixed(6)};`, '}');
  return lines.join('\n');
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'Tiled rain shader compilation failed.');
  return shader;
}

function makeProgram(gl, shaderData) {
  const vertexSource = [
    '#version 300 es', shaderData.vertexShaderPrelude,
    'precision highp float; precision highp int; precision highp usampler2DArray;',
    'in vec2 a_vertex;',
    'uniform vec2 u_tileOrigin; uniform usampler2DArray u_rainA; uniform usampler2DArray u_rainB;',
    'uniform int u_frameLayerA; uniform int u_frameLayerB; uniform float u_temporalProgress; uniform int u_mode;',
    'out vec2 v_local; out float v_radius;',
    'uniform float u_physicalMaxMmh;',
    'float decodeRain(uint code) { if (code == 0u || code == 1u) return 0.0; return (float(code) - 1.0) / 65534.0 * u_physicalMaxMmh; }',
    RAIN_VISIBILITY_SHADER,
    strongRainShader(),
    'void main() {',
    `  int localIndex = gl_InstanceID; int localX = localIndex % ${TILED_RAIN_TILE_SIZE}; int localY = localIndex / ${TILED_RAIN_TILE_SIZE};`,
    '  uint codeA = texelFetch(u_rainA, ivec3(localX, localY, u_frameLayerA), 0).r;',
    '  uint codeB = texelFetch(u_rainB, ivec3(localX, localY, u_frameLayerB), 0).r;',
    '  bool validA = codeA != 0u; bool validB = codeB != 0u;',
    '  float rainA = decodeRain(codeA); float rainB = decodeRain(codeB);',
    '  float rain = validA && validB ? mix(rainA, rainB, u_temporalProgress) : validA ? rainA : validB ? rainB : 0.0;',
    `  float radiusFraction = u_mode == 0 ? rainVisibility(rain) * ${DOTS_BASE_RAIN_MAX_RADIUS_FRACTION.toFixed(6)} : strongRain(rain);`,
    `  v_radius = radiusFraction / ${TILED_RAIN_GRID_SIZE}.0; v_local = a_vertex;`,
    `  vec2 center = u_tileOrigin + vec2(float(localX), float(localY)) / ${TILED_RAIN_GRID_SIZE}.0;`,
    '  gl_Position = projectTile(center + a_vertex * v_radius);',
    '}'
  ].join('\n');
  const fragmentSource = [
    '#version 300 es', 'precision highp float;', 'in vec2 v_local; in float v_radius; uniform vec4 u_color; out vec4 fragColor;',
    'void main() { if (v_radius <= 0.0) discard; float distanceToCenter = length(v_local); float edge = fwidth(distanceToCenter); float alpha = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, distanceToCenter); fragColor = vec4(u_color.rgb, u_color.a * alpha); }'
  ].join('\n');
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Tiled rain shader linking failed.');
  return {
    program,
    locations: {
      vertex: gl.getAttribLocation(program, 'a_vertex'),
      tileOrigin: gl.getUniformLocation(program, 'u_tileOrigin'),
      rainA: gl.getUniformLocation(program, 'u_rainA'),
      rainB: gl.getUniformLocation(program, 'u_rainB'),
      frameLayerA: gl.getUniformLocation(program, 'u_frameLayerA'),
      frameLayerB: gl.getUniformLocation(program, 'u_frameLayerB'),
      temporalProgress: gl.getUniformLocation(program, 'u_temporalProgress'),
      physicalMaxMmh: gl.getUniformLocation(program, 'u_physicalMaxMmh'),
      mode: gl.getUniformLocation(program, 'u_mode'),
      color: gl.getUniformLocation(program, 'u_color'),
      matrix: gl.getUniformLocation(program, 'u_matrix'),
      fallbackMatrix: gl.getUniformLocation(program, 'u_projection_fallback_matrix'),
      projectionMatrix: gl.getUniformLocation(program, 'u_projection_matrix'),
      tileMercatorCoords: gl.getUniformLocation(program, 'u_projection_tile_mercator_coords'),
      clippingPlane: gl.getUniformLocation(program, 'u_projection_clipping_plane'),
      projectionTransition: gl.getUniformLocation(program, 'u_projection_transition')
    }
  };
}

export class TiledRainDotsLayer {
  constructor(store, { onTiming = null } = {}) {
    this.id = 'tiled-rain-dots';
    this.type = 'custom';
    this.renderingMode = '3d';
    this.store = store;
    this.onTiming = typeof onTiming === 'function' ? onTiming : () => {};
    this.programs = new Map();
    this.active = true;
    this.viewportTileKeys = [];
    this.requestedFrame = sourceFrameForTime(store.manifest.frame_count, 0);
    this.committedFrame = null;
    this.requestGeneration = 0;
    this.desiredBlockKeys = new Set();
    this.map = null;
    this.firstVisibleReported = false;
  }

  onAdd(map, gl) {
    if (!gl || typeof gl.texImage3D !== 'function' || typeof gl.drawArraysInstanced !== 'function') {
      throw new Error('Tiled rain Phase 0A requires a WebGL2 MapLibre context.');
    }
    this.map = map;
    this.gl = gl;
    this.vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
  }

  onRemove(map, gl) {
    for (const entry of this.programs.values()) gl.deleteProgram(entry.program);
    for (const state of this.store.blocks.values()) if (state.gpuTexture) gl.deleteTexture(state.gpuTexture);
    if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer);
  }

  tileKeysForBounds(bounds) {
    const minX = Math.floor((bounds.minX * TILED_RAIN_GRID_SIZE - VIEWPORT_OVERSCAN_SAMPLES) / TILED_RAIN_TILE_SIZE);
    const maxX = Math.floor((bounds.maxX * TILED_RAIN_GRID_SIZE + VIEWPORT_OVERSCAN_SAMPLES) / TILED_RAIN_TILE_SIZE);
    const minY = Math.floor((bounds.minY * TILED_RAIN_GRID_SIZE - VIEWPORT_OVERSCAN_SAMPLES) / TILED_RAIN_TILE_SIZE);
    const maxY = Math.floor((bounds.maxY * TILED_RAIN_GRID_SIZE + VIEWPORT_OVERSCAN_SAMPLES) / TILED_RAIN_TILE_SIZE);
    const indexBounds = this.store.manifest.tile_index_bounds;
    const keys = [];
    for (let y = Math.max(indexBounds.min_y, minY); y <= Math.min(indexBounds.max_y, maxY); y++) {
      for (let x = Math.max(indexBounds.min_x, minX); x <= Math.min(indexBounds.max_x, maxX); x++) {
        const key = `${x}:${y}`;
        if (this.store.tiles.has(key)) keys.push(key);
      }
    }
    return keys;
  }

  setViewportBounds(bounds) {
    if (!bounds) return;
    const nextKeys = this.tileKeysForBounds(bounds);
    if (nextKeys.join(',') === this.viewportTileKeys.join(',')) return;
    this.viewportTileKeys = nextKeys;
    this.store.setVisibleTileCount(nextKeys.length);
    this.requestState();
  }

  setTime(time) {
    const next = sourceFrameForTime(this.store.manifest.frame_count, time);
    const previous = this.requestedFrame;
    const previousBlockA = Math.floor(previous.frame0 / this.store.manifest.temporal_block_size);
    const previousBlockB = Math.floor(previous.frame1 / this.store.manifest.temporal_block_size);
    const blockA = Math.floor(next.frame0 / this.store.manifest.temporal_block_size);
    const blockB = Math.floor(next.frame1 / this.store.manifest.temporal_block_size);
    const changed = next.frame0 !== previous.frame0 || next.frame1 !== previous.frame1 || next.progress !== previous.progress;
    this.requestedFrame = next;
    if (!changed) return;
    if (blockA !== previousBlockA || blockB !== previousBlockB || !this.canRenderFrame(next)) this.requestState();
    else this.commitFrame(next);
  }

  requestState() {
    const generation = ++this.requestGeneration;
    const requestedFrame = this.requestedFrame;
    const targetKeys = this.blockKeysForFrame(requestedFrame, this.viewportTileKeys);
    const fallbackKeys = this.committedFrame
      ? this.blockKeysForFrame(this.committedFrame, this.viewportTileKeys)
      : new Set();
    // Fallback is only prefetched when already resident. This keeps pending
    // work bounded to the newest target while preserving ordinary transitions.
    const residentFallbackKeys = [...fallbackKeys].filter((key) => this.store.blocks.get(key)?.status === 'ready');
    const usefulKeys = new Set([...targetKeys, ...residentFallbackKeys]);
    this.desiredBlockKeys = targetKeys;
    this.store.setProtectedBlockKeys(targetKeys);
    this.store.updateDesiredBlockKeys(usefulKeys);
    // Target blocks have priority. Fallback remains protected during ordinary
    // adjacent transitions, but can be evicted on a large jump so the ready
    // block ceiling remains hard.
    this.store.evict(targetKeys);

    const ensure = (keys) => [...keys].map((key) => {
      const separator = key.lastIndexOf(':');
      const tileKey = key.slice(0, separator);
      const blockIndex = Number(key.slice(separator + 1));
      return this.store.ensureBlock(tileKey, blockIndex);
    });
    void Promise.all(ensure(targetKeys))
      .then(() => {
        if (generation !== this.requestGeneration) {
          this.store.diagnosticsState.staleDesiredStates++;
          return;
        }
        if (!this.allBlocksReady(targetKeys)) return;
        this.commitFrame(requestedFrame);
      })
      .catch((error) => {
        if (generation !== this.requestGeneration || error?.name === 'AbortError') return;
        console.error('Unable to load the required tiled rain state.', error);
        this.store.diagnosticsState.lastError = error instanceof Error ? error.message : String(error);
      });
    void Promise.all(ensure(residentFallbackKeys)).then(() => {
      if (generation === this.requestGeneration && this.committedFrame && this.canRenderFrame(this.committedFrame)) {
        this.map?.triggerRepaint();
      }
    }).catch((error) => {
      if (generation === this.requestGeneration && error?.name !== 'AbortError') {
        this.store.diagnosticsState.lastError = error instanceof Error ? error.message : String(error);
      }
    });
  }

  blockKeysForFrame(frame, tileKeys) {
    const blockA = Math.floor(frame.frame0 / this.store.manifest.temporal_block_size);
    const blockB = Math.floor(frame.frame1 / this.store.manifest.temporal_block_size);
    return new Set(tileKeys.flatMap((tileKey) => [blockA, blockB]
      .filter((block, index, values) => values.indexOf(block) === index)
      .map((block) => `${tileKey}:${block}`)));
  }

  allBlocksReady(keys) {
    return [...keys].every((key) => this.store.blocks.get(key)?.status === 'ready');
  }

  canRenderFrame(frame) {
    return this.allBlocksReady(this.blockKeysForFrame(frame, this.viewportTileKeys));
  }

  commitFrame(frame) {
    // Invalidate an older completion that may have raced a same-block direct
    // commit. The committed pair is always complete for the current viewport.
    this.requestGeneration++;
    this.committedFrame = frame;
    const targetKeys = this.blockKeysForFrame(frame, this.viewportTileKeys);
    this.desiredBlockKeys = targetKeys;
    this.store.setProtectedBlockKeys(targetKeys);
    this.store.updateDesiredBlockKeys(targetKeys);
    this.store.evict(targetKeys);
    this.map?.triggerRepaint();
  }

  setActive(active) {
    this.active = Boolean(active);
    this.map?.triggerRepaint();
  }

  setHazardsVisible() {}

  updateWeather(time) {
    this.setTime(time);
  }

  programsFor(gl, shaderData) {
    let program = this.programs.get(shaderData.variantName);
    if (!program) {
      program = makeProgram(gl, shaderData);
      this.programs.set(shaderData.variantName, program);
    }
    return program;
  }

  renderPass(gl, program, projection, tile, blockA, blockB, mode) {
    const { locations } = program;
    gl.useProgram(program.program);
    setGeographicProjection(gl, locations, projection);
    gl.uniform2f(
      locations.tileOrigin,
      (tile.x * TILED_RAIN_TILE_SIZE) / TILED_RAIN_GRID_SIZE,
      (tile.y * TILED_RAIN_TILE_SIZE) / TILED_RAIN_GRID_SIZE
    );
    gl.uniform1i(locations.rainA, 0);
    gl.uniform1i(locations.rainB, 1);
    gl.uniform1i(locations.frameLayerA, this.committedFrame.frame0 - blockA.descriptor.frame_start);
    gl.uniform1i(locations.frameLayerB, this.committedFrame.frame1 - blockB.descriptor.frame_start);
    gl.uniform1f(locations.temporalProgress, this.committedFrame.progress);
    gl.uniform1f(locations.physicalMaxMmh, this.store.manifest.encoding.physical_max_mmh);
    gl.uniform1i(locations.mode, mode);
    gl.uniform4fv(locations.color, COLORS[mode === 0 ? 'rain' : 'strong']);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, blockA.gpuTexture || this.store.uploadBlock(gl, blockA));
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, blockB.gpuTexture || this.store.uploadBlock(gl, blockB));
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.enableVertexAttribArray(locations.vertex);
    gl.vertexAttribPointer(locations.vertex, 2, gl.FLOAT, false, 0, 0);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, TILED_RAIN_TILE_SIZE * TILED_RAIN_TILE_SIZE);
  }

  render(gl, args) {
    if (!this.active) return;
    if (!this.committedFrame) return;
    const program = this.programsFor(gl, args.shaderData);
    const blockAIndex = Math.floor(this.committedFrame.frame0 / this.store.manifest.temporal_block_size);
    const blockBIndex = Math.floor(this.committedFrame.frame1 / this.store.manifest.temporal_block_size);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    let rendered = 0;
    for (const tileKey of this.viewportTileKeys) {
      const tile = this.store.tiles.get(tileKey);
      const blockA = this.store.blocks.get(`${tileKey}:${blockAIndex}`);
      const blockB = this.store.blocks.get(`${tileKey}:${blockBIndex}`);
      if (!tile || blockA?.status !== 'ready' || blockB?.status !== 'ready') continue;
      this.renderPass(gl, program, args.defaultProjectionData, tile, blockA, blockB, 0);
      this.renderPass(gl, program, args.defaultProjectionData, tile, blockA, blockB, 1);
      rendered++;
    }
    gl.depthMask(true);
    if (rendered && !this.firstVisibleReported) {
      this.firstVisibleReported = true;
      this.store.diagnosticsState.firstTiledWeatherVisibleMs = now() - this.store.startedAt;
      this.onTiming('tiled-rain-first-weather-visible');
    }
  }

  diagnostics() {
    const frame = this.committedFrame || this.requestedFrame;
    const blockA = Math.floor(frame.frame0 / this.store.manifest.temporal_block_size);
    const blockB = Math.floor(frame.frame1 / this.store.manifest.temporal_block_size);
    return {
      ...this.store.diagnostics(),
      active: this.active,
      visibleTileCount: this.viewportTileKeys.length,
      currentSourceFramePair: [frame.frame0, frame.frame1],
      temporalProgress: frame.progress,
      requestedSourceFramePair: [this.requestedFrame.frame0, this.requestedFrame.frame1],
      requestedTemporalProgress: this.requestedFrame.progress,
      committedSourceFramePair: this.committedFrame ? [this.committedFrame.frame0, this.committedFrame.frame1] : null,
      temporalCommitPending: !this.committedFrame
        || this.requestedFrame.frame0 !== this.committedFrame.frame0
        || this.requestedFrame.frame1 !== this.committedFrame.frame1
        || this.requestedFrame.progress !== this.committedFrame.progress,
      currentTemporalBlocks: [blockA, blockB],
      lodLevel: TILED_RAIN_LOD_LEVEL,
      tileSize: TILED_RAIN_TILE_SIZE,
      proceduralInstancesPerTile: TILED_RAIN_TILE_SIZE * TILED_RAIN_TILE_SIZE
    };
  }
}

export function beginTiledRainLoad(manifestUrl, { onTiming = null } = {}) {
  const timing = typeof onTiming === 'function' ? onTiming : () => {};
  const metadataReady = loadAndValidateDataset(manifestUrl, timing).then((dataset) => {
    const store = new TiledRainTileStore(dataset, { onTiming: timing });
    return Object.freeze({
      isTiledRain: true,
      frameCount: dataset.manifest.frame_count,
      timestamps: dataset.manifest.timestamps,
      generationId: dataset.manifest.source_generation_id,
      tileStore: store
    });
  });
  return {
    metadataReady,
    async loadSequence() {
      return metadataReady;
    },
    async prepareInitialPlaybackBuffer() {
      await metadataReady;
      return { frameIndices: [] };
    },
    setBackgroundPrefetchPaused() {},
    diagnostics() {
      return null;
    }
  };
}
