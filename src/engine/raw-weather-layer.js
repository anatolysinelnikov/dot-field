import { lngLatToMercator } from './geographic-lod.js';
import { setGeographicProjection } from './geographic-layer-utils.js';

const PRECIPITATION_COLOR_ANCHORS = Object.freeze([
  { mmh: 0.001, lightness: 0.98, hue: 220 },
  { mmh: 0.01, lightness: 0.93, hue: 225 },
  { mmh: 0.1, lightness: 0.84, hue: 232 },
  { mmh: 1, lightness: 0.70, hue: 242 },
  { mmh: 4, lightness: 0.58, hue: 248 },
  { mmh: 10, lightness: 0.46, hue: 252 },
  { mmh: 25, lightness: 0.34, hue: 257 },
  { mmh: 50, lightness: 0.22, hue: 262 }
]);
const MIN_PRECIPITATION_COLOR_ANCHOR = PRECIPITATION_COLOR_ANCHORS[0].mmh;
const MAX_PRECIPITATION_COLOR_ANCHOR = PRECIPITATION_COLOR_ANCHORS[PRECIPITATION_COLOR_ANCHORS.length - 1].mmh;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function oklchToLinearSrgb(lightness, chroma, hue) {
  const radians = hue * Math.PI / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541725 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const red = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const green = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const blue = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [red, green, blue];
}

function oklchToSrgb(lightness, chroma, hue) {
  const [red, green, blue] = oklchToLinearSrgb(lightness, chroma, hue);
  const toSrgb = (value) => {
    const clamped = clamp(value, 0, 1);
    return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
  };
  return [toSrgb(red), toSrgb(green), toSrgb(blue), 1];
}

function isInSrgbGamut(lightness, chroma, hue) {
  const [red, green, blue] = oklchToLinearSrgb(lightness, chroma, hue);
  return red >= 0 && red <= 1 && green >= 0 && green <= 1 && blue >= 0 && blue <= 1;
}

function maximumInGamutChroma(lightness, hue) {
  let lower = 0;
  let upper = 0.5;
  while (isInSrgbGamut(lightness, upper, hue) && upper < 2) upper *= 2;
  for (let iteration = 0; iteration < 24; iteration++) {
    const midpoint = (lower + upper) / 2;
    if (isInSrgbGamut(lightness, midpoint, hue)) lower = midpoint;
    else upper = midpoint;
  }
  return lower;
}

function precipitationColor(mmh) {
  const value = clamp(mmh, MIN_PRECIPITATION_COLOR_ANCHOR, MAX_PRECIPITATION_COLOR_ANCHOR);
  let upperIndex = 1;
  while (upperIndex < PRECIPITATION_COLOR_ANCHORS.length && value > PRECIPITATION_COLOR_ANCHORS[upperIndex].mmh) upperIndex += 1;
  const lower = PRECIPITATION_COLOR_ANCHORS[upperIndex - 1];
  const upper = PRECIPITATION_COLOR_ANCHORS[upperIndex] || lower;
  const t = upper === lower ? 0 : (Math.log10(value) - Math.log10(lower.mmh)) / (Math.log10(upper.mmh) - Math.log10(lower.mmh));
  const lightness = lower.lightness + (upper.lightness - lower.lightness) * t;
  const hue = lower.hue + (upper.hue - lower.hue) * t;
  return oklchToSrgb(
    lightness,
    maximumInGamutChroma(lightness, hue),
    hue
  );
}
const THUNDERSTORM_COLORS = Object.freeze({
  10: [138 / 255, 77 / 255, 1, 1],
  11: [192 / 255, 0, 1, 1],
  12: [1, 0, 1, 1]
});
const HAIL_COLORS = Object.freeze({
  16: [200 / 255, 154 / 255, 0, 1],
  17: [240 / 255, 192 / 255, 0, 1],
  18: [1, 212 / 255, 0, 1]
});

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'RAW weather shader compilation failed.');
  return shader;
}

function makeProgram(gl, shaderData, vertexColors = false) {
  const vertexSource = [
    '#version 300 es',
    shaderData.vertexShaderPrelude,
    shaderData.define,
    vertexColors
      ? 'in vec2 a_position;\nin vec4 a_color;\nout vec4 v_color;\nvoid main() { v_color = a_color; gl_Position = projectTile(a_position); }'
      : 'in vec2 a_position;\nvoid main() { gl_Position = projectTile(a_position); }'
  ].join('\n');
  const fragmentSource = [
    '#version 300 es',
    'precision highp float;',
    vertexColors ? 'in vec4 v_color;' : 'uniform vec4 u_color;',
    'out vec4 fragColor;',
    `void main() { fragColor = ${vertexColors ? 'v_color' : 'u_color'}; }`
  ].join('\n');
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'RAW weather shader linking failed.');
  return {
    program,
    position: gl.getAttribLocation(program, 'a_position'),
    vertexColor: vertexColors ? gl.getAttribLocation(program, 'a_color') : -1,
    color: gl.getUniformLocation(program, 'u_color'),
    matrix: gl.getUniformLocation(program, 'u_matrix'),
    fallbackMatrix: gl.getUniformLocation(program, 'u_projection_fallback_matrix'),
    projectionMatrix: gl.getUniformLocation(program, 'u_projection_matrix'),
    tileMercatorCoords: gl.getUniformLocation(program, 'u_projection_tile_mercator_coords'),
    clippingPlane: gl.getUniformLocation(program, 'u_projection_clipping_plane'),
    projectionTransition: gl.getUniformLocation(program, 'u_projection_transition')
  };
}

