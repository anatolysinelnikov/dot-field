import { LOOP_SECONDS, RAIN_MODERATE_MAX } from './config.js';
import { AREA_HAIL_THRESHOLD, AREA_RAIN_THRESHOLDS, AREA_STORM_THRESHOLD, GeographicScalarLattice } from './geographic-scalar-lattice.js';

const TEMPORAL_FRAME_SECONDS = 0.1;
const TEMPORAL_FRAME_COUNT = Math.round(LOOP_SECONDS / TEMPORAL_FRAME_SECONDS);
const VALUE_STRIDE = 6;

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
    'in vec2 a_position;\nin vec3 a_values0;\nin vec3 a_values1;\nuniform float u_temporalProgress;\nout vec3 v_values;\nvoid main() {\n  v_values = mix(a_values0, a_values1, u_temporalProgress);\n  gl_Position = projectTile(a_position);\n}'
  ].join('\n');
  const fragmentSource = [
    '#version 300 es', 'precision highp float;',
    'in vec3 v_values;\nuniform int u_mode;\nuniform vec4 u_rainThresholds;\nuniform float u_rainThresholdLast;\nuniform float u_stormThreshold;\nuniform float u_hailThreshold;\nout vec4 fragColor;',
    `float soften(float edge, float value) { float width = max(fwidth(value) * 1.25, 0.00001); return smoothstep(edge - width, edge + width, value); }
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
void main() { vec3 values = max(v_values, vec3(0.0)); fragColor = u_mode == 0 ? blurColor(values.x, values.y, values.z) : areasColor(values.x, values.y, values.z); }`
  ].join('\n');
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Scalar weather shader linking failed.');
  return {
    program,
    locations: Object.fromEntries(['a_position', 'a_values0', 'a_values1', 'u_temporalProgress', 'u_mode', 'u_rainThresholds', 'u_rainThresholdLast', 'u_stormThreshold', 'u_hailThreshold', 'u_matrix', 'u_projection_fallback_matrix', 'u_projection_matrix', 'u_projection_tile_mercator_coords', 'u_projection_clipping_plane', 'u_projection_transition'].map((name) => [name, name.startsWith('a_') ? gl.getAttribLocation(program, name) : gl.getUniformLocation(program, name)]))
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
    this.valuesDirty = true;
    this.programs = new Map();
  }

  onAdd(map, gl) {
    this.map = map;
    this.positionBuffer = gl.createBuffer();
    this.indexBuffer = gl.createBuffer();
    this.valueBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.lattice.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.lattice.indices, gl.STATIC_DRAW);
    if (!this.temporal) this.rebuildTemporal(0);
  }

  onRemove(map, gl) {
    for (const entry of this.programs.values()) gl.deleteProgram(entry.program);
    for (const buffer of [this.positionBuffer, this.indexBuffer, this.valueBuffer]) if (buffer) gl.deleteBuffer(buffer);
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

  rebuildValues() {
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
        this.rebuildValues();
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
    const { program, locations } = this.programFor(gl, args.shaderData);
    gl.useProgram(program);
    setProjection(gl, {
      matrix: locations.u_matrix, fallbackMatrix: locations.u_projection_fallback_matrix, projectionMatrix: locations.u_projection_matrix,
      tileMercatorCoords: locations.u_projection_tile_mercator_coords, clippingPlane: locations.u_projection_clipping_plane, projectionTransition: locations.u_projection_transition
    }, args.defaultProjectionData);
    gl.uniform1f(locations.u_temporalProgress, this.temporalProgress);
    gl.uniform1i(locations.u_mode, this.mode === 'areas' ? 1 : 0);
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
  }
}
