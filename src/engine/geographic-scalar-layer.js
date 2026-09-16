import { createAreasReconstructionWorkspace, reconstructAreasChannel } from './areas-reconstruction.js';
import { geographicTemporalFrameAt, setGeographicProjection, TEMPORAL_FRAME_COUNT } from './geographic-layer-utils.js';
import { AREA_RAIN_THRESHOLDS, GeographicScalarLattice } from './geographic-scalar-lattice.js';

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'Scalar rain shader compilation failed.');
  return shader;
}

function makeProgram(gl, shaderData) {
  const vertexSource = [
    '#version 300 es', shaderData.vertexShaderPrelude, shaderData.define,
    'in vec2 a_position;\nout vec2 v_mercator;\nvoid main() {\n  v_mercator = a_position;\n  gl_Position = projectTile(a_position);\n}'
  ].join('\n');
  const fragmentSource = [
    '#version 300 es', 'precision highp float;',
    'in vec2 v_mercator;\nuniform float u_temporalProgress;\nuniform sampler2D u_valuesTexture0;\nuniform sampler2D u_valuesTexture1;\nuniform vec2 u_latticeOrigin;\nuniform float u_latticeSpacing;\nuniform ivec2 u_latticeSize;\nuniform vec4 u_rainThresholds;\nuniform float u_rainThresholdLast;\nout vec4 fragColor;',
    `float bilinearRain(sampler2D rainTexture, vec2 mercatorPosition) {
  vec2 maximum = vec2(u_latticeSize - ivec2(1));
  vec2 grid = clamp((mercatorPosition - u_latticeOrigin) / u_latticeSpacing, vec2(0.0), maximum);
  ivec2 low = ivec2(min(floor(grid), maximum - vec2(1.0)));
  ivec2 high = low + ivec2(1);
  vec2 fraction = grid - vec2(low);
  float top = mix(texelFetch(rainTexture, low, 0).r, texelFetch(rainTexture, ivec2(high.x, low.y), 0).r, fraction.x);
  float bottom = mix(texelFetch(rainTexture, ivec2(low.x, high.y), 0).r, texelFetch(rainTexture, high, 0).r, fraction.x);
  return mix(top, bottom, fraction.y);
}
float soften(float edge, float value) { float width = max(fwidth(value) * 1.25, 0.00001); return smoothstep(edge - width, edge + width, value); }
vec4 areasColor(float rain) {
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
  float rain = max(mix(bilinearRain(u_valuesTexture0, v_mercator), bilinearRain(u_valuesTexture1, v_mercator), u_temporalProgress), 0.0);
  fragColor = areasColor(rain);
}`
  ].join('\n');
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Scalar rain shader linking failed.');
  const names = [
    'a_position', 'u_temporalProgress', 'u_valuesTexture0', 'u_valuesTexture1', 'u_latticeOrigin', 'u_latticeSpacing',
    'u_latticeSize', 'u_rainThresholds', 'u_rainThresholdLast', 'u_matrix', 'u_projection_fallback_matrix',
    'u_projection_matrix', 'u_projection_tile_mercator_coords', 'u_projection_clipping_plane', 'u_projection_transition'
  ];
  return {
    program,
    locations: Object.fromEntries(names.map((name) => [name, name === 'a_position' ? gl.getAttribLocation(program, name) : gl.getUniformLocation(program, name)]))
  };
}

export class GeographicScalarLayer {
  constructor() {
    this.id = 'geographic-weather-scalar';
    this.type = 'custom';
    this.renderingMode = '3d';
    this.lattice = new GeographicScalarLattice();
    this.active = false;
    this.temporal = null;
    this.temporalProgress = 0;
    this.areaReconstruction = null;
    this.textureValues0 = null;
    this.textureValues1 = null;
    this.texturesDirty = [false, false];
    this.interpolatedThresholds = new Float32Array(4);
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
    for (const buffer of [this.positionBuffer, this.indexBuffer]) if (buffer) gl.deleteBuffer(buffer);
    for (const texture of this.valueTextures || []) if (texture) gl.deleteTexture(texture);
  }

  setActive(active) {
    this.active = active;
    this.map?.triggerRepaint();
  }

  rebuildTemporal(time, options) {
    const frame = geographicTemporalFrameAt(time, options);
    this.temporal = {
      index: frame.index,
      nextIndex: frame.nextIndex,
      terminal: frame.terminal,
      state0: this.lattice.evaluate(frame.index / TEMPORAL_FRAME_COUNT),
      state1: this.lattice.evaluate(frame.terminal ? 1 : frame.nextIndex / TEMPORAL_FRAME_COUNT)
    };
    this.temporalProgress = frame.progress;
    this.prepareRainValues();
  }

  ensureReconstruction() {
    if (this.areaReconstruction) return;
    this.areaReconstruction = createAreasReconstructionWorkspace(this.lattice.width, this.lattice.height);
    const length = this.areaReconstruction.width * this.areaReconstruction.height;
    this.textureValues0 = new Float32Array(length);
    this.textureValues1 = new Float32Array(length);
  }

