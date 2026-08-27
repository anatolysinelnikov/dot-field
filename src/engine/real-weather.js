import { clamp } from './math.js';

const THUNDERSTORM_LEVELS = Object.freeze({ 0: 0, 10: 0.2660123, 11: 0.4818750, 12: 0.6977377 });
const HAIL_LEVELS = Object.freeze({ 0: 0, 16: 0.2776807, 17: 0.4897500, 18: 0.7018193 });
const EXPECTED_COLUMNS = ['lon', 'lat', 'mmh', 'thunderstorm', 'hail'];
const REGULAR_SPACING_TOLERANCE = 2e-5;
const OUTSIDE_SOURCE_INDEX = 0xffffffff;
const SEQUENCE_SCHEMA_VERSION = 'dot-field-netcdf-sequence-v1';
const SEQUENCE_DIMENSIONS = Object.freeze(['time', 'latitude', 'longitude']);
const SEQUENCE_BINARY_FILENAME = 'rain.f32';
const SPATIAL_RAIN_CACHE_LIMIT = 4;
const COMPACT_RECTANGULAR_GEOMETRY = 'compact-rectangular';
const DENSE_GENERIC_GEOMETRY = 'dense-generic';

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

function sortedIndexOf(values, target) {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const value = values[middle];
    if (value === target) return middle;
    if (value < target) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

export class RealWeatherField {
  constructor({ longitudes, latitudes, mmh, thunderstormCode, hailCode, rainMmh, storm, hail, sourceRowCount, longitudeSpacing, latitudeSpacing, frameIndex = 0, timestamp = null }) {
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
    this.frameIndex = frameIndex;
    this.timestamp = timestamp;
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
    this.setSamplingGeometryMetadata(geometry);
    const activeIndices = this.potentialWeatherMask ? [] : null;
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
      if (activeIndices && this.isPotentialWeatherSample(geometry, index)) activeIndices.push(index);
    }
    this.finishSamplingGeometry(geometry, activeIndices);
    this.setSamplingGeometryMetadata(geometry);
    return geometry;
  }

  // Regular packed geographic levels are row-major rectangles. Resolve each
  // source-axis position once, then fill the packed lookup arrays by product.
  // This preserves locate() edge/clamping semantics while avoiding per-sample
  // axis searches and Mercator-to-latitude conversions.
  prepareRectangularSamplingGeometry(longitudes, latitudes, width, height, reusable = null) {
    if (width !== longitudes.length || height !== latitudes.length) {
      throw new Error('Rectangular sampling geometry dimensions must match the packed axis lengths.');
    }
    const length = width * height;
    const geometry = reusable?.baseIndex?.length === length ? reusable : {
      baseIndex: new Uint32Array(length),
      longitudeFraction: new Float64Array(length),
      latitudeFraction: new Float64Array(length)
    };
    geometry.baseIndex.fill(OUTSIDE_SOURCE_INDEX);
    this.setSamplingGeometryMetadata(geometry);
    const longitudePositions = new Array(width);
    const latitudePositions = new Array(height);
    for (let column = 0; column < width; column++) {
      const longitude = longitudes[column];
      longitudePositions[column] = longitude < this.bounds.west || longitude > this.bounds.east
        ? null : this.locate(this.longitudes, longitude);
    }
    for (let row = 0; row < height; row++) {
      const latitude = latitudes[row];
      latitudePositions[row] = latitude < this.bounds.south || latitude > this.bounds.north
        ? null : this.locate(this.latitudes, latitude);
    }
    const activeIndices = this.potentialWeatherMask ? [] : null;
    for (let row = 0; row < height; row++) {
      const latitudePosition = latitudePositions[row];
      if (!latitudePosition) continue;
      for (let column = 0; column < width; column++) {
        const longitudePosition = longitudePositions[column];
        if (!longitudePosition) continue;
        const index = row * width + column;
        geometry.baseIndex[index] = this.index(longitudePosition.index, latitudePosition.index);
        geometry.longitudeFraction[index] = longitudePosition.fraction;
        geometry.latitudeFraction[index] = latitudePosition.fraction;
        if (activeIndices && this.isPotentialWeatherSample(geometry, index)) activeIndices.push(index);
      }
    }
    this.finishSamplingGeometry(geometry, activeIndices);
    this.setSamplingGeometryMetadata(geometry);
    return geometry;
  }

  isPotentialWeatherSample(geometry, index) {
    const baseIndex = geometry.baseIndex[index];
    if (baseIndex === OUTSIDE_SOURCE_INDEX) return false;
    const x1y0 = baseIndex + 1;
    const x0y1 = baseIndex + geometry.sourceWidth;
    const x1y1 = x0y1 + 1;
    return this.potentialWeatherMask[baseIndex] || this.potentialWeatherMask[x1y0]
      || this.potentialWeatherMask[x0y1] || this.potentialWeatherMask[x1y1];
  }

  finishSamplingGeometry(geometry, activeIndices) {
    if (!activeIndices) return;
    geometry.potentialActiveIndices = Uint32Array.from(activeIndices);
    geometry.potentialWeatherMask = this.potentialWeatherMask;
    geometry.spatialRainCache = new Map();
  }

  setSamplingGeometryMetadata(geometry) {
    geometry.sourceWidth = this.longitudes.length;
    geometry.sourceHeight = this.latitudes.length;
    geometry.longitudeStart = this.longitudes[0];
    geometry.longitudeSpacing = this.longitudeSpacing;
    geometry.latitudeStart = this.latitudes[0];
    geometry.latitudeSpacing = this.latitudeSpacing;
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
    // This explicit capability is limited to the current rain-only sequence;
    // generic fields must continue through the full channel-aware path.
    this.supportsRainOnlyPreparedTemporalSampling = true;
    this.weatherSummaryProfile = 'rain-only-display';
    this.stormAvailable = false;
    this.hailAvailable = false;
  }

  isSamplingGeometryCompatible(geometry) {
    return this.sequence.isSamplingGeometryCompatible(geometry);
  }

  prepareSamplingGeometry(longitudes, latitudes, reusable = null) {
    return this.sequence.prepareSamplingGeometry(longitudes, latitudes, reusable);
  }

  prepareRectangularSamplingGeometry(longitudes, latitudes, width, height, reusable = null) {
    return this.sequence.prepareRectangularSamplingGeometry(longitudes, latitudes, width, height, reusable);
  }

  samplePrepared(geometry, index, output = {}) {
    return this.sequence.samplePreparedFrame(this, geometry, index, output);
  }

  samplePreparedBatch(geometry) {
    return this.sequence.samplePreparedFrameBatch(this, geometry);
  }

  prepareTemporalSampling(geometry) {
    return this.sequence.prepareTemporalSampling(this, geometry);
  }

  preparedSourceFrame(geometry, frameIndex) {
    return this.sequence.preparedSourceFrame(geometry, frameIndex);
  }

  sample(longitude, latitude, output = {}) {
    return this.sequence.sampleFrame(this, longitude, latitude, output);
  }
}

