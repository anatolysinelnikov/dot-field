import { LOOP_SECONDS, RAIN_MODERATE_MAX } from './config.js';
import { createAreasReconstructionWorkspace, reconstructAreasChannels } from './areas-reconstruction.js';
import { AREA_HAIL_THRESHOLD, AREA_RAIN_THRESHOLDS, AREA_STORM_THRESHOLD, GeographicScalarLattice } from './geographic-scalar-lattice.js';

const TEMPORAL_FRAME_SECONDS = 0.1;
const TEMPORAL_FRAME_COUNT = Math.round(LOOP_SECONDS / TEMPORAL_FRAME_SECONDS);
const VALUE_STRIDE = 6;
const TEXTURE_STRIDE = 4;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'Scalar weather shader compilation failed.');
  return shader;
}

function setMatrix(gl, location, value) {
  if (location && value) gl.uniformMatrix4fv(location, false, value);
}

function setProjection(gl, locations, projection) {
  setMatrix(gl, locations.matrix, projection.mainMatrix);
  setMatrix(gl, locations.fallbackMatrix, projection.fallbackMatrix);
  setMatrix(gl, locations.projectionMatrix, projection.mainMatrix);
  if (locations.tileMercatorCoords) gl.uniform4f(locations.tileMercatorCoords, ...projection.tileMercatorCoords);
  if (locations.clippingPlane && projection.clippingPlane) gl.uniform4f(locations.clippingPlane, ...projection.clippingPlane);
  if (locations.projectionTransition) gl.uniform1f(locations.projectionTransition, projection.projectionTransition);
}

function temporalFrameAt(time) {
  const wrapped = ((time % 1) + 1) % 1;
  const scaled = wrapped * TEMPORAL_FRAME_COUNT;
  const index = Math.floor(scaled) % TEMPORAL_FRAME_COUNT;
  return { index, progress: scaled - Math.floor(scaled) };
}

