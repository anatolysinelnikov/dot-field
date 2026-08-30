// Experimental WebGL2 implementation of the provider-owned rain temporal
// primitive. It deliberately consumes the existing Float32 source/motion
// semantics and does not participate in Dots/Squares presentation yet.

const VERTEX_SOURCE = `#version 300 es
in vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }`;

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_positions;
uniform sampler2D u_rainA;
uniform sampler2D u_rainB;
uniform sampler2D u_motion;
uniform vec2 u_sourceSize;
uniform vec2 u_motionSize;
uniform float u_motionSpacing;
uniform float u_progress;
uniform int u_useMotion;
out float outRain;

float sourceAt(sampler2D source, vec2 p, out bool valid) {
  valid = p.x >= 0.0 && p.y >= 0.0 && p.x <= u_sourceSize.x - 1.0 && p.y <= u_sourceSize.y - 1.0;
  if (!valid) return 0.0;
  vec2 p0 = min(floor(p), u_sourceSize - 2.0);
  vec2 f = p - p0;
  float a = texelFetch(source, ivec2(p0), 0).r;
  float b = texelFetch(source, ivec2(p0) + ivec2(1, 0), 0).r;
  float c = texelFetch(source, ivec2(p0) + ivec2(0, 1), 0).r;
  float d = texelFetch(source, ivec2(p0) + ivec2(1, 1), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

vec4 motionAt(vec2 p) {
  vec2 mp = p / u_motionSpacing;
  vec2 p0 = clamp(floor(mp), vec2(0.0), u_motionSize - 2.0);
  vec2 f = clamp(mp - p0, vec2(0.0), vec2(1.0));
  vec4 a = texelFetch(u_motion, ivec2(p0), 0);
  vec4 b = texelFetch(u_motion, ivec2(p0) + ivec2(1, 0), 0);
  vec4 c = texelFetch(u_motion, ivec2(p0) + ivec2(0, 1), 0);
  vec4 d = texelFetch(u_motion, ivec2(p0) + ivec2(1, 1), 0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  vec2 p = texelFetch(u_positions, ivec2(gl_FragCoord.xy), 0).rg;
  bool validA; bool validB;
  if (u_useMotion == 0 || u_progress == 0.0) {
    outRain = sourceAt(u_rainA, p, validA);
    return;
  }
  vec4 motion = motionAt(p); // RG = forward A->B, BA = backward B->A.
  float fromA = sourceAt(u_rainA, p - u_progress * motion.rg, validA);
  float fromB = sourceAt(u_rainB, p - (1.0 - u_progress) * motion.ba, validB);
  outRain = validA ? (validB ? mix(fromA, fromB, u_progress) : fromA) : (validB ? fromB : 0.0);
}`;

// R16F readPixels is not portable even when R16F rendering is. For explicit
// validation only, preserve the sampled R16F float bit pattern in RGBA8 and
// read that universally-supported attachment instead.
const COPY_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_source;
out vec4 outColor;
void main() {
  uint bits = floatBitsToUint(texelFetch(u_source, ivec2(gl_FragCoord.xy), 0).r);
  outColor = vec4(float(bits & 255u), float((bits >> 8) & 255u), float((bits >> 16) & 255u), float((bits >> 24) & 255u)) / 255.0;
}`;

function assert(condition, message) {
  if (!condition) throw new Error(`GPU motion reconstruction: ${message}`);
}

function shader(gl, type, source) {
  const value = gl.createShader(type);
  gl.shaderSource(value, source);
  gl.compileShader(value);
  if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(value) || 'shader compilation failed');
  return value;
}

function program(gl, fragmentSource = FRAGMENT_SOURCE) {
  const value = gl.createProgram();
  gl.attachShader(value, shader(gl, gl.VERTEX_SHADER, VERTEX_SOURCE));
  gl.attachShader(value, shader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.bindAttribLocation(value, 0, 'a_position');
  gl.linkProgram(value);
  if (!gl.getProgramParameter(value, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(value) || 'program linking failed');
  return value;
}

function texture(gl, internalFormat, width, height, format, type, data = null) {
  const value = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, value);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, data);
  return value;
}

function bytes(width, height, perPixel) { return width * height * perPixel; }

function positionsForGeometry(geometry) {
  const result = new Float32Array(geometry.count * 2);
  for (let index = 0; index < geometry.count; index++) {
    const column = index % geometry.width;
    const row = (index - column) / geometry.width;
    if (geometry.kind === 'compact-rectangular') {
      result[index * 2] = geometry.sourceColumn[column] + geometry.longitudeFraction[column];
      result[index * 2 + 1] = geometry.sourceRowBase[row] / geometry.sourceWidth + geometry.latitudeFraction[row];
    } else {
      const base = geometry.baseIndex[index];
      result[index * 2] = base % geometry.sourceWidth + geometry.longitudeFraction[index];
      result[index * 2 + 1] = Math.floor(base / geometry.sourceWidth) + geometry.latitudeFraction[index];
    }
  }
  return result;
}

function packedMotion(interval, width, height) {
  const nodes = width * height;
  const result = new Float32Array(nodes * 4);
  for (let index = 0; index < nodes; index++) {
    result[index * 4] = interval[index];
    result[index * 4 + 1] = interval[nodes + index];
    result[index * 4 + 2] = interval[nodes * 2 + index];
    result[index * 4 + 3] = interval[nodes * 3 + index];
  }
  return result;
}

function percentile(values, fraction) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * fraction))];
}