function addCell(vertices, west, east, south, north, insetWest = 0, insetEast = 1, insetSouth = 0, insetNorth = 1) {
  const cellWest = west + (east - west) * insetWest;
  const cellEast = west + (east - west) * insetEast;
  const cellSouth = south + (north - south) * insetSouth;
  const cellNorth = south + (north - south) * insetNorth;
  const southwest = lngLatToMercator(cellWest, cellSouth);
  const southeast = lngLatToMercator(cellEast, cellSouth);
  const northeast = lngLatToMercator(cellEast, cellNorth);
  const northwest = lngLatToMercator(cellWest, cellNorth);
  vertices.push(
    southwest[0], southwest[1], southeast[0], southeast[1], northeast[0], northeast[1],
    southwest[0], southwest[1], northeast[0], northeast[1], northwest[0], northwest[1]
  );
}

function addCellColor(colors, color) {
  for (let vertex = 0; vertex < 6; vertex++) colors.push(...color);
}

function cellOutline(field, cell) {
  const west = field.longitudeCellBounds[cell.longitudeIndex];
  const east = field.longitudeCellBounds[cell.longitudeIndex + 1];
  const south = field.latitudeCellBounds[cell.latitudeIndex];
  const north = field.latitudeCellBounds[cell.latitudeIndex + 1];
  const southwest = lngLatToMercator(west, south);
  const southeast = lngLatToMercator(east, south);
  const northeast = lngLatToMercator(east, north);
  const northwest = lngLatToMercator(west, north);
  return Float32Array.from([
    southwest[0], southwest[1], southeast[0], southeast[1],
    northeast[0], northeast[1], northwest[0], northwest[1]
  ]);
}

function buildGeometry(field) {
  const precipitationVertices = [];
  const precipitationColors = [];
  const thunderstorm = Object.fromEntries(Object.keys(THUNDERSTORM_COLORS).map((code) => [code, []]));
  const hail = Object.fromEntries(Object.keys(HAIL_COLORS).map((code) => [code, []]));
  const width = field.longitudes.length;
  for (let latitudeIndex = 0; latitudeIndex < field.latitudes.length; latitudeIndex++) {
    const south = field.latitudeCellBounds[latitudeIndex];
    const north = field.latitudeCellBounds[latitudeIndex + 1];
    for (let longitudeIndex = 0; longitudeIndex < width; longitudeIndex++) {
      const index = field.index(longitudeIndex, latitudeIndex);
      const west = field.longitudeCellBounds[longitudeIndex];
      const east = field.longitudeCellBounds[longitudeIndex + 1];
      const hasStorm = field.thunderstormCode[index] !== 0;
      const hasHail = field.hailCode[index] !== 0;
      const mmh = field.mmh[index];
      if (mmh > 0) {
        addCell(precipitationVertices, west, east, south, north);
        addCellColor(precipitationColors, precipitationColor(mmh));
      }
      if (hasStorm && thunderstorm[field.thunderstormCode[index]]) {
        const insetEast = hasHail ? 0.48 : 0.88;
        addCell(thunderstorm[field.thunderstormCode[index]], west, east, south, north, 0.12, insetEast, 0.12, 0.88);
      }
      if (hasHail && hail[field.hailCode[index]]) {
        const insetWest = hasStorm ? 0.52 : 0.12;
        addCell(hail[field.hailCode[index]], west, east, south, north, insetWest, 0.88, 0.12, 0.88);
      }
    }
  }
  return {
    precipitation: {
      vertices: Float32Array.from(precipitationVertices),
      colors: Float32Array.from(precipitationColors)
    },
    thunderstorm: Object.fromEntries(Object.entries(thunderstorm).map(([code, vertices]) => [code, Float32Array.from(vertices)])),
    hail: Object.fromEntries(Object.entries(hail).map(([code, vertices]) => [code, Float32Array.from(vertices)]))
  };
}

export class RawWeatherLayer {
  constructor(field) {
    this.id = 'geographic-weather-raw';
    this.type = 'custom';
    this.renderingMode = '3d';
    this.field = field;
    this.geometry = buildGeometry(field);
    this.active = false;
    this.phenomena = true;
    this.highlightedCell = null;
    this.programs = new Map();
  }