function makeProgram(gl, shaderData) {
  const vertexSource = [
    '#version 300 es', shaderData.vertexShaderPrelude, shaderData.define,
    'in vec2 a_position;\nin vec3 a_values0;\nin vec3 a_values1;\nuniform float u_temporalProgress;\nout vec3 v_values;\nout vec2 v_mercator;\nvoid main() {\n  v_values = mix(a_values0, a_values1, u_temporalProgress);\n  v_mercator = a_position;\n  gl_Position = projectTile(a_position);\n}'
  ].join('\n');
  const fragmentSource = [
    '#version 300 es', 'precision highp float;',
    'in vec3 v_values;\nin vec2 v_mercator;\nuniform int u_mode;\nuniform float u_temporalProgress;\nuniform sampler2D u_valuesTexture0;\nuniform sampler2D u_valuesTexture1;\nuniform vec2 u_latticeOrigin;\nuniform float u_latticeSpacing;\nuniform ivec2 u_latticeSize;\nuniform vec4 u_rainThresholds;\nuniform float u_rainThresholdLast;\nuniform float u_stormThreshold;\nuniform float u_hailThreshold;\nout vec4 fragColor;',
    `vec3 bilinearScalar(sampler2D scalarTexture, vec2 mercatorPosition) {
  vec2 maximum = vec2(u_latticeSize - ivec2(1));
  vec2 grid = clamp((mercatorPosition - u_latticeOrigin) / u_latticeSpacing, vec2(0.0), maximum);
  ivec2 low = ivec2(min(floor(grid), maximum - vec2(1.0)));
  ivec2 high = low + ivec2(1);
  vec2 fraction = grid - vec2(low);
  vec3 top = mix(texelFetch(scalarTexture, low, 0).rgb, texelFetch(scalarTexture, ivec2(high.x, low.y), 0).rgb, fraction.x);
  vec3 bottom = mix(texelFetch(scalarTexture, ivec2(low.x, high.y), 0).rgb, texelFetch(scalarTexture, high, 0).rgb, fraction.x);
  return mix(top, bottom, fraction.y);
}
float soften(float edge, float value) { float width = max(fwidth(value) * 1.25, 0.00001); return smoothstep(edge - width, edge + width, value); }
float hazardOpacity(float value, float onset, float visibleOnset, float strongAnchor, float core, float exponent) {
  if (value < visibleOnset) return 0.4 * pow(smoothstep(onset, visibleOnset, value), exponent);
  if (value < strongAnchor) return mix(0.4, 0.65, smoothstep(visibleOnset, strongAnchor, value));
  return mix(0.65, 1.0, smoothstep(strongAnchor, core, value));
}
vec4 blurColor(float rain, float storm, float hail) {
  float rainOpacity = pow(smoothstep(0.006, 0.52, rain), 0.66);
  float strong = smoothstep(${RAIN_MODERATE_MAX.toFixed(3)}, 0.9, rain);
  vec4 color = vec4(0.0, mix(0.565, 0.0, strong), 1.0, rainOpacity);
  float stormOpacity = hazardOpacity(storm, 0.006, 0.03375, 0.075, 0.54, 0.76);
  color.rgb = mix(color.rgb, vec3(1.0, 0.0, 1.0), stormOpacity);
  color.a = stormOpacity + color.a * (1.0 - stormOpacity);
  float hailOpacity = hazardOpacity(hail, 0.010, 0.0495, 0.11, 0.44, 0.68);
  color.rgb = mix(color.rgb, vec3(1.0, 0.831, 0.0), hailOpacity);
  color.a = hailOpacity + color.a * (1.0 - hailOpacity);
  return color;
}
vec4 areasColor(float rain, float storm, float hail) {
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
  float stormInside = soften(u_stormThreshold, storm);
  float stormEdge = 1.0 - smoothstep(0.0, max(fwidth(storm) * 2.0, 0.00001), abs(storm - u_stormThreshold));
  vec4 stormColor = vec4(vec3(1.0, 0.0, 1.0), 0.45 * stormInside + 0.5 * stormEdge);
  color.rgb = mix(color.rgb, stormColor.rgb, stormColor.a);
  color.a = stormColor.a + color.a * (1.0 - stormColor.a);
  float hailInside = soften(u_hailThreshold, hail);
  float hailEdge = 1.0 - smoothstep(0.0, max(fwidth(hail) * 2.0, 0.00001), abs(hail - u_hailThreshold));
  vec4 hailColor = vec4(vec3(1.0, 0.831, 0.0), 0.35 * hailInside + 0.55 * hailEdge);
  color.rgb = mix(color.rgb, hailColor.rgb, hailColor.a);
  color.a = hailColor.a + color.a * (1.0 - hailColor.a);
  return color;
}
void main() {
  if (u_mode == 0) {
    vec3 values = max(v_values, vec3(0.0));
    fragColor = blurColor(values.x, values.y, values.z);
    return;
  }
  vec3 values = max(mix(bilinearScalar(u_valuesTexture0, v_mercator), bilinearScalar(u_valuesTexture1, v_mercator), u_temporalProgress), vec3(0.0));
  fragColor = areasColor(values.x, values.y, values.z);
}`
  ].join('\n');
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Scalar weather shader linking failed.');
  return {
    program,
    locations: Object.fromEntries(['a_position', 'a_values0', 'a_values1', 'u_temporalProgress', 'u_mode', 'u_valuesTexture0', 'u_valuesTexture1', 'u_latticeOrigin', 'u_latticeSpacing', 'u_latticeSize', 'u_rainThresholds', 'u_rainThresholdLast', 'u_stormThreshold', 'u_hailThreshold', 'u_matrix', 'u_projection_fallback_matrix', 'u_projection_matrix', 'u_projection_tile_mercator_coords', 'u_projection_clipping_plane', 'u_projection_transition'].map((name) => [name, name.startsWith('a_') ? gl.getAttribLocation(program, name) : gl.getUniformLocation(program, name)]))
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
    this.values = new Float32Array(this.lattice.length * VALUE_STRIDE);
    this.areaReconstruction = createAreasReconstructionWorkspace(this.lattice.width, this.lattice.height);
    this.textureValues0 = new Float32Array(this.areaReconstruction.width * this.areaReconstruction.height * TEXTURE_STRIDE);
    this.textureValues1 = new Float32Array(this.areaReconstruction.width * this.areaReconstruction.height * TEXTURE_STRIDE);
    this.valuesDirty = true;
    this.texturesDirty = [true, true];
    this.programs = new Map();
  }

  onAdd(map, gl) {
    this.map = map;
    this.positionBuffer = gl.createBuffer();
    this.indexBuffer = gl.createBuffer();
    this.valueBuffer = gl.createBuffer();
    this.valueTextures = [gl.createTexture(), gl.createTexture()];
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.lattice.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.lattice.indices, gl.STATIC_DRAW);
    for (const texture of this.valueTextures) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, this.areaReconstruction.width, this.areaReconstruction.height);
    }
    if (!this.temporal) this.rebuildTemporal(0);
  }

  onRemove(map, gl) {
    for (const entry of this.programs.values()) gl.deleteProgram(entry.program);
    for (const buffer of [this.positionBuffer, this.indexBuffer, this.valueBuffer]) if (buffer) gl.deleteBuffer(buffer);
    for (const texture of this.valueTextures || []) if (texture) gl.deleteTexture(texture);
  }

  setActive(active) {
    this.active = active;
    this.map?.triggerRepaint();
  }

  setPresentation(mode, smooth, time) {
    const changed = this.mode !== mode || this.smooth !== smooth;
    this.mode = mode;
    this.smooth = smooth;
    if (!this.temporal) this.rebuildTemporal(time);
    else if (changed) this.rebuildValues();
    this.map?.triggerRepaint();
  }

  rebuildTemporal(time) {
    const frame = temporalFrameAt(time);
    const nextIndex = (frame.index + 1) % TEMPORAL_FRAME_COUNT;
    this.temporal = {
      index: frame.index,
      nextIndex,
      state0: this.lattice.evaluate(frame.index / TEMPORAL_FRAME_COUNT),
      state1: this.lattice.evaluate(nextIndex / TEMPORAL_FRAME_COUNT)
    };
    this.temporalProgress = frame.progress;
    this.rebuildValues();
  }

  rebuildValues(reusePreviousAreaState = false) {
    const state0 = this.temporal.state0[this.smooth ? 'smooth' : 'raw'];
    const state1 = this.temporal.state1[this.smooth ? 'smooth' : 'raw'];
    for (let index = 0, offset = 0; index < this.lattice.length; index++, offset += VALUE_STRIDE) {
      this.values[offset] = state0.rain[index];
      this.values[offset + 1] = state0.storm[index];
      this.values[offset + 2] = state0.hail[index];
      this.values[offset + 3] = state1.rain[index];
      this.values[offset + 4] = state1.storm[index];
      this.values[offset + 5] = state1.hail[index];
    }
    this.valuesDirty = true;
    if (this.mode === 'areas') {
      if (reusePreviousAreaState) this.advanceAreaTextureValues(state1);
      else this.rebuildTextureValues(state0, state1);
    }
  }

  rebuildTextureValues(state0, state1) {
    reconstructAreasChannels(state0, this.areaReconstruction, this.textureValues0, TEXTURE_STRIDE);
    reconstructAreasChannels(state1, this.areaReconstruction, this.textureValues1, TEXTURE_STRIDE);
    this.texturesDirty[0] = true;
    this.texturesDirty[1] = true;
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
    const state0Dirty = this.texturesDirty[1];
    reconstructAreasChannels(state1, this.areaReconstruction, this.textureValues1, TEXTURE_STRIDE);
    this.texturesDirty[0] = state0Dirty;
    this.texturesDirty[1] = true;
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
  }

  updateWeather(time) {
    const frame = temporalFrameAt(time);
    if (!this.temporal || frame.index !== this.temporal.index) {
      if (this.temporal && frame.index === this.temporal.nextIndex) {
        const reusable = this.temporal.state0;
        this.temporal.index = frame.index;
        this.temporal.nextIndex = (frame.index + 1) % TEMPORAL_FRAME_COUNT;
        this.temporal.state0 = this.temporal.state1;
        this.temporal.state1 = this.lattice.evaluate(this.temporal.nextIndex / TEMPORAL_FRAME_COUNT, reusable);
        this.rebuildValues(true);
      } else this.rebuildTemporal(time);
    }
    this.temporalProgress = frame.progress;
    if (this.active) this.map?.triggerRepaint();
  }

  programFor(gl, shaderData) {
    let entry = this.programs.get(shaderData.variantName);
    if (!entry) {
      entry = makeProgram(gl, shaderData);
      this.programs.set(shaderData.variantName, entry);
    }
    return entry;
  }

  render(gl, args) {
    if (!this.active || !this.temporal) return;
    if (this.valuesDirty) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.valueBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.values, gl.DYNAMIC_DRAW);
      this.valuesDirty = false;
    }
    if (this.mode === 'areas') this.uploadTextures(gl);
    const { program, locations } = this.programFor(gl, args.shaderData);
    gl.useProgram(program);
    setProjection(gl, {
      matrix: locations.u_matrix, fallbackMatrix: locations.u_projection_fallback_matrix, projectionMatrix: locations.u_projection_matrix,
      tileMercatorCoords: locations.u_projection_tile_mercator_coords, clippingPlane: locations.u_projection_clipping_plane, projectionTransition: locations.u_projection_transition
    }, args.defaultProjectionData);
    gl.uniform1f(locations.u_temporalProgress, this.temporalProgress);
    gl.uniform1i(locations.u_mode, this.mode === 'areas' ? 1 : 0);
    if (this.mode === 'areas') {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.valueTextures[0]);
      gl.uniform1i(locations.u_valuesTexture0, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.valueTextures[1]);
      gl.uniform1i(locations.u_valuesTexture1, 1);
      gl.uniform2fv(locations.u_latticeOrigin, this.lattice.origin);
      gl.uniform1f(locations.u_latticeSpacing, this.lattice.spacing / this.areaReconstruction.subdivisions);
      gl.uniform2i(locations.u_latticeSize, this.areaReconstruction.width, this.areaReconstruction.height);
    }
    const thresholds0 = this.smooth ? this.temporal.state0.rainThresholds : AREA_RAIN_THRESHOLDS;
    const thresholds1 = this.smooth ? this.temporal.state1.rainThresholds : AREA_RAIN_THRESHOLDS;
    const progress = this.temporalProgress;
    const thresholds = [0, 1, 2, 3].map((index) => thresholds0[index] + (thresholds1[index] - thresholds0[index]) * progress);
    gl.uniform4fv(locations.u_rainThresholds, thresholds);
    gl.uniform1f(locations.u_rainThresholdLast, thresholds0[4] + (thresholds1[4] - thresholds0[4]) * progress);
    gl.uniform1f(locations.u_stormThreshold, this.smooth ? this.temporal.state0.stormThreshold + (this.temporal.state1.stormThreshold - this.temporal.state0.stormThreshold) * progress : AREA_STORM_THRESHOLD);
    gl.uniform1f(locations.u_hailThreshold, this.smooth ? this.temporal.state0.hailThreshold + (this.temporal.state1.hailThreshold - this.temporal.state0.hailThreshold) * progress : AREA_HAIL_THRESHOLD);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.enableVertexAttribArray(locations.a_position);
    gl.vertexAttribPointer(locations.a_position, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.valueBuffer);
    gl.enableVertexAttribArray(locations.a_values0);
    gl.vertexAttribPointer(locations.a_values0, 3, gl.FLOAT, false, VALUE_STRIDE * 4, 0);
    gl.enableVertexAttribArray(locations.a_values1);
    gl.vertexAttribPointer(locations.a_values1, 3, gl.FLOAT, false, VALUE_STRIDE * 4, 12);
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
