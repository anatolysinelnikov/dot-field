import { geographicIntensityAt } from './geography.js';
import { HAZARD_ANALYSIS_LEVEL, groupNativeSamplesByDisplaySample, selectMercatorGridSamples } from './geographic-lod.js';
import { intensityToRadius, strongPrecipitationIntensity } from './precipitation-mapping.js';
import { hazardStateAppearance } from './hazard-renderer.js';
import { resolveHazardState } from './lod.js';

const COLORS = {
  rain: [0, 0.565, 1, 1],
  strong: [0, 0, 1, 1],
  storm: [1, 0, 1, 1],
  hail: [1, 0.831, 0, 1]
};

const QUAD = new Float32Array([
  -1, -1, 1, -1, 1, 1,
  -1, -1, 1, 1, -1, 1
]);

function circularPoints(count) {
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / count;
    return [Math.cos(angle), Math.sin(angle)];
  });
}

const HAIL = circularPoints(6);
const STORM = circularPoints(8).map((point, index) => {
  const scale = index % 2 === 0 ? 1 : 0.38;
  return [point[0] * scale, point[1] * scale];
});
const HAZARD_PROBES = selectMercatorGridSamples(HAZARD_ANALYSIS_LEVEL).samples;

function appendShape(vertices, centerX, centerY, radius, points) {
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    vertices.push(
      centerX, centerY,
      centerX + current[0] * radius, centerY + current[1] * radius,
      centerX + next[0] * radius, centerY + next[1] * radius
    );
  }
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'Weather shader compilation failed.');
  return shader;
}

function makeProgram(gl, shaderData, kind) {
  const circle = kind === 'circle';
  const vertexSource = `#version 300 es
${shaderData.vertexShaderPrelude}
${shaderData.define}
${circle ? `in vec2 a_corner;
in vec2 a_center;
in float a_radius;
out vec2 v_local;
void main() {
  v_local = a_corner;
  gl_Position = projectTile(a_center + a_corner * a_radius);
}` : `in vec2 a_pos;
void main() { gl_Position = projectTile(a_pos); }`}`;
  const fragmentSource = `#version 300 es
precision highp float;
uniform vec4 u_color;
${circle ? 'in vec2 v_local;' : ''}
out vec4 fragColor;
void main() {
  ${circle ? `float distanceToCenter = length(v_local);
  float edge = fwidth(distanceToCenter);
  float alpha = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, distanceToCenter);
  fragColor = vec4(u_color.rgb, u_color.a * alpha);` : 'fragColor = u_color;'}
}`;
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Weather shader linking failed.');
  return program;
}

function setMatrix(gl, program, name, value) {
  const location = gl.getUniformLocation(program, name);
  if (location && value) gl.uniformMatrix4fv(location, false, value);
}

function setProjection(gl, program, projection) {
  setMatrix(gl, program, 'u_matrix', projection.mainMatrix);
  setMatrix(gl, program, 'u_projection_fallback_matrix', projection.fallbackMatrix);
  setMatrix(gl, program, 'u_projection_matrix', projection.mainMatrix);
  const tileCoordinates = gl.getUniformLocation(program, 'u_projection_tile_mercator_coords');
  if (tileCoordinates) gl.uniform4f(tileCoordinates, ...projection.tileMercatorCoords);
  const clippingPlane = gl.getUniformLocation(program, 'u_projection_clipping_plane');
  if (clippingPlane && projection.clippingPlane) gl.uniform4f(clippingPlane, ...projection.clippingPlane);
  const transition = gl.getUniformLocation(program, 'u_projection_transition');
  if (transition) gl.uniform1f(transition, projection.projectionTransition);
}

export class GeographicDotsLayer {
  constructor() {
    this.id = 'geographic-weather-dots';
    this.type = 'custom';
    this.renderingMode = '3d';
    this.programs = new Map();
    this.geometry = { storm: new Float32Array(), hail: new Float32Array() };
    this.instances = { rain: new Float32Array(), strong: new Float32Array() };
    this.counts = { rain: 0, strong: 0, storm: 0, hail: 0 };
    this.samples = [];
    this.hazardGroups = new Map();
    this.buffersDirty = true;
  }

  onAdd(map, gl) {
    this.map = map;
    this.gl = gl;
    this.buffers = Object.fromEntries(Object.keys(this.geometry).map((key) => [key, gl.createBuffer()]));
    this.instanceBuffers = Object.fromEntries(Object.keys(this.instances).map((key) => [key, gl.createBuffer()]));
    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
  }

  onRemove(map, gl) {
    for (const entry of this.programs.values()) {
      gl.deleteProgram(entry.circle);
      gl.deleteProgram(entry.polygon);
    }
    for (const buffer of [...Object.values(this.buffers || {}), ...Object.values(this.instanceBuffers || {}), this.quadBuffer]) {
      if (buffer) gl.deleteBuffer(buffer);
    }
  }