export class RealWeatherSequence extends RealWeatherField {
  constructor({ longitudes, latitudes, rainFramesMmh, frameCount, longitudeSpacing, latitudeSpacing, timestamps, potentialWeatherMask = null }) {
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
    this.potentialWeatherMask = potentialWeatherMask || new Uint8Array(frameSize);
    if (this.potentialWeatherMask.length !== frameSize) {
      throw new Error('Real weather sequence potential-weather mask does not match the source frame size.');
    }
    if (!potentialWeatherMask) {
      for (let frame = 0; frame < frameCount; frame++) {
        const offset = frame * frameSize;
        for (let index = 0; index < frameSize; index++) {
          if (rainFramesMmh[offset + index] > 0) this.potentialWeatherMask[index] = 1;
        }
      }
    }
    this.rawFrames = new Map();
    this.rawFrame = this.exactSourceFrameAt(0);
  }

  isSamplingGeometryCompatible(geometry) {
    return geometry?.sourceWidth === this.longitudes.length
      && geometry.sourceHeight === this.latitudes.length
      && geometry.longitudeStart === this.longitudes[0]
      && geometry.longitudeSpacing === this.longitudeSpacing
      && geometry.latitudeStart === this.latitudes[0]
      && geometry.latitudeSpacing === this.latitudeSpacing
      && geometry.potentialWeatherMask === this.potentialWeatherMask
      && (geometry.kind === COMPACT_RECTANGULAR_GEOMETRY || geometry.kind === DENSE_GENERIC_GEOMETRY);
  }

  prepareSamplingGeometry(longitudes, latitudes, reusable = null) {
    const geometry = super.prepareSamplingGeometry(longitudes, latitudes, reusable);
    geometry.kind = DENSE_GENERIC_GEOMETRY;
    return geometry;
  }

