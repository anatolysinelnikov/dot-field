// Reconstruction-target executor for the temporal-tile GPU path.
// Provider payloads, atlas textures, lookup textures, and slot assignments are
// owned by GpuWeatherProviderResidency. This object owns only target geometry,
// target indirection, physical A/B outputs, and reconstruction execution.

import {
  deleteOwnedTexture,
  GPU_TEMPORAL_TILE_CONTRACT,
  GpuWeatherProviderResidency
} from './gpu-weather-provider-residency.js';
import { sourceTileRangeForWindow } from './gpu-weather-spatial.js';

const VERTEX_SOURCE = `#version 300 es
in vec2 a; void main(){gl_Position=vec4(a,0,1);}`;
const FRAGMENT_SOURCE = `#version 300 es
precision highp float; precision highp sampler2DArray;
uniform sampler2D u_pos,u_tile,u_tileGrid,u_info,u_motionInfo; uniform sampler2DArray u_rain,u_motion;
uniform vec2 u_source,u_motionSize,u_rainAtlas,u_motionAtlas,u_rainSlot,u_motionSlot;
uniform vec2 u_sourceAxisStart,u_sourceAxisSpacing,u_tileGridOrigin,u_tileGridSize;
uniform float u_spacing,u_canonicalSpacing,u_progress; uniform int u_interval,u_endpoint,u_procedural;
uniform ivec2 u_canonicalMin;
out float outRain;
vec4 info(float slot){return texelFetch(u_info,ivec2(int(slot),0),0);}
float regularAxisPosition(float value,float start,float spacing,float count){float last=start+(count-1.)*spacing;if(value<=start)return 0.;if(value>=last)return count-1.;return (value-start)/spacing;}
vec2 proceduralSourcePosition(){ivec2 at=ivec2(gl_FragCoord.xy);vec2 mercator=(vec2(u_canonicalMin)+vec2(at))*u_canonicalSpacing;float longitude=mercator.x*360.-180.;float latitude=atan(sinh(3.141592653589793*(1.-2.*mercator.y)))*180./3.141592653589793;return vec2(regularAxisPosition(longitude,u_sourceAxisStart.x,u_sourceAxisSpacing.x,u_source.x),regularAxisPosition(latitude,u_sourceAxisStart.y,u_sourceAxisSpacing.y,u_source.y));}
float proceduralTileSlot(vec2 p){ivec2 tile=ivec2(floor(p/128.));ivec2 local=tile-ivec2(u_tileGridOrigin);if(local.x<0||local.y<0||local.x>=int(u_tileGridSize.x)||local.y>=int(u_tileGridSize.y))return -1.;return texelFetch(u_tileGrid,local,0).r;}
float rainAt(int layer,vec2 p,float slot,out bool ok){if(slot<0.){ok=false;return 0.;}vec4 i=info(slot);vec2 q=p-i.xy;ok=q.x>=0.&&q.y>=0.&&q.x<=i.z-1.&&q.y<=i.w-1.;if(!ok)return 0.;int s=int(slot);ivec2 o=ivec2((s*int(u_rainSlot.x))%int(u_rainAtlas.x),(s*int(u_rainSlot.x))/int(u_rainAtlas.x)*int(u_rainSlot.y));vec2 b=min(floor(q),i.zw-2.);vec2 f=q-b;ivec2 p0=o+ivec2(b);float a=texelFetch(u_rain,ivec3(p0,layer),0).r,bv=texelFetch(u_rain,ivec3(p0+ivec2(1,0),layer),0).r,c=texelFetch(u_rain,ivec3(p0+ivec2(0,1),layer),0).r,d=texelFetch(u_rain,ivec3(p0+ivec2(1),layer),0).r;return mix(mix(a,bv,f.x),mix(c,d,f.x),f.y);}
vec4 motionAt(vec2 p,float slot){vec4 i=texelFetch(u_motionInfo,ivec2(int(slot),0),0);vec2 q=p/u_spacing-i.xy;q=clamp(q,vec2(0),i.zw-2.);int s=int(slot);ivec2 o=ivec2((s*int(u_motionSlot.x))%int(u_motionAtlas.x),(s*int(u_motionSlot.x))/int(u_motionAtlas.x)*int(u_motionSlot.y));vec2 b=floor(q),f=q-b;ivec2 p0=o+ivec2(b);vec4 a=texelFetch(u_motion,ivec3(p0,u_interval),0),bv=texelFetch(u_motion,ivec3(p0+ivec2(1,0),u_interval),0),c=texelFetch(u_motion,ivec3(p0+ivec2(0,1),u_interval),0),d=texelFetch(u_motion,ivec3(p0+ivec2(1),u_interval),0);return mix(mix(a,bv,f.x),mix(c,d,f.x),f.y);}
void main(){ivec2 at=ivec2(gl_FragCoord.xy);vec2 p=u_procedural==1?proceduralSourcePosition():texelFetch(u_pos,at,0).rg;float slot=u_procedural==1?proceduralTileSlot(p):texelFetch(u_tile,at,0).r;bool a,b;if(slot<0.){outRain=0.;return;}if(u_endpoint>=0){outRain=rainAt(u_endpoint,p,slot,a);return;}vec4 m=motionAt(p,slot);float x=rainAt(u_interval,p-u_progress*m.rg,slot,a),y=rainAt(u_interval+1,p-(1.-u_progress)*m.ba,slot,b);outRain=a?(b?mix(x,y,u_progress):x):(b?y:0.);}`;
const COPY_FRAGMENT_SOURCE = `#version 300 es
precision highp float; precision highp sampler2D;
uniform sampler2D u_source; out vec4 outColor;
void main(){uint bits=floatBitsToUint(texelFetch(u_source,ivec2(gl_FragCoord.xy),0).r);outColor=vec4(float(bits&255u),float((bits>>8)&255u),float((bits>>16)&255u),float((bits>>24)&255u))/255.0;}`;

