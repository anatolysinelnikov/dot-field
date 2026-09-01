// Shareable provider-side temporal-tile GPU residency.
//
// A provider revision has an immutable tileId -> atlas-slot mapping for its
// lifetime. Reconstruction targets retain a revision handle and own their
// target-local indirection and output textures separately.

import { sourceTileRangeForWindow } from './gpu-weather-spatial.js';

export const GPU_TEMPORAL_TILE_CONTRACT = 'dot-field-temporal-tiles-v1';

function fail(ok, message) { if (!ok) throw new Error(`GPU weather provider residency: ${message}`); }
function timingNow() { return globalThis.performance?.now?.() ?? Date.now(); }
function tex2(gl, internal, width, height, format, type, data = null) {
  const value = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, value);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, data);
  return value;
}
function texArray(gl, internal, width, height, layers, format, type) {
  const value = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, value);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, internal, width, height, layers, 0, format, type, null);
  return value;
}

// WebGL keeps deleted texture objects in texture-unit bindings until those
// bindings change. Only clear the provider texture being retired.
export function deleteOwnedTexture(gl, texture) {
  if (!texture) return null;
  const started = timingNow();
  const activeTexture = gl.getParameter(gl.ACTIVE_TEXTURE);
  const unitCount = Math.max(1, gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) || 1);
  for (let unit = 0; unit < unitCount; unit++) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    if (gl.getParameter(gl.TEXTURE_BINDING_2D) === texture) gl.bindTexture(gl.TEXTURE_2D, null);
    if (gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY) === texture) gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  }
  gl.activeTexture(activeTexture);
  const bindingCleanupMs = timingNow() - started;
  const deletionStarted = timingNow();
  gl.deleteTexture(texture);
  return { bindingCleanupMs, deletionMs: timingNow() - deletionStarted };
}

const PIXEL_STORE_PARAMETERS = [
  'UNPACK_ALIGNMENT', 'UNPACK_ROW_LENGTH', 'UNPACK_IMAGE_HEIGHT',
  'UNPACK_SKIP_PIXELS', 'UNPACK_SKIP_ROWS', 'UNPACK_SKIP_IMAGES'
];
function pixelStoreState(gl) {
  return Object.fromEntries(PIXEL_STORE_PARAMETERS.map((name) => [name, gl.getParameter(gl[name])]));
}
function withTightlyPackedUploads(gl, callback) {
  const previous = pixelStoreState(gl);
  for (const name of PIXEL_STORE_PARAMETERS) gl.pixelStorei(gl[name], name === 'UNPACK_ALIGNMENT' ? 1 : 0);
  try { return callback(previous); } finally {
    for (const name of PIXEL_STORE_PARAMETERS) gl.pixelStorei(gl[name], previous[name]);
  }
}
function assetUrl(metadataUrl, asset) { return new URL(asset, new URL(metadataUrl, location.href)).href; }

const metadataCache = new Map();
async function metadataFor(metadataUrl, generationId) {
  const key = `${metadataUrl}|${generationId}`;
  if (!metadataCache.has(key)) {
    metadataCache.set(key, fetch(metadataUrl, { cache: 'no-store' }).then(async (response) => {
      const metadata = await response.json();
      fail(metadata.generation_id === generationId, 'metadata generation changed before provider residency could begin.');
      return metadata;
    }));
  }
  return metadataCache.get(key);
}

function sharedTileCacheState(cache = null) {
  return cache || { entries: new Map(), pending: new Map() };
}
function cacheTile(cache, key, payload) {
  cache.entries.delete(key);
  cache.entries.set(key, payload);
}
function validateMetadata(metadata) {
  const tiles = metadata.temporal_tiles;
  fail(tiles?.contract_version === GPU_TEMPORAL_TILE_CONTRACT, 'unsupported or unavailable temporal-tile contract.');
  fail(tiles.tile_interior_source_nodes === 128 && tiles.rain_halo_source_nodes >= 1, 'invalid temporal-tile geometry.');
  fail(tiles.rain_frame_count === undefined || tiles.rain_frame_count === metadata.time.count, 'rain frame count mismatch.');
}

function revisionKey(required) { return required.join(','); }
function revisionBytes(revision, metadata) {
  return {
    rain: revision.rainW * revision.rainH * metadata.time.count * 2,
    motion: revision.motionW * revision.motionH * metadata.motion.interval_count * 16,
    lookup: (revision.count || 1) * 4 * 2 * 4
  };
}