  setSamples(samples, time) {
    this.samples = samples;
    this.hazardGroups = groupNativeSamplesByDisplaySample(samples, HAZARD_PROBES);
    this.updateWeather(time);
  }

  aggregateHazards(time) {
    const aggregated = new Map();
    for (const [sampleId, probes] of this.hazardGroups) {
      let storm = 0;
      let hail = 0;
      for (const probe of probes) {
        const [longitude, latitude] = probe.lngLat;
        const value = geographicIntensityAt(longitude, latitude, time);
        const state = resolveHazardState(value);
        if (state > 3) hail = Math.max(hail, value.hail);
        else if (state > 0) storm = Math.max(storm, value.storm);
      }
      if (hail > 0 || storm > 0) aggregated.set(sampleId, { rain: 0, storm, hail });
    }
    return aggregated;
  }

  updateWeather(time) {
    const instances = { rain: [], strong: [] };
    const vertices = { storm: [], hail: [] };
    const hazards = this.aggregateHazards(time);
    for (const sample of this.samples) {
      const [longitude, latitude] = sample.lngLat;
      const [centerX, centerY] = sample.mercator;
      const value = geographicIntensityAt(longitude, latitude, time);
      const rainRadius = intensityToRadius(value.rain, sample.spacing, 'rain');
      if (rainRadius > 0) instances.rain.push(centerX, centerY, rainRadius);
      const strongRadius = intensityToRadius(strongPrecipitationIntensity(value.rain), sample.spacing, 'rain');
      if (strongRadius > 0) instances.strong.push(centerX, centerY, strongRadius);
      const hazardValue = hazards.get(sample.id) || { rain: 0, storm: 0, hail: 0 };
      const appearance = hazardStateAppearance(hazardValue, resolveHazardState(hazardValue), sample.spacing);
      if (appearance.radius > 0) appendShape(vertices[appearance.type], centerX, centerY, appearance.radius, appearance.type === 'hail' ? HAIL : STORM);
    }
    for (const key of Object.keys(instances)) {
      this.instances[key] = new Float32Array(instances[key]);
      this.counts[key] = this.instances[key].length / 3;
    }
    for (const key of Object.keys(vertices)) {
      this.geometry[key] = new Float32Array(vertices[key]);
      this.counts[key] = this.geometry[key].length / 2;
    }
    this.buffersDirty = true;
    this.map?.triggerRepaint();
  }

  uploadBuffers(gl) {
    if (!this.buffersDirty || !this.buffers) return;
    for (const key of Object.keys(this.geometry)) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[key]);
      gl.bufferData(gl.ARRAY_BUFFER, this.geometry[key], gl.STREAM_DRAW);
    }
    for (const key of Object.keys(this.instances)) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffers[key]);
      gl.bufferData(gl.ARRAY_BUFFER, this.instances[key], gl.STREAM_DRAW);
    }
    this.buffersDirty = false;
  }

  programsFor(gl, shaderData) {
    let programs = this.programs.get(shaderData.variantName);
    if (!programs) {
      programs = { circle: makeProgram(gl, shaderData, 'circle'), polygon: makeProgram(gl, shaderData, 'polygon') };
      this.programs.set(shaderData.variantName, programs);
    }
    return programs;
  }

  renderCircles(gl, program, projection) {
    const corner = gl.getAttribLocation(program, 'a_corner');
    const center = gl.getAttribLocation(program, 'a_center');
    const radius = gl.getAttribLocation(program, 'a_radius');
    const color = gl.getUniformLocation(program, 'u_color');
    gl.useProgram(program);
    setProjection(gl, program, projection);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
    for (const key of Object.keys(this.instances)) {
      if (!this.counts[key]) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffers[key]);
      gl.enableVertexAttribArray(center);
      gl.vertexAttribPointer(center, 2, gl.FLOAT, false, 12, 0);
      gl.vertexAttribDivisor(center, 1);
      gl.enableVertexAttribArray(radius);
      gl.vertexAttribPointer(radius, 1, gl.FLOAT, false, 12, 8);
      gl.vertexAttribDivisor(radius, 1);
      gl.uniform4fv(color, COLORS[key]);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.counts[key]);
    }
    gl.vertexAttribDivisor(center, 0);
    gl.vertexAttribDivisor(radius, 0);
  }

  renderPolygons(gl, program, projection) {
    const position = gl.getAttribLocation(program, 'a_pos');
    const color = gl.getUniformLocation(program, 'u_color');
    gl.useProgram(program);
    setProjection(gl, program, projection);
    for (const key of Object.keys(this.geometry)) {
      if (!this.counts[key]) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[key]);
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.uniform4fv(color, COLORS[key]);
      gl.drawArrays(gl.TRIANGLES, 0, this.counts[key]);
    }
  }

  render(gl, args) {
    this.uploadBuffers(gl);
    const programs = this.programsFor(gl, args.shaderData);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -1);
    this.renderCircles(gl, programs.circle, args.defaultProjectionData);
    this.renderPolygons(gl, programs.polygon, args.defaultProjectionData);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true);
  }
}