  prepareRectangularSamplingGeometry(longitudes, latitudes, width, height, reusable = null) {
    if (width !== longitudes.length || height !== latitudes.length) {
      throw new Error('Rectangular sampling geometry dimensions must match the packed axis lengths.');
    }
    const geometry = reusable?.kind === COMPACT_RECTANGULAR_GEOMETRY
      && reusable.width === width
      && reusable.height === height
      ? reusable
      : {
        kind: COMPACT_RECTANGULAR_GEOMETRY,
        width,
        height,
        count: width * height,
        sourceColumn: new Uint32Array(width),
        longitudeFraction: new Float64Array(width),
        sourceRowBase: new Uint32Array(height),
        latitudeFraction: new Float64Array(height)
      };
    geometry.kind = COMPACT_RECTANGULAR_GEOMETRY;
    geometry.width = width;
    geometry.height = height;
    geometry.count = width * height;
    geometry.sourceColumn.fill(OUTSIDE_SOURCE_INDEX);
    geometry.sourceRowBase.fill(OUTSIDE_SOURCE_INDEX);
    this.setSamplingGeometryMetadata(geometry);
    const sourceWidth = this.longitudes.length;
    const sourceColumnIndices = geometry.sourceColumn;
    const sourceRowBases = geometry.sourceRowBase;
    const longitudeFractions = geometry.longitudeFraction;
    const latitudeFractions = geometry.latitudeFraction;
    const potentialWeatherMask = this.potentialWeatherMask;

    for (let column = 0; column < width; column++) {
      const longitude = longitudes[column];
      if (longitude < this.bounds.west || longitude > this.bounds.east) continue;
      const position = this.locate(this.longitudes, longitude);
      sourceColumnIndices[column] = position.index;
      longitudeFractions[column] = position.fraction;
    }
    for (let row = 0; row < height; row++) {
      const latitude = latitudes[row];
      if (latitude < this.bounds.south || latitude > this.bounds.north) continue;
      const position = this.locate(this.latitudes, latitude);
      sourceRowBases[row] = position.index * sourceWidth;
      latitudeFractions[row] = position.fraction;
    }

    const activeIndices = this.potentialWeatherMask ? [] : null;
    for (let row = 0; row < height; row++) {
      const sourceRowBase = sourceRowBases[row];
      if (sourceRowBase === OUTSIDE_SOURCE_INDEX) continue;
      const rowOffset = row * width;
      for (let column = 0; column < width; column++) {
        const sourceColumn = sourceColumnIndices[column];
        if (sourceColumn === OUTSIDE_SOURCE_INDEX) continue;
        const baseIndex = sourceRowBase + sourceColumn;
        const x1y0 = baseIndex + 1;
        const x0y1 = baseIndex + sourceWidth;
        const x1y1 = x0y1 + 1;
        if (activeIndices && (potentialWeatherMask[baseIndex] || potentialWeatherMask[x1y0]
          || potentialWeatherMask[x0y1] || potentialWeatherMask[x1y1])) {
          activeIndices.push(rowOffset + column);
        }
      }
    }
    this.finishSamplingGeometry(geometry, activeIndices);
    this.setSamplingGeometryMetadata(geometry);
    return geometry;
  }

  samplingGeometryBytes(geometry) {
    if (geometry?.kind === COMPACT_RECTANGULAR_GEOMETRY) {
      return geometry.sourceColumn.byteLength
        + geometry.longitudeFraction.byteLength
        + geometry.sourceRowBase.byteLength
        + geometry.latitudeFraction.byteLength;
    }
    return super.samplingGeometryBytes(geometry);
  }

  prepareFrame(time) {
    const normalizedTime = clamp(Number.isFinite(time) ? time : 0, 0, 1);
    const sourcePosition = normalizedTime * (this.frameCount - 1);
    const frame0 = Math.floor(sourcePosition);
    const frame1 = Math.min(frame0 + 1, this.frameCount - 1);
    return new RealWeatherSequenceFrame(this, frame0, frame1, sourcePosition - frame0);
  }

  exactSourceFrameAt(frameIndex) {
    if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= this.frameCount) {
      throw new RangeError(`Source frame index must be an integer from 0 to ${this.frameCount - 1}.`);
    }
    const cached = this.rawFrames.get(frameIndex);
    if (cached) return cached;
    const offset = frameIndex * this.frameSize;
    const frameValues = this.rainFramesMmh.subarray(offset, offset + this.frameSize);
    const frame = new RealWeatherField({
      longitudes: this.longitudes,
      latitudes: this.latitudes,
      mmh: frameValues,
      thunderstormCode: this.thunderstormCode,
      hailCode: this.hailCode,
      rainMmh: frameValues,
      storm: this.storm,
      hail: this.hail,
      sourceRowCount: this.frameSize,
      longitudeSpacing: this.longitudeSpacing,
      latitudeSpacing: this.latitudeSpacing,
      frameIndex,
      timestamp: this.timestamps[frameIndex] ?? null
    });
    // Axes and cell bounds are immutable spatial metadata. Keep the exact
    // frame object small by sharing the already-derived bounds as well.
    frame.longitudeCellBounds = this.longitudeCellBounds;
    frame.latitudeCellBounds = this.latitudeCellBounds;
    this.rawFrames.set(frameIndex, frame);
    return frame;
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

