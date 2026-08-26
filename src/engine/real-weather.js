import { clamp } from './math.js';

const THUNDERSTORM_LEVELS = Object.freeze({ 0: 0, 10: 0.2660123, 11: 0.4818750, 12: 0.6977377 });
const HAIL_LEVELS = Object.freeze({ 0: 0, 16: 0.2776807, 17: 0.4897500, 18: 0.7018193 });
const EXPECTED_COLUMNS = ['lon', 'lat', 'mmh', 'thunderstorm', 'hail'];
const REGULAR_SPACING_TOLERANCE = 2e-5;

function fail(message) {
  throw new Error(`Real weather CSV validation failed: ${message}`);
}

function parseNumber(value, row, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) fail(`row ${row} has an invalid ${name}.`);
  return number;
}

function validateRegularAxis(axis, name) {
  if (axis.length < 2) fail(`${name} axis must have at least two coordinates.`);
  const spacing = axis[1] - axis[0];
  if (!(spacing > 0)) fail(`${name} axis is not strictly increasing.`);
  for (let index = 2; index < axis.length; index++) {
    if (Math.abs((axis[index] - axis[index - 1]) - spacing) > REGULAR_SPACING_TOLERANCE) {
      fail(`${name} axis is not regular at index ${index}.`);
    }
  }
  return spacing;
}

function levelValue(levels, code, row, name) {
  if (!Object.hasOwn(levels, code)) fail(`row ${row} has an unsupported ${name} code ${code}.`);
  return levels[code];
}

export class RealWeatherField {
  constructor({ longitudes, latitudes, mmh, thunderstormCode, hailCode, rainMmh, storm, hail, sourceRowCount, longitudeSpacing, latitudeSpacing }) {
    this.longitudes = longitudes;
    this.latitudes = latitudes;
    this.mmh = mmh;
    this.thunderstormCode = thunderstormCode;
    this.hailCode = hailCode;
    this.rainMmh = rainMmh;
    this.storm = storm;
    this.hail = hail;
    this.sourceRowCount = sourceRowCount;
    this.longitudeSpacing = longitudeSpacing;
    this.latitudeSpacing = latitudeSpacing;
    this.bounds = Object.freeze({
      west: longitudes[0], east: longitudes[longitudes.length - 1],
      south: latitudes[0], north: latitudes[latitudes.length - 1]
    });
    this.longitudeCellBounds = makeCellBounds(longitudes, this.longitudeSpacing);
    this.latitudeCellBounds = makeCellBounds(latitudes, this.latitudeSpacing);
  }

  index(longitudeIndex, latitudeIndex) {
    return latitudeIndex * this.longitudes.length + longitudeIndex;
  }

  locateSourceCell(axisBounds, value) {
    if (value <= axisBounds[0]) return 0;
    if (value >= axisBounds[axisBounds.length - 1]) return axisBounds.length - 2;
    let low = 0;
    let high = axisBounds.length - 1;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (axisBounds[middle] <= value) low = middle;
      else high = middle;
    }
    return low;
  }

  rawCellAt(longitude, latitude) {
    if (longitude < this.longitudeCellBounds[0] || longitude > this.longitudeCellBounds[this.longitudeCellBounds.length - 1]
      || latitude < this.latitudeCellBounds[0] || latitude > this.latitudeCellBounds[this.latitudeCellBounds.length - 1]) return null;
    const longitudeIndex = this.locateSourceCell(this.longitudeCellBounds, longitude);
    const latitudeIndex = this.locateSourceCell(this.latitudeCellBounds, latitude);
    const index = this.index(longitudeIndex, latitudeIndex);
    return {
      index,
      longitudeIndex,
      latitudeIndex,
      lon: this.longitudes[longitudeIndex],
      lat: this.latitudes[latitudeIndex],
      mmh: this.mmh[index],
      thunderstorm: this.thunderstormCode[index],
      hail: this.hailCode[index]
    };
  }

  locate(axis, value) {
    if (value <= axis[0]) return { index: 0, fraction: 0 };
    if (value >= axis[axis.length - 1]) return { index: axis.length - 2, fraction: 1 };
    let low = 0;
    let high = axis.length - 1;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (axis[middle] <= value) low = middle;
      else high = middle;
    }
    return { index: low, fraction: (value - axis[low]) / (axis[low + 1] - axis[low]) };
  }

  sample(longitude, latitude, output = {}) {
    output.rainMmh = 0;
    output.storm = 0;
    output.hail = 0;
    if (longitude < this.bounds.west || longitude > this.bounds.east
      || latitude < this.bounds.south || latitude > this.bounds.north) return output;

    const x = this.locate(this.longitudes, longitude);
    const y = this.locate(this.latitudes, latitude);
    const x0y0 = this.index(x.index, y.index);
    const x1y0 = x0y0 + 1;
    const x0y1 = this.index(x.index, y.index + 1);
    const x1y1 = x0y1 + 1;
    const interpolate = (values, minimum = 0, maximum = 1) => {
      const lower = values[x0y0] + (values[x1y0] - values[x0y0]) * x.fraction;
      const upper = values[x0y1] + (values[x1y1] - values[x0y1]) * x.fraction;
      return clamp(lower + (upper - lower) * y.fraction, minimum, maximum);
    };
    output.rainMmh = interpolate(this.rainMmh, 0, Number.POSITIVE_INFINITY);
    output.storm = interpolate(this.storm);
    output.hail = interpolate(this.hail);
    return output;
  }
}