function fail(ok, message) { if (!ok) throw new Error(`GPU temporal tiles: ${message}`); }
function shader(gl, type, source) { const value = gl.createShader(type); gl.shaderSource(value, source); gl.compileShader(value); fail(gl.getShaderParameter(value, gl.COMPILE_STATUS), gl.getShaderInfoLog(value)); return value; }
function program(gl, source = FRAGMENT_SOURCE) { const value = gl.createProgram(); gl.attachShader(value, shader(gl, gl.VERTEX_SHADER, VERTEX_SOURCE)); gl.attachShader(value, shader(gl, gl.FRAGMENT_SHADER, source)); gl.bindAttribLocation(value, 0, 'a'); gl.linkProgram(value); fail(gl.getProgramParameter(value, gl.LINK_STATUS), gl.getProgramInfoLog(value)); return value; }
function tex2(gl, internal, width, height, format, type, data = null) { const value = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, value); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, data); return value; }
function positions(geometry) { const result = new Float32Array(geometry.count * 2); for (let index = 0; index < geometry.count; index++) { const column = index % geometry.width; const row = (index - column) / geometry.width; if (geometry.kind === 'compact-rectangular') { result[index * 2] = geometry.sourceColumn[column] + geometry.longitudeFraction[column]; result[index * 2 + 1] = geometry.sourceRowBase[row] / geometry.sourceWidth + geometry.latitudeFraction[row]; } else { const base = geometry.baseIndex[index]; result[index * 2] = base % geometry.sourceWidth + geometry.longitudeFraction[index]; result[index * 2 + 1] = Math.floor(base / geometry.sourceWidth) + geometry.latitudeFraction[index]; } } return result; }
function geometryByteLength(geometry) { if (!geometry) return 0; const seen = new Set(); return [geometry.baseIndex, geometry.longitudeFraction, geometry.latitudeFraction, geometry.sourceColumn, geometry.sourceRowBase, geometry.potentialActiveIndices, geometry.temporalRainMmh, geometry.motionIntervalState?.sourceX, geometry.motionIntervalState?.sourceY, geometry.motionIntervalState?.forwardX, geometry.motionIntervalState?.forwardY, geometry.motionIntervalState?.backwardX, geometry.motionIntervalState?.backwardY].reduce((total, value) => { if (!ArrayBuffer.isView(value) || seen.has(value.buffer)) return total; seen.add(value.buffer); return total + value.buffer.byteLength; }, 0); }
function tileGridForRange(range, revision) { const width = Math.max(1, range.maxTileX - range.minTileX + 1); const height = Math.max(1, range.maxTileY - range.minTileY + 1); const values = new Float32Array(width * height); values.fill(-1); for (let tileY = range.minTileY; tileY <= range.maxTileY; tileY++) for (let tileX = range.minTileX; tileX <= range.maxTileX; tileX++) { const slot = revision.slots.get(`${tileX},${tileY}`); if (slot !== undefined) values[(tileY - range.minTileY) * width + tileX - range.minTileX] = slot; } return { values, width, height, originX: range.minTileX, originY: range.minTileY }; }
function timingNow() { return globalThis.performance?.now?.() ?? Date.now(); }
function cleanupTargetConstruction(target) {
  const gl = target.gl;
  for (const texture of [target.pos, ...(target.outputs || []), target.validationTexture]) deleteOwnedTexture(gl, texture);
  for (const framebuffer of [...(target.fbos || []), target.validationFbo]) if (framebuffer) gl.deleteFramebuffer(framebuffer);
  for (const value of [target.program, target.copyProgram]) if (value) gl.deleteProgram(value);
  if (target.vao) gl.deleteVertexArray(target.vao);
}