export class GpuMotionReconstructor {
  static create({ sequence, geometry, canvas = null } = {}) {
    const surface = canvas || document.createElement('canvas');
    const gl = surface.getContext('webgl2', { antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!gl) return { active: false, reason: 'WebGL2 is unavailable.' };
    if (!gl.getExtension('EXT_color_buffer_float')) return { active: false, reason: 'EXT_color_buffer_float is unavailable; R16F output is unsafe.' };
    try { return { active: true, value: new GpuMotionReconstructor(gl, surface, sequence, geometry) }; }
    catch (error) { return { active: false, reason: error instanceof Error ? error.message : String(error) }; }
  }

  constructor(gl, canvas, sequence, geometry) {
    assert(sequence?.motion, 'motion assets are unavailable.');
    assert(geometry?.count && geometry.width > 0 && geometry.height > 0, 'a rectangular sampling geometry is required.');
    this.gl = gl; this.canvas = canvas; this.sequence = sequence; this.geometry = geometry;
    this.width = geometry.width; this.height = geometry.height;
    this.program = program(gl);
    this.copyProgram = program(gl, COPY_FRAGMENT_SOURCE);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.positionTexture = texture(gl, gl.RG32F, this.width, this.height, gl.RG, gl.FLOAT, positionsForGeometry(geometry));
    this.rainA = texture(gl, gl.R16F, sequence.longitudes.length, sequence.latitudes.length, gl.RED, gl.FLOAT);
    this.rainB = texture(gl, gl.R16F, sequence.longitudes.length, sequence.latitudes.length, gl.RED, gl.FLOAT);
    this.motionTexture = texture(gl, gl.RGBA32F, sequence.motion.width, sequence.motion.height, gl.RGBA, gl.FLOAT);
    this.output = texture(gl, gl.R16F, this.width, this.height, gl.RED, gl.HALF_FLOAT);
    this.framebuffer = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.output, 0);
    assert(gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE, 'R16F framebuffer is incomplete.');
    this.timerExtension = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.pendingQueries = [];
    this.lastFrames = [-1, -1]; this.lastInterval = -1;
    this.locations = Object.fromEntries(['u_positions', 'u_rainA', 'u_rainB', 'u_motion', 'u_sourceSize', 'u_motionSize', 'u_motionSpacing', 'u_progress', 'u_useMotion'].map((name) => [name, gl.getUniformLocation(this.program, name)]));
    this.copySourceLocation = gl.getUniformLocation(this.copyProgram, 'u_source');
    this.capabilities = Object.freeze({ webgl2: true, r16fRain: true, colorBufferFloat: true, timerQuery: Boolean(this.timerExtension), sourceFloatUpload: true, manualFloatBilinear: true });
  }