export class GpuWeatherProviderResidency {
  static async create({ metadataUrl, generationId, sequence, gl: suppliedGl = null, sharedTileCache = null }) {
    const metadata = await metadataFor(metadataUrl, generationId);
    validateMetadata(metadata);
    const surface = suppliedGl ? null : document.createElement('canvas');
    const gl = suppliedGl || surface.getContext('webgl2', { antialias: false, depth: false, stencil: false });
    if (!gl) throw new Error('WebGL2 context is unavailable for provider residency.');
    return new GpuWeatherProviderResidency(gl, metadataUrl, metadata, sequence, sharedTileCache);
  }

  constructor(gl, metadataUrl, metadata, sequence, sharedTileCache = null) {
    validateMetadata(metadata);
    this.gl = gl;
    this.metadataUrl = metadataUrl;
    this.metadata = metadata;
    this.sequence = sequence;
    this.tiles = new Map(metadata.temporal_tiles.tiles.map((tile) => [tile.id, tile]));
    this.sharedTileCache = sharedTileCacheState(sharedTileCache);
    this.ownsSharedTileCache = !sharedTileCache;
    this.requestGeneration = 0;
    this.pendingBuild = null;
    this.currentRevision = null;
    this.revisions = new Set();
    this.nextRevisionId = 0;
    this.referenceCount = 1; // Explicit creator/owner reference.
    this.destroyed = false;
    this.stats = {
      tileNetworkRequestCount: 0,
      reusedTileCount: 0,
      newlyFetchedTileCount: 0,
      fetchedRainBytes: 0,
      fetchedMotionBytes: 0,
      staleLoads: 0,
      rainUploads: 0,
      rainUploadedBytes: 0,
      motionUploads: 0,
      motionUploadedBytes: 0,
      latestTextureArrayAllocationMs: 0,
      latestTileUploadSubmissionMs: 0,
      latestResidencyPublicationMs: 0,
      residencyBuildCount: 0,
      latestResidencyDestroyMs: 0,
      latestDestroyMs: 0,
      latestDestroyTimings: null
    };
  }

  retain() {
    fail(!this.destroyed, 'cannot retain destroyed provider residency.');
    this.referenceCount += 1;
    return this;
  }

  release() {
    if (this.destroyed) return false;
    this.referenceCount = Math.max(0, this.referenceCount - 1);
    if (this.referenceCount === 0) this.destroy();
    return true;
  }

  requiredTileIdsFor(levelData, geometry = null, procedural = false) {
    if (procedural) {
      const range = sourceTileRangeForWindow(levelData, this.sequence, 128);
      const ids = [];
      for (let tileY = range.minTileY; tileY <= range.maxTileY; tileY++) {
        for (let tileX = range.minTileX; tileX <= range.maxTileX; tileX++) ids.push(`${tileX},${tileY}`);
      }
      return ids;
    }
    fail(geometry, 'CPU canonical geometry is required for legacy provider residency.');
    const ids = new Set();
    for (let index = 0; index < geometry.count; index++) {
      const column = index % geometry.width;
      const row = (index - column) / geometry.width;
      const point = geometry.kind === 'compact-rectangular'
        ? [geometry.sourceColumn[column] + geometry.longitudeFraction[column], geometry.sourceRowBase[row] / geometry.sourceWidth + geometry.latitudeFraction[row]]
        : [geometry.baseIndex[index] % geometry.sourceWidth + geometry.longitudeFraction[index], Math.floor(geometry.baseIndex[index] / geometry.sourceWidth) + geometry.latitudeFraction[index]];
      ids.add(`${Math.floor(point[0] / 128)},${Math.floor(point[1] / 128)}`);
    }
    return [...ids];
  }

  async loadTilePayload(tile) {
    const key = `${this.metadata.generation_id}|${tile.id}`;
    const cached = this.sharedTileCache.entries.get(key);
    if (cached) {
      this.sharedTileCache.entries.delete(key);
      this.sharedTileCache.entries.set(key, cached);
      this.stats.reusedTileCount += 1;
      return cached;
    }
    let pending = this.sharedTileCache.pending.get(key);
    if (!pending) {
      pending = Promise.all([
        fetch(assetUrl(this.metadataUrl, tile.rain.asset)),
        fetch(assetUrl(this.metadataUrl, tile.motion.asset))
      ]).then(async ([rainResponse, motionResponse]) => {
        this.stats.tileNetworkRequestCount += 2;
        const [rainBuffer, motionBuffer] = await Promise.all([rainResponse.arrayBuffer(), motionResponse.arrayBuffer()]);
        fail(rainBuffer.byteLength === tile.rain.byte_length, `rain byte length for ${tile.id}`);
        fail(motionBuffer.byteLength === tile.motion.byte_length, `motion byte length for ${tile.id}`);
        const payload = { rain: new Uint16Array(rainBuffer), motion: new Float32Array(motionBuffer) };
        if (this.destroyed) return payload;
        this.stats.newlyFetchedTileCount += 1;
        this.stats.fetchedRainBytes += rainBuffer.byteLength;
        this.stats.fetchedMotionBytes += motionBuffer.byteLength;
        cacheTile(this.sharedTileCache, key, payload);
        return payload;
      }).finally(() => { this.sharedTileCache.pending.delete(key); });
      this.sharedTileCache.pending.set(key, pending);
    } else this.stats.reusedTileCount += 1;
    const payload = await pending;
    if (!this.destroyed && !this.sharedTileCache.entries.has(key)) cacheTile(this.sharedTileCache, key, payload);
    return payload;
  }