export class GpuTemporalTileReconstructor {
  static async create({ metadataUrl, generationId, geometry = null, levelData = null, sequence, procedural = false, gl: suppliedGl = null, sharedTileCache = null, provider = null }) {
    const ownsProvider = !provider;
    const providerOwner = provider || await GpuWeatherProviderResidency.create({ metadataUrl, generationId, sequence, gl: suppliedGl, sharedTileCache });
    if (suppliedGl && providerOwner.gl !== suppliedGl) {
      if (ownsProvider) providerOwner.release();
      throw new Error('GPU temporal target and provider residency must use the same WebGL context.');
    }
    const gl = suppliedGl || providerOwner.gl;
    if (!gl || !gl.getExtension('EXT_color_buffer_float')) {
      if (ownsProvider) providerOwner.release();
      throw new Error('WebGL2 R16F render targets are unavailable.');
    }
    try {
      const target = new GpuTemporalTileReconstructor(gl, metadataUrl, providerOwner.metadata, geometry, levelData, sequence, procedural, providerOwner);
      if (ownsProvider) providerOwner.release();
      return target;
    } catch (error) {
      if (ownsProvider) providerOwner.release();
      throw error;
    }
  }

  constructor(gl, metadataUrl, metadata, geometry, levelData, sequence, procedural = false, provider = null) {
    const constructionStarted = timingNow();
    this.gl = gl; this.metadataUrl = metadataUrl; this.metadata = metadata; this.sequence = sequence; this.geometry = geometry; this.levelData = levelData; this.procedural = Boolean(procedural);
    this.provider = provider;
    fail(this.provider, 'a provider residency owner is required.');
    fail(!this.procedural || levelData?.level === 13 || levelData?.level === 14, 'procedural temporal reconstruction requires direct stable L13 or L14 support data.');
    fail(this.procedural || geometry, 'CPU canonical geometry is required for the legacy tiled path.');
    this.width = this.procedural ? levelData.width : geometry.width; this.height = this.procedural ? levelData.height : geometry.height;
    this.requestGeneration = 0; this.providerRevision = null; this.requiredTileIds = null; this.residentKey = null; this.destroyed = false;
    this.stats = { staleLoads: 0, drawCount: 0, latestGpuError: 0, latestMainThreadSubmissionMs: 0, constructorMs: 0, latestSpatialAsyncWaitMs: 0, latestSpatialSynchronousMs: 0, latestResidencyPublicationMs: 0, latestResidencyDestroyMs: 0, latestDestroyMs: 0, latestDestroyTimings: null };
    try {
      this.program = program(gl); this.copyProgram = program(gl, COPY_FRAGMENT_SOURCE); this.timerExtension = gl.getExtension('EXT_disjoint_timer_query_webgl2'); this.pendingQueries = [];
      this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao); const quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      this.pos = this.procedural ? null : tex2(gl, gl.RG32F, this.width, this.height, gl.RG, gl.FLOAT, positions(geometry)); this.tileIndex = null; this.tileGrid = null;
      this.outputs = [tex2(gl, gl.R16F, this.width, this.height, gl.RED, gl.HALF_FLOAT), tex2(gl, gl.R16F, this.width, this.height, gl.RED, gl.HALF_FLOAT)]; this.output = this.outputs[0]; this.fbos = [gl.createFramebuffer(), gl.createFramebuffer()];
      for (let index = 0; index < 2; index++) { gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[index]); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outputs[index], 0); fail(gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE, 'R16F framebuffer is incomplete.'); }
      this.loc = Object.fromEntries(['u_pos', 'u_tile', 'u_tileGrid', 'u_info', 'u_motionInfo', 'u_rain', 'u_motion', 'u_source', 'u_motionSize', 'u_rainAtlas', 'u_motionAtlas', 'u_rainSlot', 'u_motionSlot', 'u_sourceAxisStart', 'u_sourceAxisSpacing', 'u_tileGridOrigin', 'u_tileGridSize', 'u_spacing', 'u_canonicalSpacing', 'u_progress', 'u_interval', 'u_endpoint', 'u_procedural', 'u_canonicalMin'].map((name) => [name, gl.getUniformLocation(this.program, name)])); this.copySource = gl.getUniformLocation(this.copyProgram, 'u_source'); this.provider = provider.retain(); this.stats.constructorMs = timingNow() - constructionStarted;
    } catch (error) {
      cleanupTargetConstruction(this);
      throw error;
    }
  }

  required() { if (this.requiredTileIds) return this.requiredTileIds; this.requiredTileIds = this.provider.requiredTileIdsFor(this.levelData, this.geometry, this.procedural); return this.requiredTileIds; }

  destroyTargetResidency() {
    const started = timingNow(); let bindingCleanupMs = 0; let textureDeletionMs = 0;
    for (const texture of [this.tileIndex, this.tileGrid]) { const result = deleteOwnedTexture(this.gl, texture); if (result) { bindingCleanupMs += result.bindingCleanupMs; textureDeletionMs += result.deletionMs; } }
    this.tileIndex = this.tileGrid = null; this.tileGridMetadata = null; this.layout = null; this.residentKey = null;
    if (this.providerRevision) this.providerRevision.release(); this.providerRevision = null;
    const result = { bindingCleanupMs, textureDeletionMs, totalMs: timingNow() - started }; this.stats.latestResidencyDestroyMs = result.totalMs; return result;
  }

  async ensureResident() {
    fail(!this.destroyed, 'target is destroyed.'); const required = this.required(); const generation = ++this.requestGeneration; const start = timingNow();
    if (this.residentKey === required.join(',') && this.layout) { this.stats.latestSpatialAsyncWaitMs = 0; this.stats.latestSpatialSynchronousMs = 0; return this.diagnostics(); }
    const revision = await this.provider.acquire(required);
    if (!revision || generation !== this.requestGeneration || this.destroyed) { if (revision) revision.release(); this.stats.staleLoads += 1; return null; }
    const afterAsyncWait = timingNow(); this.stats.latestSpatialAsyncWaitMs = afterAsyncWait - start; this.destroyTargetResidency(); this.providerRevision = revision;
    try {
      if (this.procedural) { const grid = tileGridForRange(sourceTileRangeForWindow(this.levelData, this.sequence, 128), revision); this.tileGrid = tex2(this.gl, this.gl.R32F, grid.width, grid.height, this.gl.RED, this.gl.FLOAT, grid.values); this.tileGridMetadata = grid; }
      else { const tileIndex = new Float32Array(this.geometry.count); tileIndex.fill(-1); const canonicalPositions = positions(this.geometry); for (let index = 0; index < this.geometry.count; index++) { const point = canonicalPositions.subarray(index * 2, index * 2 + 2); const slot = revision.slots.get(`${Math.floor(point[0] / 128)},${Math.floor(point[1] / 128)}`); if (slot !== undefined) tileIndex[index] = slot; } this.tileIndex = tex2(this.gl, this.gl.R32F, this.width, this.height, this.gl.RED, this.gl.FLOAT, tileIndex); }
    } catch (error) {
      deleteOwnedTexture(this.gl, this.tileIndex); deleteOwnedTexture(this.gl, this.tileGrid); this.tileIndex = this.tileGrid = null; revision.release(); throw error;
    }
    this.layout = revision; this.residentKey = required.join(','); this.stats.latestSpatialSynchronousMs = timingNow() - afterAsyncWait; this.stats.latestResidencyPublicationMs = timingNow() - afterAsyncWait; return this.diagnostics();
  }

  update(frame, { measureGpu = false, targetSlot = 0 } = {}) {
    fail(this.layout && this.providerRevision, 'spatial residency is not ready.'); if (targetSlot !== 0 && targetSlot !== 1) throw new RangeError('GPU temporal tile target slot must be 0 or 1.'); const gl = this.gl; const provider = this.providerRevision; const endpoint = frame.progress === 0 || frame.frame0 === frame.frame1; const framebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING); const viewport = gl.getParameter(gl.VIEWPORT); const vao = gl.getParameter(gl.VERTEX_ARRAY_BINDING); this.output = this.outputs[targetSlot];
    try { gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[targetSlot]); gl.viewport(0, 0, this.width, this.height); gl.disable(gl.BLEND); gl.colorMask(true, true, true, true); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.STENCIL_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.POLYGON_OFFSET_FILL); gl.useProgram(this.program); gl.bindVertexArray(this.vao); const bind = (unit, texture, location, target) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(target, texture); gl.uniform1i(location, unit); }; bind(0, this.pos, this.loc.u_pos, gl.TEXTURE_2D); bind(1, this.tileIndex, this.loc.u_tile, gl.TEXTURE_2D); bind(2, this.tileGrid, this.loc.u_tileGrid, gl.TEXTURE_2D); bind(3, provider.rain, this.loc.u_rain, gl.TEXTURE_2D_ARRAY); bind(4, provider.motion, this.loc.u_motion, gl.TEXTURE_2D_ARRAY); bind(5, provider.info, this.loc.u_info, gl.TEXTURE_2D); bind(6, provider.motionInfo, this.loc.u_motionInfo, gl.TEXTURE_2D); gl.uniform2f(this.loc.u_source, this.metadata.spatial_grid.width, this.metadata.spatial_grid.height); gl.uniform2f(this.loc.u_motionSize, this.metadata.motion.grid_width, this.metadata.motion.grid_height); gl.uniform2f(this.loc.u_rainAtlas, provider.rainW, provider.rainH); gl.uniform2f(this.loc.u_motionAtlas, provider.motionW, provider.motionH); gl.uniform2f(this.loc.u_rainSlot, provider.maxRainW, provider.maxRainH); gl.uniform2f(this.loc.u_motionSlot, provider.maxMotionW, provider.maxMotionH); gl.uniform1f(this.loc.u_spacing, this.metadata.motion.grid_spacing_source_nodes); gl.uniform1f(this.loc.u_progress, frame.progress); gl.uniform1i(this.loc.u_interval, frame.frame0); gl.uniform1i(this.loc.u_endpoint, endpoint ? frame.frame0 : -1); gl.uniform1i(this.loc.u_procedural, this.procedural ? 1 : 0); if (this.procedural) { gl.uniform2f(this.loc.u_sourceAxisStart, this.sequence.longitudes[0], this.sequence.latitudes[0]); gl.uniform2f(this.loc.u_sourceAxisSpacing, this.sequence.longitudeSpacing, this.sequence.latitudeSpacing); gl.uniform2f(this.loc.u_tileGridOrigin, this.tileGridMetadata.originX, this.tileGridMetadata.originY); gl.uniform2f(this.loc.u_tileGridSize, this.tileGridMetadata.width, this.tileGridMetadata.height); gl.uniform1f(this.loc.u_canonicalSpacing, this.levelData.spacing); gl.uniform2i(this.loc.u_canonicalMin, this.levelData.minI, this.levelData.minJ); } let query = null; if (measureGpu && this.timerExtension) { query = gl.createQuery(); gl.beginQuery(this.timerExtension.TIME_ELAPSED_EXT, query); } gl.drawArrays(gl.TRIANGLES, 0, 3); if (query) { gl.endQuery(this.timerExtension.TIME_ELAPSED_EXT); this.pendingQueries.push(query); } this.stats.drawCount += 1; this.stats.latestGpuError = gl.getError(); this.pollTimerQueries(); return this.diagnostics(); }
    finally { gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer); gl.viewport(...viewport); gl.bindVertexArray(vao); }
  }

  pollTimerQueries() { const gl = this.gl; if (!this.timerExtension || gl.getParameter(this.timerExtension.GPU_DISJOINT_EXT)) return; this.pendingQueries = this.pendingQueries.filter((query) => { if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) return true; this.stats.latestGpuPassMs = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6; gl.deleteQuery(query); return false; }); }
  readback(targetSlot = 0) { const gl = this.gl; const encoded = new Uint8Array(this.width * this.height * 4); if (targetSlot !== 0 && targetSlot !== 1) throw new RangeError('GPU temporal tile target slot must be 0 or 1.'); if (!this.validationTexture) { this.validationTexture = tex2(gl, gl.RGBA8, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE); this.validationFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.validationFbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.validationTexture, 0); fail(gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE, 'RGBA8 validation framebuffer is incomplete.'); } gl.bindFramebuffer(gl.FRAMEBUFFER, this.validationFbo); gl.viewport(0, 0, this.width, this.height); gl.useProgram(this.copyProgram); gl.bindVertexArray(this.vao); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.outputs[targetSlot]); gl.uniform1i(this.copySource, 0); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, encoded); fail(gl.getError() === gl.NO_ERROR, 'validation readback failed.'); const bits = new Uint32Array(this.width * this.height); const values = new Float32Array(bits.buffer); for (let index = 0; index < bits.length; index++) bits[index] = encoded[index * 4] | encoded[index * 4 + 1] << 8 | encoded[index * 4 + 2] << 16 | encoded[index * 4 + 3] << 24; return values; }
  validate(frame, { maximumSamples = 32768, referenceGeometry = null } = {}) { const geometry = this.geometry || referenceGeometry; fail(geometry, 'GPU validation requires a CPU reference sampling geometry.'); fail(geometry.count === this.width * this.height, 'GPU validation geometry dimensions do not match the reconstruction target.'); this.update(frame); const gpu = this.readback(); const active = geometry.potentialActiveIndices || new Uint32Array(this.width * this.height); const stride = Math.max(1, Math.ceil(active.length / maximumSamples)); const sample = frame.prepareTemporalSampling(geometry); let count = 0; let total = 0; let max = 0; const errors = []; for (let index = 0; index < active.length; index += stride) { const error = Math.abs(sample(index) - gpu[active[index]]); errors.push(error); total += error; max = Math.max(max, error); count++; } errors.sort((a, b) => a - b); return { frame0: frame.frame0, frame1: frame.frame1, progress: frame.progress, samples: count, maximumAbsoluteRainErrorMmh: max, meanAbsoluteRainErrorMmh: total / count, p95AbsoluteRainErrorMmh: errors[Math.min(errors.length - 1, Math.ceil(errors.length * 0.95) - 1)] || 0, readbackIncluded: true, referenceGeometryOnly: !this.geometry }; }

  diagnostics() {
    const provider = this.provider.diagnostics(this.providerRevision); const targetAuxiliaryGpuBytes = (this.pos ? this.width * this.height * 8 : 0) + (this.tileIndex ? this.width * this.height * 4 : this.tileGrid ? this.tileGridMetadata.width * this.tileGridMetadata.height * 4 : 0) + (this.validationTexture ? this.width * this.height * 4 : 0); const targetPhysicalOutputBytes = this.outputs ? this.width * this.height * 2 * 2 : 0;
    return { ...provider, active: Boolean(this.layout && provider.active), contractVersion: GPU_TEMPORAL_TILE_CONTRACT, targetId: this.targetId || null, targetRevisionId: this.providerRevision?.revisionId ?? null, canonicalPresentationGeometryGpuByteEstimate: this.procedural ? 0 : this.width * this.height * 12, proceduralGeometryMetadataByteEstimate: this.procedural ? 48 : 0, tileGridMetadataGpuByteEstimate: this.tileGridMetadata ? this.tileGridMetadata.values.byteLength : 0, retainedCpuGeometryBytes: geometryByteLength(this.geometry), releasedCpuGeometryBytes: this.cpuGeometryReleasedBytes || 0, physicalKeyframeByteEstimate: this.width * this.height * 2, physicalKeyframeWorkingSetByteEstimate: this.width * this.height * 4, targetPhysicalOutputBytes, targetAuxiliaryGpuBytes, totalTargetGpuBytes: targetPhysicalOutputBytes + targetAuxiliaryGpuBytes, targetDestroyed: this.destroyed, uploads: { ...provider.uploads, ...this.stats, provider: provider.uploads, target: this.stats }, gpu: { drawCount: this.stats.drawCount, latestPassMs: this.stats.latestGpuPassMs ?? null, pendingTimerQueries: this.pendingQueries.length, latestError: this.stats.latestGpuError }, target: { active: Boolean(this.layout), width: this.width, height: this.height, outputCount: 2, physicalOutputBytes: targetPhysicalOutputBytes, auxiliaryBytes: targetAuxiliaryGpuBytes } };
  }

  // Compatibility name retained for callers of the old combined object. It
  // releases only target-local indirection and the target's revision handle.
  destroyResidency() { return this.destroyTargetResidency(); }
  releaseCpuGeometry() { if (!this.geometry) return 0; const bytes = geometryByteLength(this.geometry); this.geometry.spatialRainCache?.clear?.(); this.geometry = null; this.cpuGeometryReleasedBytes = (this.cpuGeometryReleasedBytes || 0) + bytes; return bytes; }

  destroy() {
    if (this.destroyed) return this.stats.latestDestroyTimings;
    const started = timingNow(); const gl = this.gl; this.destroyed = true; this.requestGeneration += 1; const timerStarted = timingNow(); for (const query of this.pendingQueries) gl.deleteQuery(query); this.pendingQueries = []; const timerRetirementMs = timingNow() - timerStarted; const targetResidency = this.destroyTargetResidency(); let bindingCleanupMs = targetResidency.bindingCleanupMs; let textureDeletionMs = targetResidency.textureDeletionMs;
    for (const texture of [this.pos, ...this.outputs, this.validationTexture]) { const result = deleteOwnedTexture(gl, texture); if (result) { bindingCleanupMs += result.bindingCleanupMs; textureDeletionMs += result.deletionMs; } }
    for (const framebuffer of [...this.fbos, this.validationFbo]) if (framebuffer) gl.deleteFramebuffer(framebuffer); for (const value of [this.program, this.copyProgram]) if (value) gl.deleteProgram(value); if (this.vao) gl.deleteVertexArray(this.vao);
    const providerRelease = this.provider?.release?.() || false; this.provider = null; this.stats.latestDestroyTimings = { bindingCleanupMs, textureDeletionMs, timerRetirementMs, targetResidency, providerRelease, totalMs: timingNow() - started }; this.stats.latestDestroyMs = this.stats.latestDestroyTimings.totalMs; return this.stats.latestDestroyTimings;
  }
}
