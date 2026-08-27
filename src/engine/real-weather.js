import { clamp } from './math.js';

const THUNDERSTORM_LEVELS = Object.freeze({ 0: 0, 10: 0.2660123, 11: 0.4818750, 12: 0.6977377 });
const HAIL_LEVELS = Object.freeze({ 0: 0, 16: 0.2776807, 17: 0.4897500, 18: 0.7018193 });
const EXPECTED_COLUMNS = ['lon', 'lat', 'mmh', 'thunderstorm', 'hail'];
const REGULAR_SPACING_TOLERANCE = 2e-5;
const OUTSIDE_SOURCE_INDEX = 0xffffffff;
const SEQUENCE_SCHEMA_VERSION = 'dot-field-netcdf-sequence-v1';
const SEQUENCE_DIMENSIONS = Object.freeze(['time', 'latitude', 'longitude']);
const SEQUENCE_BINARY_FILENAME = 'rain.f32';

function fail(message) {
  throw new Error(`Real weather CSV validation failed: ${message}`);
}

function failSequence(message) {
  throw new Error(`Real weather sequence validation failed: ${message}`);
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

function interpolatePrepared(values, baseIndex, x1y0, x0y1, x1y1, longitudeFraction, latitudeFraction, minimum = 0, maximum = 1) {
  const lower = values[baseIndex] + (values[x1y0] - values[baseIndex]) * longitudeFraction;
  const upper = values[x0y1] + (values[x1y1] - values[x0y1]) * longitudeFraction;
  return clamp(lower + (upper - lower) * latitudeFraction, minimum, maximum);
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
    this.rawFrame = this;
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

  isSamplingGeometryCompatible(geometry) {
    return geometry?.sourceWidth === this.longitudes.length
      && geometry.sourceHeight === this.latitudes.length
      && geometry.longitudeStart === this.longitudes[0]
      && geometry.longitudeSpacing === this.longitudeSpacing
      && geometry.latitudeStart === this.latitudes[0]
      && geometry.latitudeSpacing === this.latitudeSpacing
      && !geometry.potentialWeatherMask;
  }

  prepareSamplingGeometry(longitudes, latitudes, reusable = null) {
    if (longitudes.length !== latitudes.length) throw new Error('Sampling geometry longitude/latitude batches must have equal lengths.');
    const length = longitudes.length;
    const geometry = reusable?.baseIndex?.length === length ? reusable : {
      baseIndex: new Uint32Array(length),
      longitudeFraction: new Float64Array(length),
      latitudeFraction: new Float64Array(length)
    };
    geometry.baseIndex.fill(OUTSIDE_SOURCE_INDEX);
    for (let index = 0; index < length; index++) {
      const longitude = longitudes[index];
      const latitude = latitudes[index];
      if (longitude < this.bounds.west || longitude > this.bounds.east
        || latitude < this.bounds.south || latitude > this.bounds.north) continue;
      const longitudePosition = this.locate(this.longitudes, longitude);
      const latitudePosition = this.locate(this.latitudes, latitude);
      geometry.baseIndex[index] = this.index(longitudePosition.index, latitudePosition.index);
      geometry.longitudeFraction[index] = longitudePosition.fraction;
      geometry.latitudeFraction[index] = latitudePosition.fraction;
    }
    geometry.sourceWidth = this.longitudes.length;
    geometry.sourceHeight = this.latitudes.length;
    geometry.longitudeStart = this.longitudes[0];
    geometry.longitudeSpacing = this.longitudeSpacing;
    geometry.latitudeStart = this.latitudes[0];
    geometry.latitudeSpacing = this.latitudeSpacing;
    return geometry;
  }

  samplingGeometryBytes(geometry) {
    return geometry.baseIndex.byteLength
      + geometry.longitudeFraction.byteLength
      + geometry.latitudeFraction.byteLength;
  }

  samplePrepared(geometry, index, output = {}) {
    output.rainMmh = 0;
    output.storm = 0;
    output.hail = 0;
    const baseIndex = geometry.baseIndex[index];
    if (baseIndex === OUTSIDE_SOURCE_INDEX) return output;
    const x1y0 = baseIndex + 1;
    const x0y1 = baseIndex + geometry.sourceWidth;
    const x1y1 = x0y1 + 1;
    const longitudeFraction = geometry.longitudeFraction[index];
    const latitudeFraction = geometry.latitudeFraction[index];
    output.rainMmh = interpolatePrepared(this.rainMmh, baseIndex, x1y0, x0y1, x1y1, longitudeFraction, latitudeFraction, 0, Number.POSITIVE_INFINITY);
    output.storm = interpolatePrepared(this.storm, baseIndex, x1y0, x0y1, x1y1, longitudeFraction, latitudeFraction);
    output.hail = interpolatePrepared(this.hail, baseIndex, x1y0, x0y1, x1y1, longitudeFraction, latitudeFraction);
    return output;
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

  prepareFrame() {
    return this;
  }
}

export class RealWeatherSequenceFrame {
  constructor(sequence, frame0, frame1, progress) {
    this.sequence = sequence;
    this.frame0 = frame0;
    this.frame1 = frame1;
    this.progress = progress;
  }

  isSamplingGeometryCompatible(geometry) {
    return this.sequence.isSamplingGeometryCompatible(geometry);
  }

  prepareSamplingGeometry(longitudes, latitudes, reusable = null) {
    return this.sequence.prepareSamplingGeometry(longitudes, latitudes, reusable);
  }

  samplePrepared(geometry, index, output = {}) {
    return this.sequence.samplePreparedFrame(this, geometry, index, output);
  }

  sample(longitude, latitude, output = {}) {
    return this.sequence.sampleFrame(this, longitude, latitude, output);
  }
}

export class RealWeatherSequence extends RealWeatherField {
  constructor({ longitudes, latitudes, rainFramesMmh, frameCount, longitudeSpacing, latitudeSpacing, timestamps }) {
    const frameSize = longitudes.length * latitudes.length;
    const emptyCodes = new Uint8Array(frameSize);
    const emptyChannel = new Float32Array(frameSize);
    super({
      longitudes,
      latitudes,
      mmh: rainFramesMmh.subarray(0, frameSize),
      thunderstormCode: emptyCodes,
      hailCode: emptyCodes,
      rainMmh: rainFramesMmh.subarray(0, frameSize),
      storm: emptyChannel,
      hail: emptyChannel,
      sourceRowCount: frameSize,
      longitudeSpacing,
      latitudeSpacing
    });
    this.rainFramesMmh = rainFramesMmh;
    this.frameCount = frameCount;
    this.frameSize = frameSize;
    this.timestamps = Object.freeze([...timestamps]);
    // A source node can only contribute positive reconstructed rain when at
    // least one of the four nodes in its bilinear stencil is positive. This
    // sequence-wide union is immutable and is shared by every prepared
    // geometry and temporal frame.
    this.potentialWeatherMask = new Uint8Array(frameSize);
    for (let frame = 0; frame < frameCount; frame++) {
      const offset = frame * frameSize;
      for (let index = 0; index < frameSize; index++) {
        if (rainFramesMmh[offset + index] > 0) this.potentialWeatherMask[index] = 1;
      }
    }
    // RAW is intentionally a static diagnostic of the initial source frame.
    this.rawFrame = new RealWeatherField({
      longitudes,
      latitudes,
      mmh: this.rainFramesMmh.subarray(0, frameSize),
      thunderstormCode: emptyCodes,
      hailCode: emptyCodes,
      rainMmh: this.rainFramesMmh.subarray(0, frameSize),
      storm: emptyChannel,
      hail: emptyChannel,
      sourceRowCount: frameSize,
      longitudeSpacing,
      latitudeSpacing
    });
  }

  isSamplingGeometryCompatible(geometry) {
    return geometry?.sourceWidth === this.longitudes.length
      && geometry.sourceHeight === this.latitudes.length
      && geometry.longitudeStart === this.longitudes[0]
      && geometry.longitudeSpacing === this.longitudeSpacing
      && geometry.latitudeStart === this.latitudes[0]
      && geometry.latitudeSpacing === this.latitudeSpacing
      && geometry.potentialWeatherMask === this.potentialWeatherMask;
  }

  prepareSamplingGeometry(longitudes, latitudes, reusable = null) {
    const geometry = super.prepareSamplingGeometry(longitudes, latitudes, reusable);
    if (geometry.potentialWeatherMask === this.potentialWeatherMask) return geometry;
    const activeIndices = [];
    for (let index = 0; index < geometry.baseIndex.length; index++) {
      const baseIndex = geometry.baseIndex[index];
      if (baseIndex === OUTSIDE_SOURCE_INDEX) continue;
      const x1y0 = baseIndex + 1;
      const x0y1 = baseIndex + geometry.sourceWidth;
      const x1y1 = x0y1 + 1;
      if (this.potentialWeatherMask[baseIndex] || this.potentialWeatherMask[x1y0]
        || this.potentialWeatherMask[x0y1] || this.potentialWeatherMask[x1y1]) activeIndices.push(index);
    }
    geometry.potentialActiveIndices = Uint32Array.from(activeIndices);
    geometry.potentialWeatherMask = this.potentialWeatherMask;
    return geometry;
  }

  prepareFrame(time) {
    const normalizedTime = clamp(Number.isFinite(time) ? time : 0, 0, 1);
    const sourcePosition = normalizedTime * (this.frameCount - 1);
    const frame0 = Math.floor(sourcePosition);
    const frame1 = Math.min(frame0 + 1, this.frameCount - 1);
    return new RealWeatherSequenceFrame(this, frame0, frame1, sourcePosition - frame0);
  }

  interpolateRain(frame, baseIndex, x1y0, x0y1, x1y1, longitudeFraction, latitudeFraction) {
    const offset = frame * this.frameSize;
    return interpolatePrepared(
      this.rainFramesMmh,
      offset + baseIndex,
      offset + x1y0,
      offset + x0y1,
      offset + x1y1,
      longitudeFraction,
      latitudeFraction,
      0,
      Number.POSITIVE_INFINITY
    );
  }

  samplePreparedFrame(frame, geometry, index, output = {}) {
    output.rainMmh = 0;
    output.storm = 0;
    output.hail = 0;
    const baseIndex = geometry.baseIndex[index];
    if (baseIndex === OUTSIDE_SOURCE_INDEX) return output;
    const x1y0 = baseIndex + 1;
    const x0y1 = baseIndex + geometry.sourceWidth;
    const x1y1 = x0y1 + 1;
    const longitudeFraction = geometry.longitudeFraction[index];
    const latitudeFraction = geometry.latitudeFraction[index];
    const rain0 = this.interpolateRain(frame.frame0, baseIndex, x1y0, x0y1, x1y1, longitudeFraction, latitudeFraction);
    const rain1 = this.interpolateRain(frame.frame1, baseIndex, x1y0, x0y1, x1y1, longitudeFraction, latitudeFraction);
    output.rainMmh = rain0 + (rain1 - rain0) * frame.progress;
    return output;
  }

  sampleFrame(frame, longitude, latitude, output = {}) {
    output.rainMmh = 0;
    output.storm = 0;
    output.hail = 0;
    if (longitude < this.bounds.west || longitude > this.bounds.east
      || latitude < this.bounds.south || latitude > this.bounds.north) return output;
    const x = this.locate(this.longitudes, longitude);
    const y = this.locate(this.latitudes, latitude);
    const baseIndex = this.index(x.index, y.index);
    const x1y0 = baseIndex + 1;
    const x0y1 = baseIndex + this.longitudes.length;
    const x1y1 = x0y1 + 1;
    const rain0 = this.interpolateRain(frame.frame0, baseIndex, x1y0, x0y1, x1y1, x.fraction, y.fraction);
    const rain1 = this.interpolateRain(frame.frame1, baseIndex, x1y0, x0y1, x1y1, x.fraction, y.fraction);
    output.rainMmh = rain0 + (rain1 - rain0) * frame.progress;
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

export class RealWeatherSequenceAssetsUnavailableError extends Error {
  constructor(url, status) {
    super(`Real weather sequence assets are unavailable (${status}) at ${url}.`);
    this.name = 'RealWeatherSequenceAssetsUnavailableError';
  }
}

function objectAt(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) failSequence(`${name} must be an object.`);
  return value;
}

function sequenceNumber(value, name) {
  if (!Number.isFinite(value)) failSequence(`${name} must be finite.`);
  return value;
}

function sequenceInteger(value, name) {
  if (!Number.isInteger(value)) failSequence(`${name} must be an integer.`);
  return value;
}

function sequenceString(value, name) {
  if (typeof value !== 'string' || !value) failSequence(`${name} must be a non-empty string.`);
  return value;
}

function assertSequenceEqual(actual, expected, name) {
  if (actual !== expected) failSequence(`${name} must be ${JSON.stringify(expected)}.`);
}

function validateSequenceMetadata(metadata) {
  const root = objectAt(metadata, 'metadata');
  assertSequenceEqual(root.schema_version, SEQUENCE_SCHEMA_VERSION, 'schema_version');
  const binary = objectAt(root.binary, 'binary');
  const grid = objectAt(root.spatial_grid, 'spatial_grid');
  const time = objectAt(root.time, 'time');
  const channels = objectAt(root.channels, 'channels');
  const rain = objectAt(root.rain, 'rain');
  const source = objectAt(root.source, 'source');

  const width = sequenceInteger(grid.width, 'spatial_grid.width');
  const height = sequenceInteger(grid.height, 'spatial_grid.height');
  const frameCount = sequenceInteger(time.count, 'time.count');
  if (width < 2) failSequence('spatial_grid.width must be at least 2.');
  if (height < 2) failSequence('spatial_grid.height must be at least 2.');
  if (frameCount < 2) failSequence('time.count must be at least 2.');
  if (!Array.isArray(time.timestamps) || time.timestamps.length !== frameCount) failSequence('time.timestamps must contain one timestamp per frame.');
  for (const [index, timestamp] of time.timestamps.entries()) {
    sequenceString(timestamp, `time.timestamps[${index}]`);
    if (!Number.isFinite(Date.parse(timestamp))) failSequence(`time.timestamps[${index}] is invalid.`);
  }

  assertSequenceEqual(binary.dtype, 'Float32', 'binary.dtype');
  assertSequenceEqual(binary.byte_order, 'little-endian', 'binary.byte_order');
  assertSequenceEqual(binary.filename, SEQUENCE_BINARY_FILENAME, 'binary.filename');
  if (!Array.isArray(binary.logical_dimensions) || binary.logical_dimensions.length !== SEQUENCE_DIMENSIONS.length
    || binary.logical_dimensions.some((dimension, index) => dimension !== SEQUENCE_DIMENSIONS[index])) {
    failSequence(`binary.logical_dimensions must be ${SEQUENCE_DIMENSIONS.join(', ')}.`);
  }
  if (!Array.isArray(binary.shape) || binary.shape.length !== 3) failSequence('binary.shape must contain time, latitude, and longitude lengths.');
  const expectedShape = [frameCount, height, width];
  for (let index = 0; index < expectedShape.length; index++) {
    if (sequenceInteger(binary.shape[index], `binary.shape[${index}]`) !== expectedShape[index]) failSequence('binary.shape does not match time and spatial dimensions.');
  }
  const expectedElementCount = frameCount * height * width;
  const expectedByteCount = expectedElementCount * Float32Array.BYTES_PER_ELEMENT;
  if (sequenceInteger(binary.element_count, 'binary.element_count') !== expectedElementCount) failSequence('binary.element_count does not match the declared shape.');
  if (sequenceInteger(binary.byte_count, 'binary.byte_count') !== expectedByteCount) failSequence('binary.byte_count does not match the declared shape.');

  const longitudeStart = sequenceNumber(grid.longitude_start, 'spatial_grid.longitude_start');
  const latitudeStart = sequenceNumber(grid.latitude_start, 'spatial_grid.latitude_start');
  const longitudeSpacing = sequenceNumber(grid.longitude_spacing, 'spatial_grid.longitude_spacing');
  const latitudeSpacing = sequenceNumber(grid.latitude_spacing, 'spatial_grid.latitude_spacing');
  if (!(longitudeSpacing > 0) || !(latitudeSpacing > 0)) failSequence('spatial grid spacing must be positive.');
  assertSequenceEqual(grid.longitude_order, 'west_to_east', 'spatial_grid.longitude_order');
  assertSequenceEqual(grid.latitude_order, 'south_to_north', 'spatial_grid.latitude_order');
  assertSequenceEqual(source.normalized_units, 'mm/h', 'source.normalized_units');
  if (channels.rain !== true || rain.available !== true) failSequence('rain must be available.');
  if (channels.storm !== false || channels.hail !== false) failSequence('storm and hail must be unavailable.');

  return { width, height, frameCount, expectedElementCount, expectedByteCount, longitudeStart, latitudeStart, longitudeSpacing, latitudeSpacing, timestamps: time.timestamps };
}

function axesFromSequenceMetadata({ width, height, longitudeStart, latitudeStart, longitudeSpacing, latitudeSpacing }) {
  const longitudes = new Float64Array(width);
  const latitudes = new Float64Array(height);
  for (let index = 0; index < width; index++) longitudes[index] = longitudeStart + index * longitudeSpacing;
  for (let index = 0; index < height; index++) latitudes[index] = latitudeStart + index * latitudeSpacing;
  return { longitudes, latitudes };
}

async function fetchSequenceAsset(url) {
  const response = await fetch(url);
  if (response.status === 404 || response.status === 410) throw new RealWeatherSequenceAssetsUnavailableError(url, response.status);
  if (!response.ok) throw new Error(`Unable to load real weather sequence asset ${url} (${response.status}).`);
  return response;
}

export async function loadRealWeatherSequence(metadataUrl, binaryUrl) {
  const metadataResponse = await fetchSequenceAsset(metadataUrl);
  let metadata;
  try {
    metadata = await metadataResponse.json();
  } catch {
    failSequence('metadata is not valid JSON.');
  }
  const validated = validateSequenceMetadata(metadata);
  const binaryResponse = await fetchSequenceAsset(binaryUrl);
  const binaryBuffer = await binaryResponse.arrayBuffer();
  if (binaryBuffer.byteLength !== validated.expectedByteCount) {
    failSequence(`rain.f32 byte length is ${binaryBuffer.byteLength}, expected ${validated.expectedByteCount}.`);
  }
  const rainFramesMmh = new Float32Array(binaryBuffer);
  if (rainFramesMmh.length !== validated.expectedElementCount) failSequence('rain.f32 element count does not match metadata.');
  for (let index = 0; index < rainFramesMmh.length; index++) {
    if (!Number.isFinite(rainFramesMmh[index]) || rainFramesMmh[index] < 0) failSequence(`rain.f32 has an invalid value at element ${index}.`);
  }
  const { longitudes, latitudes } = axesFromSequenceMetadata(validated);
  return new RealWeatherSequence({
    longitudes,
    latitudes,
    rainFramesMmh,
    frameCount: validated.frameCount,
    longitudeSpacing: validated.longitudeSpacing,
    latitudeSpacing: validated.latitudeSpacing,
    timestamps: validated.timestamps
  });
}
