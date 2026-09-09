import { RAIN_MODERATE_MAX } from './config.js';
import { createAreasReconstructionWorkspace, reconstructAreasChannel, reconstructAreasChannels } from './areas-reconstruction.js';
import { geographicTemporalFrameAt, setGeographicProjection, TEMPORAL_FRAME_COUNT } from './geographic-layer-utils.js';
import {
  AREA_HAIL_THRESHOLD,
  AREA_HURRICANE_THRESHOLD,
  AREA_RAIN_THRESHOLDS,
  AREA_SQUALL_THRESHOLDS,
  AREA_STORM_THRESHOLD,
  GeographicScalarLattice
} from './geographic-scalar-lattice.js';
import { SQUALL_GRADE_THRESHOLDS } from './precipitation-mapping.js';

const VALUE_STRIDE = 10;
const TEXTURE_STRIDE = 4;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'Scalar weather shader compilation failed.');
  return shader;
}

function makeProgram(gl, shaderData, mode) {
  const blur = mode === 'blur';
  const vertexSource = [
    '#version 300 es', shaderData.vertexShaderPrelude, shaderData.define,
    blur
      ? 'in vec2 a_position;\nin vec4 a_values0;\nin float a_hurricane0;\nin vec4 a_values1;\nin float a_hurricane1;\nuniform float u_temporalProgress;\nout vec4 v_values;\nout float v_hurricane;\nout vec2 v_mercator;\nvoid main() {\n  v_values = mix(a_values0, a_values1, u_temporalProgress);\n  v_hurricane = mix(a_hurricane0, a_hurricane1, u_temporalProgress);\n  v_mercator = a_position;\n  gl_Position = projectTile(a_position);\n}'
      : 'in vec2 a_position;\nout vec2 v_mercator;\nvoid main() {\n  v_mercator = a_position;\n  gl_Position = projectTile(a_position);\n}'
  ].join('\n');
  const fragmentSource = [
    '#version 300 es', 'precision highp float;',
    'in vec4 v_values;\nin float v_hurricane;\nin vec2 v_mercator;\nuniform float u_temporalProgress;\nuniform sampler2D u_valuesTexture0;\nuniform sampler2D u_valuesTexture1;\nuniform sampler2D u_hurricaneTexture0;\nuniform sampler2D u_hurricaneTexture1;\nuniform vec2 u_latticeOrigin;\nuniform float u_latticeSpacing;\nuniform ivec2 u_latticeSize;\nuniform vec4 u_rainThresholds;\nuniform float u_rainThresholdLast;\nuniform vec3 u_squallThresholds;\nuniform float u_hurricaneThreshold;\nuniform float u_stormThreshold;\nuniform float u_hailThreshold;\nout vec4 fragColor;',
    `vec4 bilinearScalar(sampler2D scalarTexture, vec2 mercatorPosition) {
  vec2 maximum = vec2(u_latticeSize - ivec2(1));
  vec2 grid = clamp((mercatorPosition - u_latticeOrigin) / u_latticeSpacing, vec2(0.0), maximum);
  ivec2 low = ivec2(min(floor(grid), maximum - vec2(1.0)));
  ivec2 high = low + ivec2(1);
  vec2 fraction = grid - vec2(low);
  vec4 top = mix(texelFetch(scalarTexture, low, 0), texelFetch(scalarTexture, ivec2(high.x, low.y), 0), fraction.x);
  vec4 bottom = mix(texelFetch(scalarTexture, ivec2(low.x, high.y), 0), texelFetch(scalarTexture, high, 0), fraction.x);
  return mix(top, bottom, fraction.y);
}
float bilinearRed(sampler2D scalarTexture, vec2 mercatorPosition) {
  vec2 maximum = vec2(u_latticeSize - ivec2(1));
  vec2 grid = clamp((mercatorPosition - u_latticeOrigin) / u_latticeSpacing, vec2(0.0), maximum);
  ivec2 low = ivec2(min(floor(grid), maximum - vec2(1.0)));
  ivec2 high = low + ivec2(1);
  vec2 fraction = grid - vec2(low);
  float top = mix(texelFetch(scalarTexture, low, 0).r, texelFetch(scalarTexture, ivec2(high.x, low.y), 0).r, fraction.x);
  float bottom = mix(texelFetch(scalarTexture, ivec2(low.x, high.y), 0).r, texelFetch(scalarTexture, high, 0).r, fraction.x);
  return mix(top, bottom, fraction.y);
}
float soften(float edge, float value) { float width = max(fwidth(value) * 1.25, 0.00001); return smoothstep(edge - width, edge + width, value); }
float hazardOpacity(float value, float onset, float visibleOnset, float strongAnchor, float core, float exponent) {
  if (value < visibleOnset) return 0.4 * pow(smoothstep(onset, visibleOnset, value), exponent);
  if (value < strongAnchor) return mix(0.4, 0.65, smoothstep(visibleOnset, strongAnchor, value));
  return mix(0.65, 1.0, smoothstep(strongAnchor, core, value));
}
vec4 blurColor(float rain, float storm, float hail, float squall, float hurricane) {
  float rainOpacity = pow(smoothstep(0.006, 0.52, rain), 0.66);
  float strong = smoothstep(${RAIN_MODERATE_MAX.toFixed(3)}, 0.9, rain);
  vec4 color = vec4(0.0, mix(0.565, 0.0, strong), 1.0, rainOpacity);
  float hurricaneOpacity = hazardOpacity(hurricane, 0.04, 0.081, 0.18, 0.82, 0.65);
  float squallOpacity = hazardOpacity(squall, 0.036, 0.08, 0.72, 0.95, 0.70);
  float hailOpacity = hazardOpacity(hail, 0.010, 0.0495, 0.11, 0.44, 0.68);
  float stormOpacity = hazardOpacity(storm, 0.006, 0.03375, 0.075, 0.54, 0.76);
  if (hurricane > 0.081) { color = vec4(vec3(0.86, 0.015, 0.08), hurricaneOpacity); }
  else if (squall > 0.036) {
    vec3 squallColor = squall >= ${SQUALL_GRADE_THRESHOLDS[2].toFixed(3)} ? vec3(0.95, 0.07, 0.02)
      : squall >= ${SQUALL_GRADE_THRESHOLDS[1].toFixed(3)} ? vec3(1.0, 0.24, 0.0)
        : vec3(1.0, 0.52, 0.0);
    color = vec4(squallColor, squallOpacity);
  } else if (hail > 0.0495) color = vec4(vec3(1.0, 0.831, 0.0), hailOpacity);
  else if (storm > 0.03375) color = vec4(vec3(1.0, 0.0, 1.0), stormOpacity);
  return color;
}
vec4 areasColor(float rain, float storm, float hail, float squall, float hurricane) {
  float thresholds[5];
  thresholds[0] = u_rainThresholds.x; thresholds[1] = u_rainThresholds.y; thresholds[2] = u_rainThresholds.z; thresholds[3] = u_rainThresholds.w; thresholds[4] = u_rainThresholdLast;
  vec3 colors[5];
  colors[0] = vec3(0.0, 0.565, 1.0); colors[1] = vec3(0.0, 0.471, 1.0); colors[2] = vec3(0.0, 0.369, 1.0); colors[3] = vec3(0.0, 0.235, 1.0); colors[4] = vec3(0.0, 0.0, 1.0);
  vec4 color = vec4(0.0);
  for (int band = 0; band < 5; band++) {
    float inside = soften(thresholds[band], rain);
    color.rgb = mix(color.rgb, colors[band], inside);
    color.a = max(color.a, inside * 0.92);
  }
  return color;
}
void main() {
  ${blur ? 'vec4 values = max(v_values, vec4(0.0)); fragColor = blurColor(values.x, values.y, values.z, values.w, max(v_hurricane, 0.0));' : 'vec4 values = max(mix(bilinearScalar(u_valuesTexture0, v_mercator), bilinearScalar(u_valuesTexture1, v_mercator), u_temporalProgress), vec4(0.0)); float hurricane = max(mix(bilinearRed(u_hurricaneTexture0, v_mercator), bilinearRed(u_hurricaneTexture1, v_mercator), u_temporalProgress), 0.0); fragColor = areasColor(values.x, values.y, values.z, values.w, hurricane);'}
}`
  ].join('\n');
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Scalar weather shader linking failed.');
  return {
    program,
    locations: Object.fromEntries(['a_position', 'a_values0', 'a_hurricane0', 'a_values1', 'a_hurricane1', 'u_temporalProgress', 'u_valuesTexture0', 'u_valuesTexture1', 'u_hurricaneTexture0', 'u_hurricaneTexture1', 'u_latticeOrigin', 'u_latticeSpacing', 'u_latticeSize', 'u_rainThresholds', 'u_rainThresholdLast', 'u_squallThresholds', 'u_hurricaneThreshold', 'u_stormThreshold', 'u_hailThreshold', 'u_matrix', 'u_projection_fallback_matrix', 'u_projection_matrix', 'u_projection_tile_mercator_coords', 'u_projection_clipping_plane', 'u_projection_transition'].map((name) => [name, name.startsWith('a_') ? gl.getAttribLocation(program, name) : gl.getUniformLocation(program, name)]))
  };
}