  preparedSourceFrame(geometry, frameIndex) {
    if (!geometry.spatialRainCache) geometry.spatialRainCache = new Map();
    const cached = geometry.spatialRainCache.get(frameIndex);
    if (cached !== undefined) {
      geometry.spatialRainCache.delete(frameIndex);
      geometry.spatialRainCache.set(frameIndex, cached);
      return cached;
    }
    const activeIndices = geometry.potentialActiveIndices || new Uint32Array(0);
    const values = new Float64Array(activeIndices.length);
    for (let activeIndex = 0; activeIndex < activeIndices.length; activeIndex++) {
      const index = activeIndices[activeIndex];
      let baseIndex;
      let longitudeFraction;
      let latitudeFraction;
      if (geometry.kind === COMPACT_RECTANGULAR_GEOMETRY) {
        const column = index % geometry.width;
        const row = (index - column) / geometry.width;
        const sourceColumn = geometry.sourceColumn[column];
        const sourceRowBase = geometry.sourceRowBase[row];
        baseIndex = sourceRowBase + sourceColumn;
        longitudeFraction = geometry.longitudeFraction[column];
        latitudeFraction = geometry.latitudeFraction[row];
      } else {
        baseIndex = geometry.baseIndex[index];
        longitudeFraction = geometry.longitudeFraction[index];
        latitudeFraction = geometry.latitudeFraction[index];
      }
      const x1y0 = baseIndex + 1;
      const x0y1 = baseIndex + geometry.sourceWidth;
      const x1y1 = x0y1 + 1;
      values[activeIndex] = this.interpolateRain(frameIndex, baseIndex, x1y0, x0y1, x1y1,
        longitudeFraction, latitudeFraction);
    }
    geometry.spatialRainCache.set(frameIndex, values);
    while (geometry.spatialRainCache.size > SPATIAL_RAIN_CACHE_LIMIT) {
      const oldestFrameIndex = geometry.spatialRainCache.keys().next().value;
      geometry.spatialRainCache.delete(oldestFrameIndex);
    }
    return values;
  }

  prepareTemporalSampling(frame, geometry) {
    const rain0 = this.preparedSourceFrame(geometry, frame.frame0);
    const rain1 = this.preparedSourceFrame(geometry, frame.frame1);
    const progress = frame.progress;
    // Keep temporal reconstruction provider-owned. The returned callable is
    // one evaluation-scoped capability, not a per-sample allocation.
    return (activeIndex) => rain0[activeIndex] + (rain1[activeIndex] - rain0[activeIndex]) * progress;
  }

  samplePreparedFrameBatch(frame, geometry) {
    const activeIndices = geometry.potentialActiveIndices || new Uint32Array(0);
    if (!geometry.temporalRainMmh || geometry.temporalRainMmh.length !== activeIndices.length) {
      geometry.temporalRainMmh = new Float64Array(activeIndices.length);
    }
    const temporalRain = this.prepareTemporalSampling(frame, geometry);
    for (let activeIndex = 0; activeIndex < activeIndices.length; activeIndex++) {
      geometry.temporalRainMmh[activeIndex] = temporalRain(activeIndex);
    }
    return geometry.temporalRainMmh;
  }