  onAdd(map, gl) {
    this.map = map;
    this.gl = gl;
    this.buffers = { precipitation: {}, thunderstorm: {}, hail: {} };
    this.buffers.precipitation.position = this.createBuffer(gl, this.geometry.precipitation.vertices);
    this.buffers.precipitation.color = this.createBuffer(gl, this.geometry.precipitation.colors);
    this.highlightBuffer = this.createBuffer(gl, new Float32Array());
    for (const [code, vertices] of Object.entries(this.geometry.thunderstorm)) this.buffers.thunderstorm[code] = this.createBuffer(gl, vertices);
    for (const [code, vertices] of Object.entries(this.geometry.hail)) this.buffers.hail[code] = this.createBuffer(gl, vertices);
  }

  createBuffer(gl, vertices) {
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    return buffer;
  }

  onRemove(map, gl) {
    for (const entry of this.programs.values()) gl.deleteProgram(entry.program);
    for (const buffer of Object.values(this.buffers?.precipitation || {})) gl.deleteBuffer(buffer);
    for (const buffer of Object.values(this.buffers?.thunderstorm || {})) gl.deleteBuffer(buffer);
    for (const buffer of Object.values(this.buffers?.hail || {})) gl.deleteBuffer(buffer);
    if (this.highlightBuffer) gl.deleteBuffer(this.highlightBuffer);
  }

  setActive(active) {
    this.active = active;
    this.map?.triggerRepaint();
  }

  setPhenomena(phenomena) {
    this.phenomena = phenomena;
    this.map?.triggerRepaint();
  }

  setHighlightedCell(cell) {
    this.highlightedCell = cell;
    if (this.gl && this.highlightBuffer) {
      const vertices = cell ? cellOutline(this.field, cell) : new Float32Array();
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.highlightBuffer);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, vertices, this.gl.DYNAMIC_DRAW);
    }
    this.map?.triggerRepaint();
  }

  programFor(gl, shaderData) {
    const key = `${shaderData.variantName}:solid`;
    let program = this.programs.get(key);
    if (!program) {
      program = makeProgram(gl, shaderData);
      this.programs.set(key, program);
    }
    return program;
  }

  colorProgramFor(gl, shaderData) {
    const key = `${shaderData.variantName}:vertex-color`;
    let program = this.programs.get(key);
    if (!program) {
      program = makeProgram(gl, shaderData, true);
      this.programs.set(key, program);
    }
    return program;
  }

  draw(gl, program, vertices, positionBuffer, color, projection, colorBuffer = null) {
    if (!vertices.length) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.enableVertexAttribArray(program.position);
    gl.vertexAttribPointer(program.position, 2, gl.FLOAT, false, 0, 0);
    if (colorBuffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
      gl.enableVertexAttribArray(program.vertexColor);
      gl.vertexAttribPointer(program.vertexColor, 4, gl.FLOAT, false, 0, 0);
    }
    setGeographicProjection(gl, {
      matrix: program.matrix,
      fallbackMatrix: program.fallbackMatrix,
      projectionMatrix: program.projectionMatrix,
      tileMercatorCoords: program.tileMercatorCoords,
      clippingPlane: program.clippingPlane,
      projectionTransition: program.projectionTransition
    }, projection);
    if (color) gl.uniform4f(program.color, ...color);
    gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 2);
    gl.disableVertexAttribArray(program.position);
    if (colorBuffer) gl.disableVertexAttribArray(program.vertexColor);
  }

  drawHighlight(gl, program, projection) {
    if (!this.highlightedCell || !this.highlightBuffer) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.highlightBuffer);
    gl.enableVertexAttribArray(program.position);
    gl.vertexAttribPointer(program.position, 2, gl.FLOAT, false, 0, 0);
    setGeographicProjection(gl, {
      matrix: program.matrix,
      fallbackMatrix: program.fallbackMatrix,
      projectionMatrix: program.projectionMatrix,
      tileMercatorCoords: program.tileMercatorCoords,
      clippingPlane: program.clippingPlane,
      projectionTransition: program.projectionTransition
    }, projection);
    gl.uniform4f(program.color, 1, 0, 0, 1);
    gl.lineWidth(2);
    gl.drawArrays(gl.LINE_LOOP, 0, 4);
    gl.disableVertexAttribArray(program.position);
  }

  render(gl, args) {
    if (!this.active) return;
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    const projection = args.defaultProjectionData;
    const precipitationProgram = this.colorProgramFor(gl, args.shaderData);
    gl.useProgram(precipitationProgram.program);
    this.draw(gl, precipitationProgram, this.geometry.precipitation.vertices, this.buffers.precipitation.position, null, projection, this.buffers.precipitation.color);
    if (this.phenomena) {
      const program = this.programFor(gl, args.shaderData);
      gl.useProgram(program.program);
      for (const [code, vertices] of Object.entries(this.geometry.thunderstorm)) {
        this.draw(gl, program, vertices, this.buffers.thunderstorm[code], THUNDERSTORM_COLORS[code], projection);
      }
      for (const [code, vertices] of Object.entries(this.geometry.hail)) {
        this.draw(gl, program, vertices, this.buffers.hail[code], HAIL_COLORS[code], projection);
      }
      this.drawHighlight(gl, program, projection);
    } else {
      const program = this.programFor(gl, args.shaderData);
      gl.useProgram(program.program);
      this.drawHighlight(gl, program, projection);
    }
  }
}