  ensureTextures(gl) {
    if (this.valueTextures) return;
    this.valueTextures = [gl.createTexture(), gl.createTexture()];
    for (const texture of this.valueTextures) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, this.areaReconstruction.width, this.areaReconstruction.height);
    }
  }

  prepareRainValues(reusePreviousState = false) {
    if (!this.temporal) return;
    this.lattice.ensureSmooth(this.temporal.state0);
    this.lattice.ensureSmooth(this.temporal.state1);
    this.ensureReconstruction();
    if (reusePreviousState) this.advanceRainTextureValues(this.temporal.state1);
    else this.rebuildRainTextureValues(this.temporal.state0, this.temporal.state1);
  }

  rebuildRainTextureValues(state0, state1) {
    reconstructAreasChannel(state0.smooth.rain, this.areaReconstruction, this.textureValues0, 0, 1);
    reconstructAreasChannel(state1.smooth.rain, this.areaReconstruction, this.textureValues1, 0, 1);
    this.texturesDirty[0] = true;
    this.texturesDirty[1] = true;
  }

  advanceRainTextureValues(state1) {
    [this.textureValues0, this.textureValues1] = [this.textureValues1, this.textureValues0];
    if (this.valueTextures) [this.valueTextures[0], this.valueTextures[1]] = [this.valueTextures[1], this.valueTextures[0]];
    this.texturesDirty[0] = this.texturesDirty[1];
    reconstructAreasChannel(state1.smooth.rain, this.areaReconstruction, this.textureValues1, 0, 1);
    this.texturesDirty[1] = true;
  }

  uploadTextures(gl) {
    if (!this.valueTextures) return;
    for (let index = 0; index < this.valueTextures.length; index++) {
      if (!this.texturesDirty[index]) continue;
      gl.bindTexture(gl.TEXTURE_2D, this.valueTextures[index]);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.areaReconstruction.width, this.areaReconstruction.height, gl.RED, gl.FLOAT,
        index === 0 ? this.textureValues0 : this.textureValues1);
      this.texturesDirty[index] = false;
    }
  }

  updateWeather(time, options) {
    const frame = geographicTemporalFrameAt(time, options);
    if (!this.temporal || frame.index !== this.temporal.index || frame.terminal !== this.temporal.terminal) {
      if (!frame.terminal && this.temporal && frame.index === this.temporal.nextIndex) {
        const reusable = this.temporal.state0;
        this.temporal.index = frame.index;
        this.temporal.nextIndex = frame.nextIndex;
        this.temporal.terminal = false;
        this.temporal.state0 = this.temporal.state1;
        this.temporal.state1 = this.lattice.evaluate(this.temporal.nextIndex / TEMPORAL_FRAME_COUNT, reusable);
        this.prepareRainValues(true);
      } else this.rebuildTemporal(time, options);
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
    this.ensureTextures(gl);
    this.uploadTextures(gl);
    const { program, locations } = this.programFor(gl, args.shaderData);
    gl.useProgram(program);
    setGeographicProjection(gl, {
      matrix: locations.u_matrix, fallbackMatrix: locations.u_projection_fallback_matrix, projectionMatrix: locations.u_projection_matrix,
      tileMercatorCoords: locations.u_projection_tile_mercator_coords, clippingPlane: locations.u_projection_clipping_plane, projectionTransition: locations.u_projection_transition
    }, args.defaultProjectionData);
    gl.uniform1f(locations.u_temporalProgress, this.temporalProgress);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.valueTextures[0]);
    gl.uniform1i(locations.u_valuesTexture0, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.valueTextures[1]);
    gl.uniform1i(locations.u_valuesTexture1, 1);
    gl.uniform2fv(locations.u_latticeOrigin, this.lattice.origin);
    gl.uniform1f(locations.u_latticeSpacing, this.lattice.spacing / this.areaReconstruction.subdivisions);
    gl.uniform2i(locations.u_latticeSize, this.areaReconstruction.width, this.areaReconstruction.height);
    const thresholds0 = this.temporal.state0.rainThresholds;
    const thresholds1 = this.temporal.state1.rainThresholds;
    for (let index = 0; index < this.interpolatedThresholds.length; index++) {
      this.interpolatedThresholds[index] = thresholds0[index] + (thresholds1[index] - thresholds0[index]) * this.temporalProgress;
    }
    gl.uniform4fv(locations.u_rainThresholds, this.interpolatedThresholds);
    gl.uniform1f(locations.u_rainThresholdLast, thresholds0[4] + (thresholds1[4] - thresholds0[4]) * this.temporalProgress);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.enableVertexAttribArray(locations.a_position);
    gl.vertexAttribPointer(locations.a_position, 2, gl.FLOAT, false, 0, 0);
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
    gl.activeTexture(gl.TEXTURE0);
  }
}