  async acquire(requiredTileIds) {
    fail(!this.destroyed, 'cannot acquire from destroyed provider residency.');
    const required = [...requiredTileIds];
    const key = revisionKey(required);
    if (this.currentRevision?.key === key && !this.currentRevision.destroyed) return this.retainRevision(this.currentRevision);
    if (this.pendingBuild?.key === key) {
      const revision = await this.pendingBuild.promise;
      return revision ? this.retainRevision(revision) : null;
    }
    const generation = ++this.requestGeneration;
    const started = timingNow();
    const build = (async () => {
      const emitted = required.map((id) => this.tiles.get(id)).filter(Boolean);
      const payload = await Promise.all(emitted.map(async (tile) => ({ tile, ...(await this.loadTilePayload(tile)) })));
      if (generation !== this.requestGeneration || this.destroyed) {
        this.stats.staleLoads += 1;
        return null;
      }
      const revision = this.buildRevision(required, emitted, payload);
      revision.asyncWaitMs = timingNow() - started;
      const publicationStarted = timingNow();
      this.activateRevision(revision);
      this.stats.latestResidencyPublicationMs = timingNow() - publicationStarted;
      return revision;
    })();
    this.pendingBuild = { generation, key, promise: build };
    try {
      const revision = await build;
      return revision ? this.retainRevision(revision) : null;
    } finally {
      if (this.pendingBuild?.promise === build) this.pendingBuild = null;
    }
  }