function makeCellBounds(axis, spacing) {
  const bounds = new Float64Array(axis.length + 1);
  bounds[0] = axis[0] - spacing / 2;
  for (let index = 1; index < axis.length; index++) bounds[index] = (axis[index - 1] + axis[index]) / 2;
  bounds[axis.length] = axis[axis.length - 1] + spacing / 2;
  return bounds;
}

export function parseRealWeatherCsv(csvText) {
  const lines = csvText.trim().split(/\r?\n/);
  if (!lines.length || lines[0].split(',').map((value) => value.trim()).join(',') !== EXPECTED_COLUMNS.join(',')) {
    fail(`expected columns ${EXPECTED_COLUMNS.join(',')}.`);
  }

  const rows = [];
  const longitudeSet = new Set();
  const latitudeSet = new Set();
  for (let lineIndex = 1; lineIndex < lines.length; lineIndex++) {
    const values = lines[lineIndex].split(',').map((value) => value.trim());
    if (values.length !== EXPECTED_COLUMNS.length) fail(`row ${lineIndex + 1} has ${values.length} columns.`);
    const lon = parseNumber(values[0], lineIndex + 1, 'longitude');
    const lat = parseNumber(values[1], lineIndex + 1, 'latitude');
    const mmh = parseNumber(values[2], lineIndex + 1, 'mmh');
    const thunderstorm = parseNumber(values[3], lineIndex + 1, 'thunderstorm');
    const hail = parseNumber(values[4], lineIndex + 1, 'hail');
    if (mmh < 0) fail(`row ${lineIndex + 1} has negative mmh.`);
    rows.push({ lon, lat, mmh, thunderstorm, hail });
    longitudeSet.add(lon);
    latitudeSet.add(lat);
  }

  const longitudes = Float64Array.from([...longitudeSet].sort((a, b) => a - b));
  const latitudes = Float64Array.from([...latitudeSet].sort((a, b) => a - b));
  const longitudeSpacing = validateRegularAxis(longitudes, 'longitude');
  const latitudeSpacing = validateRegularAxis(latitudes, 'latitude');
  const expectedRows = longitudes.length * latitudes.length;
  if (rows.length !== expectedRows) fail(`expected ${expectedRows} rows, received ${rows.length}.`);

  const size = expectedRows;
  const mmh = new Float64Array(size);
  const thunderstormCode = new Uint8Array(size);
  const hailCode = new Uint8Array(size);
  const storm = new Float32Array(size);
  const hail = new Float32Array(size);
  const occupied = new Uint8Array(size);
  const longitudeIndices = new Map(Array.from(longitudes, (value, index) => [value, index]));
  const latitudeIndices = new Map(Array.from(latitudes, (value, index) => [value, index]));
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    const longitudeIndex = longitudeIndices.get(row.lon);
    const latitudeIndex = latitudeIndices.get(row.lat);
    const index = latitudeIndex * longitudes.length + longitudeIndex;
    if (occupied[index]) fail(`duplicate grid node at ${row.lon},${row.lat}.`);
    occupied[index] = 1;
    mmh[index] = row.mmh;
    thunderstormCode[index] = row.thunderstorm;
    hailCode[index] = row.hail;
    storm[index] = levelValue(THUNDERSTORM_LEVELS, row.thunderstorm, rowIndex + 2, 'thunderstorm');
    hail[index] = levelValue(HAIL_LEVELS, row.hail, rowIndex + 2, 'hail');
  }
  if (occupied.some((value) => value === 0)) fail('one or more grid nodes are missing.');
  return new RealWeatherField({ longitudes, latitudes, mmh, thunderstormCode, hailCode, rainMmh: mmh, storm, hail, sourceRowCount: rows.length, longitudeSpacing, latitudeSpacing });
}

export async function loadRealWeatherSnapshot(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to load real weather snapshot (${response.status}).`);
  return parseRealWeatherCsv(await response.text());
}
