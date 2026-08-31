import {
  RAIN_BASE_RADIUS_ANCHORS
} from './config.js';
import {
  DOTS_STRONG_RAIN_FULL_MMH,
  DOTS_STRONG_RAIN_ONSET_MMH,
  DOTS_STRONG_RAIN_SHAPE_ANCHORS
} from './precipitation-mapping.js';

// Stable GPU weather covers the direct physical levels and the validated
// recursive physical-summary levels. LOD morphs still use the CPU path.
export const GPU_WEATHER_LEVELS = Object.freeze([10, 11, 12, 13, 14]);
// Bounded endpoint set for the future GPU-owned stationary LOD transition.
// This is intentionally not a generic GPU LOD pyramid.
export const GPU_WEATHER_TRANSITION_READY_PRESENTATION_LEVELS = Object.freeze({
  10: Object.freeze([10, 11]),
  11: Object.freeze([10, 11, 12]),
  12: Object.freeze([11, 12, 13]),
  13: Object.freeze([12, 13]),
  14: Object.freeze([14])
});
export function gpuWeatherTransitionReadyPresentationLevels(level) {
  return GPU_WEATHER_TRANSITION_READY_PRESENTATION_LEVELS[level] || [];
}
export function isGpuWeatherLevel(level) {
  return GPU_WEATHER_LEVELS.includes(level);
}

function number(value) {
  return Number(value).toFixed(6);
}

function squaredRadiusTransfer(name, anchors) {
  const lines = [`float ${name}(float value) {`];
  lines.push(`  if (value <= ${number(anchors[0].mmh)}) return ${number(anchors[0].radius)};`);
  for (let index = 1; index < anchors.length; index++) {
    const lower = anchors[index - 1];
    const upper = anchors[index];
    lines.push(`  if (value <= ${number(upper.mmh)}) { float t = (value - ${number(lower.mmh)}) / ${number(upper.mmh - lower.mmh)}; return sqrt(mix(${number(lower.radius * lower.radius)}, ${number(upper.radius * upper.radius)}, clamp(t, 0.0, 1.0))); }`);
  }
  lines.push(`  return ${number(anchors.at(-1).radius)};`);
  lines.push('}');
  return lines.join('\n');
}

const DOTS_STRONG_TRANSFER = (() => {
  const lines = [`float dotsStrongRadiusFraction(float value) {`];
  lines.push(`  if (value <= ${number(DOTS_STRONG_RAIN_ONSET_MMH)}) return 0.0;`);
  lines.push(`  if (value >= ${number(DOTS_STRONG_RAIN_FULL_MMH)}) return ${number(DOTS_STRONG_RAIN_SHAPE_ANCHORS.at(-1).radius)};`);
  for (let index = 1; index < DOTS_STRONG_RAIN_SHAPE_ANCHORS.length; index++) {
    const lower = DOTS_STRONG_RAIN_SHAPE_ANCHORS[index - 1];
    const upper = DOTS_STRONG_RAIN_SHAPE_ANCHORS[index];
    lines.push(`  if (value <= ${number(DOTS_STRONG_RAIN_ONSET_MMH + (DOTS_STRONG_RAIN_FULL_MMH - DOTS_STRONG_RAIN_ONSET_MMH) * upper.progress)}) { float t = (value - ${number(DOTS_STRONG_RAIN_ONSET_MMH + (DOTS_STRONG_RAIN_FULL_MMH - DOTS_STRONG_RAIN_ONSET_MMH) * lower.progress)}) / ${number((upper.progress - lower.progress) * (DOTS_STRONG_RAIN_FULL_MMH - DOTS_STRONG_RAIN_ONSET_MMH))}; return sqrt(mix(${number(lower.radius * lower.radius)}, ${number(upper.radius * upper.radius)}, clamp(t, 0.0, 1.0))); }`);
  }
  lines.push(`  return ${number(DOTS_STRONG_RAIN_SHAPE_ANCHORS.at(-1).radius)};`);
  lines.push('}');
  return lines.join('\n');
})();

export const GPU_DOTS_RAIN_MAPPING_SHADER = [
  squaredRadiusTransfer('rainRadiusFraction', RAIN_BASE_RADIUS_ANCHORS),
  DOTS_STRONG_TRANSFER
].join('\n');