  buildRevision(required, emitted, payload) {
    const gl = this.gl;
    const key = revisionKey(required);
    const maxRainW = Math.max(2, ...emitted.map((tile) => tile.rain.stored_width));
    const maxRainH = Math.max(2, ...emitted.map((tile) => tile.rain.stored_height));
    const maxMotionW = Math.max(2, ...emitted.map((tile) => tile.motion.grid_width));
    const maxMotionH = Math.max(2, ...emitted.map((tile) => tile.motion.grid_height));
    const count = emitted.length;
    const cols = Math.ceil(Math.sqrt(Math.max(1, count)));
    const rows = Math.ceil(Math.max(1, count) / cols);
    const rainW = cols * maxRainW;
    const rainH = rows * maxRainH;
    const motionW = cols * maxMotionW;
    const motionH = rows * maxMotionH;
    fail(rainW <= gl.getParameter(gl.MAX_TEXTURE_SIZE) && rainH <= gl.getParameter(gl.MAX_TEXTURE_SIZE), 'rain atlas exceeds MAX_TEXTURE_SIZE.');
    fail(Math.max(this.metadata.time.count, this.metadata.motion.interval_count) <= gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS), 'temporal array depth exceeds MAX_ARRAY_TEXTURE_LAYERS.');
    const textureArrayStarted = timingNow();
    const rain = texArray(gl, gl.R16F, rainW, rainH, this.metadata.time.count, gl.RED, gl.HALF_FLOAT);
    const motion = texArray(gl, gl.RGBA32F, motionW, motionH, this.metadata.motion.interval_count, gl.RGBA, gl.FLOAT);
    this.stats.latestTextureArrayAllocationMs = timingNow() - textureArrayStarted;
    const info = new Float32Array(Math.max(1, count) * 4);
    const motionInfo = new Float32Array(Math.max(1, count) * 4);
    const slots = new Map();
    const uploadValidation = { rainCalls: 0, motionCalls: 0, rainBytes: 0, motionBytes: 0, last: null, restoredPixelStore: null };
    const uploadStarted = timingNow();
    let infoTexture = null;
    let motionInfoTexture = null;
    this.stats.residencyBuildCount += 1;
    try {
      withTightlyPackedUploads(gl, (previous) => {
        uploadValidation.restoredPixelStore = previous;
        payload.forEach(({ tile, rain: rainPayload, motion: motionPayload }, slot) => {
          slots.set(tile.id, slot);
          info.set([tile.rain.stored_x_start, tile.rain.stored_y_start, tile.rain.stored_width, tile.rain.stored_height], slot * 4);
          motionInfo.set([tile.motion.grid_x_start, tile.motion.grid_y_start, tile.motion.grid_width, tile.motion.grid_height], slot * 4);
          const rainWidth = tile.rain.stored_width;
          const rainHeight = tile.rain.stored_height;
          const rainPlane = rainWidth * rainHeight;
          fail(rainPayload.length === this.metadata.time.count * rainPlane, `rain source element count for ${tile.id}`);
          const ox = (slot % cols) * maxRainW;
          const oy = Math.floor(slot / cols) * maxRainH;
          for (let time = 0; time < this.metadata.time.count; time++) {
            const source = rainPayload.subarray(time * rainPlane, (time + 1) * rainPlane);
            uploadValidation.rainCalls += 1;
            uploadValidation.rainBytes += source.byteLength;
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, rain);
            gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, ox, oy, time, rainWidth, rainHeight, 1, gl.RED, gl.HALF_FLOAT, source);
            this.stats.rainUploads += 1;
            this.stats.rainUploadedBytes += source.byteLength;
          }
          const motionWidth = tile.motion.grid_width;
          const motionHeight = tile.motion.grid_height;
          const motionNodes = motionWidth * motionHeight;
          fail(motionPayload.length === this.metadata.motion.interval_count * motionNodes * 4, `motion source element count for ${tile.id}`);
          const mx = (slot % cols) * maxMotionW;
          const my = Math.floor(slot / cols) * maxMotionH;
          for (let time = 0; time < this.metadata.motion.interval_count; time++) {
            const source = motionPayload.subarray(time * 4 * motionNodes, (time + 1) * 4 * motionNodes);
            const packed = new Float32Array(motionNodes * 4);
            for (let index = 0; index < motionNodes; index++) packed.set([source[index], source[motionNodes + index], source[2 * motionNodes + index], source[3 * motionNodes + index]], index * 4);
            uploadValidation.motionCalls += 1;
            uploadValidation.motionBytes += packed.byteLength;
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, motion);
            gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, mx, my, time, motionWidth, motionHeight, 1, gl.RGBA, gl.FLOAT, packed);
            this.stats.motionUploads += 1;
            this.stats.motionUploadedBytes += packed.byteLength;
          }
        });
      });
      uploadValidation.restoredPixelStoreAfter = pixelStoreState(gl);
      uploadValidation.pixelStoreRestored = true;
      infoTexture = tex2(gl, gl.RGBA32F, Math.max(1, count), 1, gl.RGBA, gl.FLOAT, info);
      motionInfoTexture = tex2(gl, gl.RGBA32F, Math.max(1, count), 1, gl.RGBA, gl.FLOAT, motionInfo);
      const revision = {
        id: ++this.nextRevisionId,
        key,
        required,
        emitted: emitted.map((tile) => tile.id),
        count,
        cols,
        rainW,
        rainH,
        maxRainW,
        maxRainH,
        motionW,
        motionH,
        maxMotionW,
        maxMotionH,
        slots,
        rain,
        motion,
        info: infoTexture,
        motionInfo: motionInfoTexture,
        refs: 1, // Provider's current-revision reference.
        destroyed: false,
        uploadValidation
      };
      this.revisions.add(revision);
      this.stats.latestTileUploadSubmissionMs = timingNow() - uploadStarted;
      return revision;
    } catch (error) {
      deleteOwnedTexture(gl, rain);
      deleteOwnedTexture(gl, motion);
      deleteOwnedTexture(gl, infoTexture);
      deleteOwnedTexture(gl, motionInfoTexture);
      throw error;
    }
  }

  activateRevision(revision) {
    const previous = this.currentRevision;
    if (previous === revision) return;
    this.currentRevision = revision;
    if (previous) {
      previous.refs -= 1;
      if (previous.refs <= 0) this.destroyRevision(previous);
    }
  }

  retainRevision(revision) {
    fail(!revision.destroyed, 'cannot retain destroyed provider revision.');
    revision.refs += 1;
    const handle = {
      provider: this,
      revision,
      revisionId: revision.id,
      key: revision.key,
      required: revision.required,
      emitted: revision.emitted,
      count: revision.count,
      cols: revision.cols,
      rainW: revision.rainW,
      rainH: revision.rainH,
      maxRainW: revision.maxRainW,
      maxRainH: revision.maxRainH,
      motionW: revision.motionW,
      motionH: revision.motionH,
      maxMotionW: revision.maxMotionW,
      maxMotionH: revision.maxMotionH,
      slots: revision.slots,
      rain: revision.rain,
      motion: revision.motion,
      info: revision.info,
      motionInfo: revision.motionInfo,
      uploadValidation: revision.uploadValidation,
      released: false,
      release: () => {
        if (handle.released || revision.destroyed) return false;
        handle.released = true;
        return this.releaseRevision(revision);
      }
    };
    return handle;
  }

  releaseRevision(revision) {
    revision.refs = Math.max(0, revision.refs - 1);
    if (revision.refs === 0) {
      this.destroyRevision(revision);
      return true;
    }
    return false;
  }

  destroyRevision(revision) {
    if (!revision || revision.destroyed) return null;
    const started = timingNow();
    let bindingCleanupMs = 0;
    let textureDeletionMs = 0;
    for (const texture of [revision.rain, revision.motion, revision.info, revision.motionInfo]) {
      const result = deleteOwnedTexture(this.gl, texture);
      if (result) {
        bindingCleanupMs += result.bindingCleanupMs;
        textureDeletionMs += result.deletionMs;
      }
    }
    revision.destroyed = true;
    this.revisions.delete(revision);
    if (this.currentRevision === revision) this.currentRevision = null;
    const timings = { bindingCleanupMs, textureDeletionMs, totalMs: timingNow() - started };
    this.stats.latestResidencyDestroyMs = timings.totalMs;
    return timings;
  }

  diagnostics(handle = null) {
    const revision = handle?.revision || this.currentRevision;
    const bytes = revision ? revisionBytes(revision, this.metadata) : { rain: 0, motion: 0, lookup: 0 };
    return {
      active: Boolean(revision && !revision.destroyed),
      generationId: this.metadata.generation_id,
      contractVersion: GPU_TEMPORAL_TILE_CONTRACT,
      providerRevisionId: revision?.id ?? null,
      providerOwnerCount: this.referenceCount,
      providerRevisionCount: this.revisions.size,
      requiredGeometricTileCount: revision?.required.length || 0,
      residentTileCount: revision?.count || 0,
      safelyOmittedTileCount: (revision?.required.length || 0) - (revision?.count || 0),
      residentTileIds: revision?.emitted || [],
      residentRainSourceBytes: revision ? revision.emitted.reduce((sum, id) => sum + this.tiles.get(id).rain.byte_length, 0) : 0,
      residentMotionSourceBytes: revision ? revision.emitted.reduce((sum, id) => sum + this.tiles.get(id).motion.byte_length, 0) : 0,
      temporalSourceGpuByteEstimate: bytes.rain + bytes.motion,
      providerGpuRainBytes: bytes.rain,
      providerGpuMotionBytes: bytes.motion,
      providerLookupInfoGpuBytes: bytes.lookup,
      totalProviderGpuBytes: bytes.rain + bytes.motion + bytes.lookup,
      atlas: revision && {
        rain: [revision.rainW, revision.rainH, revision.maxRainW, revision.maxRainH],
        motion: [revision.motionW, revision.motionH, revision.maxMotionW, revision.maxMotionH]
      },
      uploads: { ...this.stats },
      tileCacheEntryCount: this.sharedTileCache.entries.size,
      capabilities: {
        maxTextureSize: this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE),
        maxArrayTextureLayers: this.gl.getParameter(this.gl.MAX_ARRAY_TEXTURE_LAYERS)
      }
    };
  }

  trimPayloadCache(keepTileIds = []) {
    const keep = new Set(keepTileIds.map((id) => `${this.metadata.generation_id}|${id}`));
    for (const key of this.sharedTileCache.entries.keys()) if (!keep.has(key)) this.sharedTileCache.entries.delete(key);
  }

  destroy() {
    if (this.destroyed) return this.stats.latestDestroyTimings;
    const started = timingNow();
    this.requestGeneration += 1;
    const revisions = [...this.revisions];
    let bindingCleanupMs = 0;
    let textureDeletionMs = 0;
    for (const revision of revisions) {
      const timings = this.destroyRevision(revision);
      if (timings) {
        bindingCleanupMs += timings.bindingCleanupMs;
        textureDeletionMs += timings.textureDeletionMs;
      }
    }
    this.currentRevision = null;
    if (this.ownsSharedTileCache) this.sharedTileCache.entries.clear();
    this.destroyed = true;
    this.referenceCount = 0;
    this.stats.latestDestroyTimings = { bindingCleanupMs, textureDeletionMs, totalMs: timingNow() - started };
    this.stats.latestDestroyMs = this.stats.latestDestroyTimings.totalMs;
    return this.stats.latestDestroyTimings;
  }
}