  samplePreparedFrame(frame, geometry, index, output = {}) {
    output.rainMmh = 0;
    output.storm = 0;
    output.hail = 0;
    let baseIndex;
    let longitudeFraction;
    let latitudeFraction;
    if (geometry.kind === COMPACT_RECTANGULAR_GEOMETRY) {
      const column = index % geometry.width;
      const row = (index - column) / geometry.width;
      const sourceColumn = geometry.sourceColumn[column];
      const sourceRowBase = geometry.sourceRowBase[row];
      if (sourceColumn === OUTSIDE_SOURCE_INDEX || sourceRowBase === OUTSIDE_SOURCE_INDEX) return output;
      baseIndex = sourceRowBase + sourceColumn;
      longitudeFraction = geometry.longitudeFraction[column];
      latitudeFraction = geometry.latitudeFraction[row];
    } else {
      baseIndex = geometry.baseIndex[index];
      if (baseIndex === OUTSIDE_SOURCE_INDEX) return output;
      longitudeFraction = geometry.longitudeFraction[index];
      latitudeFraction = geometry.latitudeFraction[index];
    }
    if (geometry.potentialActiveIndices) {
      const activeIndex = sortedIndexOf(geometry.potentialActiveIndices, index);
      if (activeIndex < 0) return output;
      const rain0 = this.preparedSourceFrame(geometry, frame.frame0)[activeIndex];
      const rain1 = this.preparedSourceFrame(geometry, frame.frame1)[activeIndex];
      output.rainMmh = rain0 + (rain1 - rain0) * frame.progress;
      return output;
    }
    const x1y0 = baseIndex + 1;
    const x0y1 = baseIndex + geometry.sourceWidth;
    const x1y1 = x0y1 + 1;
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

async function fetchSequenceAsset(url, options = undefined) {
  const response = await fetch(url, options);
  if (response.status === 404 || response.status === 410) throw new RealWeatherSequenceAssetsUnavailableError(url, response.status);
  if (!response.ok) throw new Error(`Unable to load real weather sequence asset ${url} (${response.status}).`);
  return response;
}

function validateRainFramesAndBuildPotentialMask(rainFramesMmh, frameSize) {
  const potentialWeatherMask = new Uint8Array(frameSize);
  let spatialIndex = 0;
  for (let index = 0; index < rainFramesMmh.length; index++) {
    const value = rainFramesMmh[index];
    if (!Number.isFinite(value) || value < 0) failSequence(`rain.f32 has an invalid value at element ${index}.`);
    if (value > 0) potentialWeatherMask[spatialIndex] = 1;
    spatialIndex++;
    if (spatialIndex === frameSize) spatialIndex = 0;
  }
  return potentialWeatherMask;
}

async function loadSequenceMetadata(metadataUrl, timing) {
  timing('weather-metadata-fetch-start');
  const metadataResponse = await fetchSequenceAsset(metadataUrl);
  timing('weather-metadata-fetch-headers');
  let metadata;
  try {
    metadata = await metadataResponse.json();
  } catch {
    failSequence('metadata is not valid JSON.');
  }
  timing('weather-metadata-fetch-complete');
  const validated = validateSequenceMetadata(metadata);
  timing('weather-metadata-validation-complete');
  return validated;
}

export function beginRealWeatherSequenceLoad(metadataUrl, binaryUrl, { onTiming = null } = {}) {
  const timing = typeof onTiming === 'function' ? onTiming : () => {};
  const metadataReady = loadSequenceMetadata(metadataUrl, timing);
  let sequencePromise = null;

  return {
    metadataReady,
    loadSequence() {
      if (sequencePromise) return sequencePromise;
      sequencePromise = (async () => {
        const validated = await metadataReady;
        timing('weather-binary-fetch-start');
        const binaryResponse = await fetchSequenceAsset(binaryUrl);
        timing('weather-binary-fetch-headers');
        const binaryBuffer = await binaryResponse.arrayBuffer();
        timing('weather-binary-body-complete');
        if (binaryBuffer.byteLength !== validated.expectedByteCount) {
          failSequence(`rain.f32 byte length is ${binaryBuffer.byteLength}, expected ${validated.expectedByteCount}.`);
        }
        const rainFramesMmh = new Float32Array(binaryBuffer);
        if (rainFramesMmh.length !== validated.expectedElementCount) failSequence('rain.f32 element count does not match metadata.');
        const potentialWeatherMask = validateRainFramesAndBuildPotentialMask(rainFramesMmh, validated.width * validated.height);
        timing('weather-binary-validation-complete');
        timing('weather-potential-weather-mask-complete');
        const { longitudes, latitudes } = axesFromSequenceMetadata(validated);
        const sequence = new RealWeatherSequence({
          longitudes,
          latitudes,
          rainFramesMmh,
          frameCount: validated.frameCount,
          longitudeSpacing: validated.longitudeSpacing,
          latitudeSpacing: validated.latitudeSpacing,
          timestamps: validated.timestamps,
          potentialWeatherMask
        });
        timing('weather-sequence-construction-complete');
        return sequence;
      })();
      return sequencePromise;
    }
  };
}

export async function loadRealWeatherSequence(metadataUrl, binaryUrl, options = {}) {
  return beginRealWeatherSequenceLoad(metadataUrl, binaryUrl, options).loadSequence();
}