export class GeographicScalarLayer {
  constructor() {
    this.id = 'geographic-weather-scalar';
    this.type = 'custom';
    this.renderingMode = '3d';
    this.lattice = new GeographicScalarLattice();
    this.active = false;
    this.mode = 'blur';
    this.smooth = false;
    this.temporal = null;
    this.temporalProgress = 0;
    this.values = null;
    this.valuesDirty = false;
    this.valueBufferCapacity = 0;
    this.areaReconstruction = null;
    this.textureValues0 = null;
    this.textureValues1 = null;
    this.hurricaneTextureValues0 = null;
    this.hurricaneTextureValues1 = null;
    this.texturesDirty = [false, false];
    this.hurricaneTexturesDirty = [false, false];
    this.interpolatedThresholds = new Float32Array(4);
    this.interpolatedSquallThresholds = new Float32Array(3);
    this.programs = new Map();
  }

  onAdd(map, gl) {
    this.map = map;
    this.positionBuffer = gl.createBuffer();
    this.indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.lattice.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.lattice.indices, gl.STATIC_DRAW);
  }

  onRemove(map, gl) {
    for (const entry of this.programs.values()) gl.deleteProgram(entry.program);
    for (const buffer of [this.positionBuffer, this.indexBuffer, this.valueBuffer]) if (buffer) gl.deleteBuffer(buffer);
    for (const texture of this.valueTextures || []) if (texture) gl.deleteTexture(texture);
    for (const texture of this.hurricaneTextures || []) if (texture) gl.deleteTexture(texture);
  }

  setActive(active) {
    this.active = active;
    this.map?.triggerRepaint();
  }

  setPresentation(mode, smooth, time) {
    const changed = this.mode !== mode || this.smooth !== smooth;
    this.mode = mode;
    this.smooth = smooth;
    if (this.temporal && changed) this.preparePresentation();
    this.map?.triggerRepaint();
  }

  rebuildTemporal(time) {
    const frame = geographicTemporalFrameAt(time);
    const nextIndex = (frame.index + 1) % TEMPORAL_FRAME_COUNT;
    this.temporal = {
      index: frame.index,
      nextIndex,
      state0: this.lattice.evaluate(frame.index / TEMPORAL_FRAME_COUNT),
      state1: this.lattice.evaluate(nextIndex / TEMPORAL_FRAME_COUNT)
    };
    this.temporalProgress = frame.progress;
    this.preparePresentation();
  }

  ensureAreaResources() {
    if (this.areaReconstruction) return;
    this.areaReconstruction = createAreasReconstructionWorkspace(this.lattice.width, this.lattice.height);
    const length = this.areaReconstruction.width * this.areaReconstruction.height * TEXTURE_STRIDE;
    this.textureValues0 = new Float32Array(length);
    this.textureValues1 = new Float32Array(length);
    this.hurricaneTextureValues0 = new Float32Array(this.areaReconstruction.width * this.areaReconstruction.height);
    this.hurricaneTextureValues1 = new Float32Array(this.areaReconstruction.width * this.areaReconstruction.height);
  }

  ensureAreaTextures(gl) {
    if (this.valueTextures) return;
    this.valueTextures = [gl.createTexture(), gl.createTexture()];
    for (const texture of this.valueTextures) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, this.areaReconstruction.width, this.areaReconstruction.height);
    }
    this.hurricaneTextures = [gl.createTexture(), gl.createTexture()];
    for (const texture of this.hurricaneTextures) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, this.areaReconstruction.width, this.areaReconstruction.height);
    }
  }

  ensureSmoothStates() {
    if (!this.smooth) return;
    this.lattice.ensureSmooth(this.temporal.state0);
    this.lattice.ensureSmooth(this.temporal.state1);
  }

  rebuildBlurValues() {
    if (!this.values) this.values = new Float32Array(this.lattice.length * VALUE_STRIDE);
    const state0 = this.temporal.state0.raw;
    const state1 = this.temporal.state1.raw;
    for (let index = 0, offset = 0; index < this.lattice.length; index++, offset += VALUE_STRIDE) {
      this.values[offset] = state0.rain[index];
      this.values[offset + 1] = state0.storm[index];
      this.values[offset + 2] = state0.hail[index];
      this.values[offset + 3] = state0.squall[index];
      this.values[offset + 4] = state0.hurricane[index];
      this.values[offset + 5] = state1.rain[index];
      this.values[offset + 6] = state1.storm[index];
      this.values[offset + 7] = state1.hail[index];
      this.values[offset + 8] = state1.squall[index];
      this.values[offset + 9] = state1.hurricane[index];
    }
    this.valuesDirty = true;
  }

  preparePresentation(reusePreviousAreaState = false) {
    if (!this.temporal) return;
    if (this.mode === 'blur') {
      this.rebuildBlurValues();
      return;
    }
    this.ensureSmoothStates();
    const state0 = this.temporal.state0[this.smooth ? 'smooth' : 'raw'];
    const state1 = this.temporal.state1[this.smooth ? 'smooth' : 'raw'];
    this.ensureAreaResources();
    if (reusePreviousAreaState) this.advanceAreaTextureValues(state1);
    else this.rebuildTextureValues(state0, state1);
  }

  rebuildTextureValues(state0, state1) {
    reconstructAreasChannels(state0, this.areaReconstruction, this.textureValues0, TEXTURE_STRIDE);
    reconstructAreasChannels(state1, this.areaReconstruction, this.textureValues1, TEXTURE_STRIDE);
    reconstructAreasChannel(state0.hurricane, this.areaReconstruction, this.hurricaneTextureValues0, 0, 1);
    reconstructAreasChannel(state1.hurricane, this.areaReconstruction, this.hurricaneTextureValues1, 0, 1);
    this.texturesDirty[0] = true;
    this.texturesDirty[1] = true;
    this.hurricaneTexturesDirty[0] = true;
    this.hurricaneTexturesDirty[1] = true;
  }

  advanceAreaTextureValues(state1) {
    const reusableValues = this.textureValues0;
    this.textureValues0 = this.textureValues1;
    this.textureValues1 = reusableValues;
    if (this.valueTextures) {
      const reusableTexture = this.valueTextures[0];
      this.valueTextures[0] = this.valueTextures[1];
      this.valueTextures[1] = reusableTexture;
    }
    const reusableHurricaneValues = this.hurricaneTextureValues0;
    this.hurricaneTextureValues0 = this.hurricaneTextureValues1;
    this.hurricaneTextureValues1 = reusableHurricaneValues;
    if (this.hurricaneTextures) {
      const reusableHurricaneTexture = this.hurricaneTextures[0];
      this.hurricaneTextures[0] = this.hurricaneTextures[1];
      this.hurricaneTextures[1] = reusableHurricaneTexture;
    }
    const state0Dirty = this.texturesDirty[1];
    const hurricaneState0Dirty = this.hurricaneTexturesDirty[1];
    reconstructAreasChannels(state1, this.areaReconstruction, this.textureValues1, TEXTURE_STRIDE);
    reconstructAreasChannel(state1.hurricane, this.areaReconstruction, this.hurricaneTextureValues1, 0, 1);
    this.texturesDirty[0] = state0Dirty;
    this.texturesDirty[1] = true;
    this.hurricaneTexturesDirty[0] = hurricaneState0Dirty;
    this.hurricaneTexturesDirty[1] = true;
  }

  uploadTextures(gl) {
    if (!this.valueTextures) return;
    for (let index = 0; index < this.valueTextures.length; index++) {
      if (!this.texturesDirty[index]) continue;
      gl.bindTexture(gl.TEXTURE_2D, this.valueTextures[index]);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.areaReconstruction.width, this.areaReconstruction.height, gl.RGBA, gl.FLOAT,
        index === 0 ? this.textureValues0 : this.textureValues1);
      this.texturesDirty[index] = false;
    }
    for (let index = 0; index < this.hurricaneTextures.length; index++) {
      if (!this.hurricaneTexturesDirty[index]) continue;
      gl.bindTexture(gl.TEXTURE_2D, this.hurricaneTextures[index]);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.areaReconstruction.width, this.areaReconstruction.height, gl.RED, gl.FLOAT,
        index === 0 ? this.hurricaneTextureValues0 : this.hurricaneTextureValues1);
      this.hurricaneTexturesDirty[index] = false;
    }
  }

  updateWeather(time) {
    const frame = geographicTemporalFrameAt(time);
    if (!this.temporal || frame.index !== this.temporal.index) {
      if (this.temporal && frame.index === this.temporal.nextIndex) {
        const reusable = this.temporal.state0;
        this.temporal.index = frame.index;
        this.temporal.nextIndex = (frame.index + 1) % TEMPORAL_FRAME_COUNT;
        this.temporal.state0 = this.temporal.state1;
        this.temporal.state1 = this.lattice.evaluate(this.temporal.nextIndex / TEMPORAL_FRAME_COUNT, reusable);
        this.preparePresentation(this.mode === 'areas');
      } else this.rebuildTemporal(time);
    }
    this.temporalProgress = frame.progress;
    if (this.active) this.map?.triggerRepaint();
  }

  programFor(gl, shaderData) {
    const key = `${shaderData.variantName}:${this.mode}`;
    let entry = this.programs.get(key);
    if (!entry) {
      entry = makeProgram(gl, shaderData, this.mode);
      this.programs.set(key, entry);
    }
    return entry;
  }

  render(gl, args) {
    if (!this.active || !this.temporal) return;
    if (this.mode === 'blur' && this.valuesDirty) {
      if (!this.valueBuffer) this.valueBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.valueBuffer);
      if (this.valueBufferCapacity < this.values.byteLength) {
        gl.bufferData(gl.ARRAY_BUFFER, this.values.byteLength, gl.DYNAMIC_DRAW);
        this.valueBufferCapacity = this.values.byteLength;
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.values);
      this.valuesDirty = false;
    }
    if (this.mode === 'areas') {
      this.ensureAreaTextures(gl);
      this.uploadTextures(gl);
    }
    const { program, locations } = this.programFor(gl, args.shaderData);
    gl.useProgram(program);
    setGeographicProjection(gl, {
      matrix: locations.u_matrix, fallbackMatrix: locations.u_projection_fallback_matrix, projectionMatrix: locations.u_projection_matrix,
      tileMercatorCoords: locations.u_projection_tile_mercator_coords, clippingPlane: locations.u_projection_clipping_plane, projectionTransition: locations.u_projection_transition
    }, args.defaultProjectionData);
    gl.uniform1f(locations.u_temporalProgress, this.temporalProgress);
    if (this.mode === 'areas') {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.valueTextures[0]);
      gl.uniform1i(locations.u_valuesTexture0, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.valueTextures[1]);
      gl.uniform1i(locations.u_valuesTexture1, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.hurricaneTextures[0]);
      gl.uniform1i(locations.u_hurricaneTexture0, 2);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.hurricaneTextures[1]);
      gl.uniform1i(locations.u_hurricaneTexture1, 3);
      gl.uniform2fv(locations.u_latticeOrigin, this.lattice.origin);
      gl.uniform1f(locations.u_latticeSpacing, this.lattice.spacing / this.areaReconstruction.subdivisions);
      gl.uniform2i(locations.u_latticeSize, this.areaReconstruction.width, this.areaReconstruction.height);
    }
    if (this.mode === 'areas') {
      const thresholds0 = this.smooth ? this.temporal.state0.rainThresholds : AREA_RAIN_THRESHOLDS;
      const thresholds1 = this.smooth ? this.temporal.state1.rainThresholds : AREA_RAIN_THRESHOLDS;
      const progress = this.temporalProgress;
      const thresholds = this.interpolatedThresholds;
      for (let index = 0; index < thresholds.length; index++) thresholds[index] = thresholds0[index] + (thresholds1[index] - thresholds0[index]) * progress;
      gl.uniform4fv(locations.u_rainThresholds, thresholds);
      gl.uniform1f(locations.u_rainThresholdLast, thresholds0[4] + (thresholds1[4] - thresholds0[4]) * progress);
      const squallThresholds0 = this.smooth ? this.temporal.state0.squallThresholds : AREA_SQUALL_THRESHOLDS;
      const squallThresholds1 = this.smooth ? this.temporal.state1.squallThresholds : AREA_SQUALL_THRESHOLDS;
      const squallThresholds = this.interpolatedSquallThresholds;
      for (let index = 0; index < squallThresholds.length; index++) squallThresholds[index] = squallThresholds0[index] + (squallThresholds1[index] - squallThresholds0[index]) * progress;
      gl.uniform3fv(locations.u_squallThresholds, squallThresholds);
      gl.uniform1f(locations.u_hurricaneThreshold, this.smooth ? this.temporal.state0.hurricaneThreshold + (this.temporal.state1.hurricaneThreshold - this.temporal.state0.hurricaneThreshold) * progress : AREA_HURRICANE_THRESHOLD);
      gl.uniform1f(locations.u_stormThreshold, this.smooth ? this.temporal.state0.stormThreshold + (this.temporal.state1.stormThreshold - this.temporal.state0.stormThreshold) * progress : AREA_STORM_THRESHOLD);
      gl.uniform1f(locations.u_hailThreshold, this.smooth ? this.temporal.state0.hailThreshold + (this.temporal.state1.hailThreshold - this.temporal.state0.hailThreshold) * progress : AREA_HAIL_THRESHOLD);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.enableVertexAttribArray(locations.a_position);
    gl.vertexAttribPointer(locations.a_position, 2, gl.FLOAT, false, 0, 0);
    if (this.mode === 'blur') {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.valueBuffer);
      gl.enableVertexAttribArray(locations.a_values0);
      gl.vertexAttribPointer(locations.a_values0, 4, gl.FLOAT, false, VALUE_STRIDE * 4, 0);
      gl.enableVertexAttribArray(locations.a_hurricane0);
      gl.vertexAttribPointer(locations.a_hurricane0, 1, gl.FLOAT, false, VALUE_STRIDE * 4, 16);
      gl.enableVertexAttribArray(locations.a_values1);
      gl.vertexAttribPointer(locations.a_values1, 4, gl.FLOAT, false, VALUE_STRIDE * 4, 20);
      gl.enableVertexAttribArray(locations.a_hurricane1);
      gl.vertexAttribPointer(locations.a_hurricane1, 1, gl.FLOAT, false, VALUE_STRIDE * 4, 36);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -1);
    gl.drawElements(gl.TRIANGLES, this.lattice.indices.length, gl.UNSIGNED_INT, 0);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true);
    if (this.mode === 'areas') gl.activeTexture(gl.TEXTURE0);
  }
}