  update(frame, { measureGpu = false } = {}) {
    const started = performance.now(); const gl = this.gl; const sequence = this.sequence;
    assert(frame?.sequence === sequence, 'frame belongs to another sequence.');
    const endpoint = frame.progress === 0 || frame.frame0 === frame.frame1;
    if (this.lastFrames[0] !== frame.frame0) { gl.bindTexture(gl.TEXTURE_2D, this.rainA); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, sequence.longitudes.length, sequence.latitudes.length, gl.RED, gl.FLOAT, sequence.sourceFrameAt(frame.frame0)); this.lastFrames[0] = frame.frame0; }
    const b = endpoint ? frame.frame0 : frame.frame1;
    if (this.lastFrames[1] !== b) { gl.bindTexture(gl.TEXTURE_2D, this.rainB); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, sequence.longitudes.length, sequence.latitudes.length, gl.RED, gl.FLOAT, sequence.sourceFrameAt(b)); this.lastFrames[1] = b; }
    if (!endpoint && this.lastInterval !== frame.frame0) { gl.bindTexture(gl.TEXTURE_2D, this.motionTexture); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, sequence.motion.width, sequence.motion.height, gl.RGBA, gl.FLOAT, packedMotion(sequence.motion.intervals[frame.frame0], sequence.motion.width, sequence.motion.height)); this.lastInterval = frame.frame0; }
    let query = null;
    if (measureGpu && this.timerExtension) { query = gl.createQuery(); gl.beginQuery(this.timerExtension.TIME_ELAPSED_EXT, query); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer); gl.viewport(0, 0, this.width, this.height); gl.useProgram(this.program); gl.bindVertexArray(this.vao);
    const bind = (unit, value, location) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, value); gl.uniform1i(location, unit); };
    bind(0, this.positionTexture, this.locations.u_positions); bind(1, this.rainA, this.locations.u_rainA); bind(2, this.rainB, this.locations.u_rainB); bind(3, this.motionTexture, this.locations.u_motion);
    gl.uniform2f(this.locations.u_sourceSize, sequence.longitudes.length, sequence.latitudes.length); gl.uniform2f(this.locations.u_motionSize, sequence.motion.width, sequence.motion.height); gl.uniform1f(this.locations.u_motionSpacing, sequence.motion.spacing); gl.uniform1f(this.locations.u_progress, frame.progress); gl.uniform1i(this.locations.u_useMotion, endpoint ? 0 : 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3); if (query) { gl.endQuery(this.timerExtension.TIME_ELAPSED_EXT); this.pendingQueries.push(query); }
    this.pollTimerQueries();
    return { mainThreadPreparationMs: performance.now() - started, readbackIncluded: false, ...this.diagnostics() };
  }

  pollTimerQueries() {
    const gl = this.gl; if (!this.timerExtension || gl.getParameter(this.timerExtension.GPU_DISJOINT_EXT)) return [];
    const ready = []; this.pendingQueries = this.pendingQueries.filter((query) => { if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) return true; ready.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(query); return false; });
    if (ready.length) this.lastGpuPassMs = ready.at(-1); return ready;
  }

  readback() {
    const gl = this.gl; const encoded = new Uint8Array(this.width * this.height * 4);
    if (!this.validationTexture) {
      this.validationTexture = texture(gl, gl.RGBA8, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE);
      this.validationFramebuffer = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.validationFramebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.validationTexture, 0);
      assert(gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE, 'RGBA8 validation framebuffer is incomplete.');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.validationFramebuffer); gl.viewport(0, 0, this.width, this.height); gl.useProgram(this.copyProgram); gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.output); gl.uniform1i(this.copySourceLocation, 0); gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, encoded);
    const error = gl.getError(); assert(error === gl.NO_ERROR, `validation readback failed (WebGL error ${error}).`);
    const bits = new Uint32Array(this.width * this.height); const values = new Float32Array(bits.buffer);
    for (let i = 0; i < bits.length; i++) bits[i] = encoded[i * 4] | encoded[i * 4 + 1] << 8 | encoded[i * 4 + 2] << 16 | encoded[i * 4 + 3] << 24;
    return values;
  }

  validate(frame, { maximumSamples = 32768 } = {}) {
    this.update(frame); const gpu = this.readback(); const active = this.geometry.potentialActiveIndices || new Uint32Array(0); const stride = Math.max(1, Math.ceil(active.length / maximumSamples)); const sample = frame.prepareTemporalSampling(this.geometry); let count = 0; let total = 0; let max = 0; const errors = [];
    for (let index = 0; index < active.length; index += stride) { const cpu = sample(index); const error = Math.abs(cpu - gpu[active[index]]); total += error; max = Math.max(max, error); errors.push(error); count++; }
    return { frame0: frame.frame0, frame1: frame.frame1, progress: frame.progress, samples: count, maximumAbsoluteRainErrorMmh: max, meanAbsoluteRainErrorMmh: total / count, p95AbsoluteRainErrorMmh: percentile(errors, .95), readbackIncluded: true };
  }

  diagnostics() {
    const sourcePixels = this.sequence.longitudes.length * this.sequence.latitudes.length;
    const motionPixels = this.sequence.motion.width * this.sequence.motion.height;
    return { active: true, texture: { width: this.width, height: this.height, byteEstimate: bytes(this.width, this.height, 2) + bytes(this.width, this.height, 8), validationByteEstimate: this.validationTexture ? bytes(this.width, this.height, 4) : 0 }, sourceRainByteEstimate: bytes(sourcePixels, 1, 2) * 2, motionByteEstimate: bytes(motionPixels, 1, 16), gpuPassMs: this.lastGpuPassMs ?? null, pendingTimerQueries: this.pendingQueries.length, capabilities: this.capabilities, readbackIncluded: false };
  }

  destroy() { const gl = this.gl; for (const value of [this.positionTexture, this.rainA, this.rainB, this.motionTexture, this.output, this.validationTexture]) if (value) gl.deleteTexture(value); gl.deleteFramebuffer(this.framebuffer); if (this.validationFramebuffer) gl.deleteFramebuffer(this.validationFramebuffer); gl.deleteProgram(this.program); gl.deleteProgram(this.copyProgram); gl.deleteVertexArray(this.vao); }
}