export const GPU_SQUARES_RAIN_MAPPING_SHADER = [
  `float rainVisibility(float value) {\n  if (value <= ${number(RAIN_BASE_RADIUS_ANCHORS[0].mmh)}) return 0.0;`,
  ...RAIN_BASE_RADIUS_ANCHORS.slice(1).map((upper, index) => {
    const lower = RAIN_BASE_RADIUS_ANCHORS[index];
    const maximum = RAIN_BASE_RADIUS_ANCHORS.at(-1).radius;
    return `  if (value <= ${number(upper.mmh)}) { float t = (value - ${number(lower.mmh)}) / ${number(upper.mmh - lower.mmh)}; return sqrt(mix(${number(lower.radius * lower.radius)}, ${number(upper.radius * upper.radius)}, clamp(t, 0.0, 1.0))) / ${number(maximum)}; }`;
  }),
  `  return 1.0;\n}`
].join('\n');

export function compileGpuWeatherShader(gl, type, source, label) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || `${label} shader compilation failed.`);
  }
  return shader;
}

export function createGpuWeatherProgram(gl, shaderData, vertexBody, fragmentBody, label) {
  const program = gl.createProgram();
  gl.attachShader(program, compileGpuWeatherShader(gl, gl.VERTEX_SHADER, [
    '#version 300 es', shaderData.vertexShaderPrelude, shaderData.define, vertexBody
  ].join('\n'), label));
  gl.attachShader(program, compileGpuWeatherShader(gl, gl.FRAGMENT_SHADER, [
    '#version 300 es', 'precision highp float;', 'precision highp int;', fragmentBody
  ].join('\n'), label));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || `${label} program linking failed.`);
  }
  return program;
}

export function gpuWeatherProjectionLocations(gl, program) {
  return {
    matrix: gl.getUniformLocation(program, 'u_matrix'),
    fallbackMatrix: gl.getUniformLocation(program, 'u_projection_fallback_matrix'),
    projectionMatrix: gl.getUniformLocation(program, 'u_projection_matrix'),
    tileMercatorCoords: gl.getUniformLocation(program, 'u_projection_tile_mercator_coords'),
    clippingPlane: gl.getUniformLocation(program, 'u_projection_clipping_plane'),
    projectionTransition: gl.getUniformLocation(program, 'u_projection_transition')
  };
}

export const GPU_WEATHER_COMMON_VERTEX = `
in vec2 a_vertex;
uniform sampler2D u_weather_a;
uniform sampler2D u_weather_b;
uniform sampler2D u_weather_coverage_a;
uniform sampler2D u_weather_coverage_b;
uniform float u_weather_progress;
uniform int u_weather_kind;
uniform int u_width;
uniform int u_minI;
uniform int u_minJ;
uniform float u_spacing;
vec4 gpuWeatherRecord(ivec2 coordinate, bool second) {
  vec4 values;
  vec2 coverageWeights = vec2(0.0);
  if (second) {
    values = texelFetch(u_weather_b, coordinate, 0);
    if (u_weather_kind != 0) coverageWeights = texelFetch(u_weather_coverage_b, coordinate, 0).rg;
  } else {
    values = texelFetch(u_weather_a, coordinate, 0);
    if (u_weather_kind != 0) coverageWeights = texelFetch(u_weather_coverage_a, coordinate, 0).rg;
  }
  if (u_weather_kind == 0) return vec4(values.r, 1.0, values.r, step(2.5, values.r));
  float totalWeight = values.b;
  float wetMean = coverageWeights.x > 0.0 ? values.r / coverageWeights.x : 0.0;
  float wetCoverage = totalWeight > 0.0 ? coverageWeights.x / totalWeight : 0.0;
  float strongCoverage = totalWeight > 0.0 ? coverageWeights.y / totalWeight : 0.0;
  return vec4(wetMean, wetCoverage, values.g, strongCoverage);
}
vec4 gpuWeatherAt(out int sampleIndex) {
  sampleIndex = gl_InstanceID;
  int column = sampleIndex % u_width;
  int row = sampleIndex / u_width;
  ivec2 coordinate = ivec2(column, row);
  return mix(
    gpuWeatherRecord(coordinate, false),
    gpuWeatherRecord(coordinate, true),
    u_weather_progress
  );
}
float gpuRainAt(out int sampleIndex) { return gpuWeatherAt(sampleIndex).x; }
vec2 gpuWeatherCenter(int sampleIndex) {
  int column = sampleIndex % u_width;
  int row = sampleIndex / u_width;
  return vec2(float(u_minI + column), float(u_minJ + row)) * u_spacing;
}`;
