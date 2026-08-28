import { clamp } from './math.js';

const THUNDERSTORM_LEVELS = Object.freeze({ 0: 0, 10: 0.2660123, 11: 0.4818750, 12: 0.6977377 });
const HAIL_LEVELS = Object.freeze({ 0: 0, 16: 0.2776807, 17: 0.4897500, 18: 0.7018193 });
const EXPECTED_COLUMNS = ['lon', 'lat', 'mmh', 'thunderstorm', 'hail'];
const REGULAR_SPACING_TOLERANCE = 2e-5;
const OUTSIDE_SOURCE_INDEX = 0xffffffff;
const SEQUENCE_SCHEMA_VERSION = 'dot-field-weather-transport-v2';
const SUPPORT_MASK_ENCODING = 'bitset-lsb0';
const PHENOMENON_ENUM = Object.freeze({ none: 0, thunderstorm_1: 1, thunderstorm_2: 2, thunderstorm_3: 3, hail_1: 4, hail_2: 5, hail_3: 6, reserved: 7 });
export const DEFAULT_SOURCE_FRAME_CACHE_LIMIT = 6;
export const INITIAL_PLAYBACK_SOURCE_FRAME_COUNT = 3;
export const ROLLING_PLAYBACK_BEHIND_FRAME_COUNT = 1;
export const ROLLING_PLAYBACK_AHEAD_FRAME_COUNT = 3;
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

export function rollingPlaybackSourceFrameIndices(frameCount, normalizedTime, {
  behind = ROLLING_PLAYBACK_BEHIND_FRAME_COUNT,
  ahead = ROLLING_PLAYBACK_AHEAD_FRAME_COUNT
} = {}) {
  if (!Number.isInteger(frameCount) || frameCount < 2) throw new Error('Rolling playback requires at least two source frames.');
  if (!Number.isInteger(behind) || behind < 0 || !Number.isInteger(ahead) || ahead < 0) {
    throw new Error('Rolling playback frame counts must be non-negative integers.');
  }
  const currentFrame = Math.min(frameCount - 1, Math.floor(clamp(Number(normalizedTime) || 0, 0, 1) * (frameCount - 1)));
  const start = Math.max(0, currentFrame - behind);
  const end = Math.min(frameCount - 1, currentFrame + 1 + ahead);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
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
  constructor({ longitudes, latitudes, rainFramesMmh = null, sourceFrames = null, frameCount, longitudeSpacing, latitudeSpacing, timestamps, potentialWeatherMask = null, sourceFrameCacheLimit = DEFAULT_SOURCE_FRAME_CACHE_LIMIT, onSourceFrameCacheEvent = null }) {
    const frameSize = longitudes.length * latitudes.length;
    const emptyCodes = new Uint8Array(frameSize);
    const emptyChannel = new Float32Array(frameSize);
    const firstFrame = rainFramesMmh?.subarray(0, frameSize) || sourceFrames?.get?.(0) || sourceFrames?.[0] || new Float32Array(frameSize);
    super({
      longitudes,
      latitudes,
      mmh: firstFrame,
      thunderstormCode: emptyCodes,
      hailCode: emptyCodes,
      rainMmh: firstFrame,
      storm: emptyChannel,
      hail: emptyChannel,
      sourceRowCount: frameSize,
      longitudeSpacing,
      latitudeSpacing
    });
    this.frameCount = frameCount;
    this.frameSize = frameSize;
    this.timestamps = Object.freeze([...timestamps]);
    this.sourceFrameCacheLimit = sourceFrameCacheLimit;
    this.onSourceFrameCacheEvent = typeof onSourceFrameCacheEvent === 'function' ? onSourceFrameCacheEvent : null;
    if (!Number.isInteger(sourceFrameCacheLimit) || sourceFrameCacheLimit < 2) {
      throw new Error('Real weather sequence source-frame cache limit must be an integer of at least 2.');
    }
    this.sourceFrames = new Map();
    this.validatedSourceFrames = new Set();
    if (rainFramesMmh) {
      if (rainFramesMmh.length !== frameCount * frameSize) throw new Error('Real weather sequence rain frame buffer does not match the declared dimensions.');
      for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
        this.sourceFrames.set(frameIndex, rainFramesMmh.subarray(frameIndex * frameSize, (frameIndex + 1) * frameSize));
        this.validatedSourceFrames.add(frameIndex);
      }
    } else if (sourceFrames) {
      const entries = sourceFrames instanceof Map ? sourceFrames.entries() : sourceFrames.entries();
      for (const [frameIndex, values] of entries) this.addSourceFrame(frameIndex, values, { validated: true });
    }
    // A source node can only contribute positive reconstructed rain when at
    // least one of the four nodes in its bilinear stencil is positive. This
    // sequence-wide union is immutable and is shared by every prepared
    // geometry and temporal frame.
    this.potentialWeatherMask = potentialWeatherMask || new Uint8Array(frameSize);
    if (this.potentialWeatherMask.length !== frameSize) {
      throw new Error('Real weather sequence potential-weather mask does not match the source frame size.');
    }
    if (!potentialWeatherMask && rainFramesMmh) {
      for (let frame = 0; frame < frameCount; frame++) {
        const offset = frame * frameSize;
        for (let index = 0; index < frameSize; index++) {
          if (rainFramesMmh[offset + index] > 0) this.potentialWeatherMask[index] = 1;
        }
      }
    }
    this.rawFrame = this.sourceFrames.has(0) ? this.exactSourceFrameAt(0) : null;
  }

  sourceFrameAt(frameIndex) {
    if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= this.frameCount) {
      throw new RangeError(`Source frame index must be an integer from 0 to ${this.frameCount - 1}.`);
    }
    const values = this.sourceFrames.get(frameIndex);
    if (!values) throw new Error(`Real weather source frame ${frameIndex} is not available.`);
    this.sourceFrames.delete(frameIndex);
    this.sourceFrames.set(frameIndex, values);
    return values;
  }

  isSourceFrameAvailable(frameIndex) {
    return this.sourceFrames.has(frameIndex);
  }

  requiredSourceFrames(time) {
    const frame = this.prepareFrame(time);
    return frame.frame0 === frame.frame1 ? [frame.frame0] : [frame.frame0, frame.frame1];
  }

  hasRequiredSourceFrames(time) {
    return this.requiredSourceFrames(time).every((frameIndex) => this.isSourceFrameAvailable(frameIndex));
  }

  addSourceFrame(frameIndex, values, { validated = false } = {}) {
    if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= this.frameCount) throw new RangeError(`Source frame index must be an integer from 0 to ${this.frameCount - 1}.`);
    if (!(values instanceof Float32Array) || values.length !== this.frameSize) throw new Error(`Real weather source frame ${frameIndex} does not match the source-grid node count.`);
    this.sourceFrames.delete(frameIndex);
    this.sourceFrames.set(frameIndex, values);
    if (validated) this.validatedSourceFrames.add(frameIndex);
    while (this.sourceFrames.size > this.sourceFrameCacheLimit) {
      const evictedFrameIndex = this.sourceFrames.keys().next().value;
      this.sourceFrames.delete(evictedFrameIndex);
      this.onSourceFrameCacheEvent?.({ type: 'eviction', frameIndex: evictedFrameIndex });
    }
    this.onSourceFrameCacheEvent?.({ type: 'insertion', frameIndex });
    if (frameIndex === 0 && !this.rawFrame) this.rawFrame = this.exactSourceFrameAt(0);
    return values;
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
    const progress = sourcePosition - frame0;
    // Exact source times intentionally require exactly one source frame.
    const frame1 = progress === 0 ? frame0 : Math.min(frame0 + 1, this.frameCount - 1);
    return new RealWeatherSequenceFrame(this, frame0, frame1, progress);
  }

  exactSourceFrameAt(frameIndex) {
    if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= this.frameCount) {
      throw new RangeError(`Source frame index must be an integer from 0 to ${this.frameCount - 1}.`);
    }
    const frameValues = this.sourceFrameAt(frameIndex);
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
    return frame;
  }

  interpolateRain(frame, baseIndex, x1y0, x0y1, x1y1, longitudeFraction, latitudeFraction) {
    const source = this.sourceFrameAt(frame);
    return interpolatePrepared(
      source,
      baseIndex,
      x1y0,
      x0y1,
      x1y1,
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
  const grid = objectAt(root.spatial_grid, 'spatial_grid');
  const time = objectAt(root.time, 'time');
  const channels = objectAt(root.channels, 'channels');
  const rain = objectAt(root.rain, 'rain');
  const supportMask = objectAt(root.support_mask, 'support_mask');
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

  const frameNodeCount = width * height;
  const expectedFrameByteCount = frameNodeCount * Float32Array.BYTES_PER_ELEMENT;
  if (rain.available !== true || channels.rain !== true) failSequence('rain must be available.');
  assertSequenceEqual(rain.dtype, 'Float32', 'rain.dtype');
  assertSequenceEqual(rain.byte_order, 'little-endian', 'rain.byte_order');
  assertSequenceEqual(rain.physical_units, 'mm/h', 'rain.physical_units');
  if (sequenceInteger(rain.frame_node_count, 'rain.frame_node_count') !== frameNodeCount) failSequence('rain.frame_node_count does not match the spatial grid.');
  if (sequenceInteger(rain.frame_byte_length, 'rain.frame_byte_length') !== expectedFrameByteCount) failSequence('rain.frame_byte_length does not match the Float32 source-grid frame size.');
  if (!Array.isArray(rain.frame_assets) || rain.frame_assets.length !== frameCount) failSequence('rain.frame_assets must contain one asset per source frame.');
  for (const [index, asset] of rain.frame_assets.entries()) sequenceString(asset, `rain.frame_assets[${index}]`);

  assertSequenceEqual(supportMask.encoding, SUPPORT_MASK_ENCODING, 'support_mask.encoding');
  sequenceString(supportMask.asset, 'support_mask.asset');
  if (sequenceInteger(supportMask.node_count, 'support_mask.node_count') !== frameNodeCount) failSequence('support_mask.node_count does not match the spatial grid.');
  const expectedSupportByteCount = Math.ceil(frameNodeCount / 8);
  if (sequenceInteger(supportMask.byte_length, 'support_mask.byte_length') !== expectedSupportByteCount) failSequence('support_mask.byte_length does not match the packed node count.');
  assertSequenceEqual(supportMask.positive_condition, 'rain > 0', 'support_mask.positive_condition');
  assertSequenceEqual(supportMask.trailing_unused_bits, 'zero', 'support_mask.trailing_unused_bits');

  const longitudeStart = sequenceNumber(grid.longitude_start, 'spatial_grid.longitude_start');
  const latitudeStart = sequenceNumber(grid.latitude_start, 'spatial_grid.latitude_start');
  const longitudeSpacing = sequenceNumber(grid.longitude_spacing, 'spatial_grid.longitude_spacing');
  const latitudeSpacing = sequenceNumber(grid.latitude_spacing, 'spatial_grid.latitude_spacing');
  if (!(longitudeSpacing > 0) || !(latitudeSpacing > 0)) failSequence('spatial grid spacing must be positive.');
  assertSequenceEqual(grid.longitude_order, 'west_to_east', 'spatial_grid.longitude_order');
  assertSequenceEqual(grid.latitude_order, 'south_to_north', 'spatial_grid.latitude_order');
  assertSequenceEqual(source.normalized_units, 'mm/h', 'source.normalized_units');
  const phenomena = root.phenomena === undefined ? null : objectAt(root.phenomena, 'phenomena');
  if (phenomena) {
    if (typeof phenomena.available !== 'boolean') failSequence('phenomena.available must be boolean.');
    assertSequenceEqual(phenomena.dtype, 'Uint8', 'phenomena.dtype');
    if (phenomena.byte_order !== undefined) failSequence('phenomena.byte_order must be omitted for Uint8 phenomena.');
    if (!phenomena.enum || typeof phenomena.enum !== 'object') failSequence('phenomena.enum must be an object.');
    for (const [name, value] of Object.entries(PHENOMENON_ENUM)) assertSequenceEqual(phenomena.enum[name], value, `phenomena.enum.${name}`);
    if (phenomena.available) {
      if (!Array.isArray(phenomena.frame_assets) || phenomena.frame_assets.length !== frameCount) failSequence('available phenomena.frame_assets must contain one asset per source frame.');
      if (sequenceInteger(phenomena.frame_byte_length, 'phenomena.frame_byte_length') !== frameNodeCount) failSequence('phenomena.frame_byte_length must equal the source node count.');
    } else if (phenomena.frame_assets !== undefined && (!Array.isArray(phenomena.frame_assets) || phenomena.frame_assets.length !== 0)) {
      failSequence('unavailable phenomena.frame_assets must be empty when present.');
    }
  }
  if (channels.phenomena !== Boolean(phenomena?.available)) failSequence('channels.phenomena must match phenomena availability.');

  return {
    width, height, frameCount, frameNodeCount, expectedFrameByteCount, expectedSupportByteCount,
    longitudeStart, latitudeStart, longitudeSpacing, latitudeSpacing, timestamps: time.timestamps,
    rainFrameAssets: Object.freeze([...rain.frame_assets]), supportMaskAsset: supportMask.asset,
    phenomenaAvailable: Boolean(phenomena?.available)
  };
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

function resolveSequenceAssetUrl(metadataUrl, asset) {
  if (typeof location !== 'undefined') {
    try { return new URL(asset, new URL(metadataUrl, location.href)).href; } catch { /* fall through */ }
  }
  try {
    return new URL(asset, metadataUrl).href;
  } catch {
    return asset;
  }
}

export function decodePackedWeatherSupport(maskBuffer, nodeCount) {
  const packed = new Uint8Array(maskBuffer);
  const expectedByteLength = Math.ceil(nodeCount / 8);
  if (packed.byteLength !== expectedByteLength) failSequence(`support mask byte length is ${packed.byteLength}, expected ${expectedByteLength}.`);
  const trailingBits = nodeCount % 8;
  if (trailingBits && (packed[packed.length - 1] >>> trailingBits) !== 0) failSequence('support mask has non-zero trailing unused bits.');
  // The asset stays compact on the wire. The prepared-geometry constructor
  // probes four arbitrary source nodes per stencil, so an indexed Uint8 view
  // keeps that one-time topology build simple and synchronous.
  const potentialWeatherMask = new Uint8Array(nodeCount);
  for (let index = 0; index < nodeCount; index++) potentialWeatherMask[index] = (packed[index >> 3] >>> (index & 7)) & 1;
  return potentialWeatherMask;
}

export function packWeatherSupport(potentialWeatherMask) {
  const packed = new Uint8Array(Math.ceil(potentialWeatherMask.length / 8));
  for (let index = 0; index < potentialWeatherMask.length; index++) if (potentialWeatherMask[index]) packed[index >> 3] |= 1 << (index & 7);
  return packed;
}

function validateRainSourceFrame(values, frameIndex) {
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (!Number.isFinite(value) || value < 0) failSequence(`rain frame ${frameIndex} has an invalid value at element ${index}.`);
  }
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

function createSourceFrameScheduler({ frameCount, concurrency, isAvailable, getSourceCacheEntryCount, fetchFrame, sourceFrameByteLength }) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Source-frame fetch concurrency must be a positive integer.');
  const requests = new Map();
  const replacementKeys = new Map();
  const active = new Map();
  let nextRequestId = 1;
  let backgroundPausedByMap = false;
  const diagnostics = {
    configuredConcurrency: concurrency,
    activeFetches: 0,
    peakActiveFetches: 0,
    highQueueSize: 0,
    lowQueueSize: 0,
    peakHighQueueSize: 0,
    peakLowQueueSize: 0,
    staleQueuedRequirementsDropped: 0,
    sourceFetchesStarted: 0,
    sourceFetchesCompleted: 0,
    highRequirementSets: 0,
    lowRequirementSets: 0,
    highPriorityFetchesStarted: 0,
    staleFetchesStarted: 0,
    staleFetchesCompleted: 0,
    cacheHits: 0,
    cacheMisses: 0,
    validationScans: 0,
    sourceCacheInsertions: 0,
    lruEvictions: 0,
    sourceCacheEntries: 0,
    peakSourceCacheEntries: 0,
    sourceCacheBytes: 0,
    peakSourceCacheBytes: 0,
    logicalSourceBytesRequested: 0,
    logicalSourceBytesForStaleFetches: 0,
    latestTargetGeneration: 0,
    backgroundPrefetchPaused: false,
    backgroundPrefetchPauseCount: 0,
    backgroundPrefetchResumeCount: 0
  };

  function requiredFrames() {
    const pending = new Map();
    for (const request of requests.values()) {
      for (const frameIndex of request.pending) {
        if (active.has(frameIndex)) continue;
        const existing = pending.get(frameIndex);
        if (!existing || (request.priority === 'high' && existing.priority === 'low')) {
          pending.set(frameIndex, { priority: request.priority, order: request.order });
        } else if (request.priority === existing.priority) {
          existing.order = Math.min(existing.order, request.order);
        }
      }
    }
    return pending;
  }

  function hasHighWork() {
    for (const request of requests.values()) if (request.priority === 'high' && request.pending.size) return true;
    for (const request of active.values()) if (request.priority === 'high') return true;
    return false;
  }

  function updateQueueDiagnostics() {
    const pending = requiredFrames();
    let high = 0;
    let low = 0;
    for (const entry of pending.values()) {
      if (entry.priority === 'high') high++;
      else low++;
    }
    diagnostics.highQueueSize = high;
    diagnostics.lowQueueSize = low;
    diagnostics.peakHighQueueSize = Math.max(diagnostics.peakHighQueueSize, high);
    diagnostics.peakLowQueueSize = Math.max(diagnostics.peakLowQueueSize, low);
    const paused = backgroundPausedByMap || hasHighWork();
    if (paused !== diagnostics.backgroundPrefetchPaused) {
      diagnostics.backgroundPrefetchPaused = paused;
      if (paused) diagnostics.backgroundPrefetchPauseCount++;
      else diagnostics.backgroundPrefetchResumeCount++;
    }
    return pending;
  }

  function updateSourceCacheDiagnostics() {
    const entries = getSourceCacheEntryCount();
    diagnostics.sourceCacheEntries = entries;
    diagnostics.peakSourceCacheEntries = Math.max(diagnostics.peakSourceCacheEntries, entries);
    diagnostics.sourceCacheBytes = entries * sourceFrameByteLength;
    diagnostics.peakSourceCacheBytes = Math.max(diagnostics.peakSourceCacheBytes, diagnostics.sourceCacheBytes);
  }

  function settleAvailableRequests() {
    for (const [id, request] of requests) {
      for (const frameIndex of request.pending) if (isAvailable(frameIndex)) request.pending.delete(frameIndex);
      if (request.pending.size) continue;
      requests.delete(id);
      if (request.replaceKey && replacementKeys.get(request.replaceKey) === id) replacementKeys.delete(request.replaceKey);
      request.resolve({ status: 'ready' });
    }
  }

  function cancelRequest(id, retainedFrameIndices = null) {
    const request = requests.get(id);
    if (!request) return;
    requests.delete(id);
    if (request.replaceKey && replacementKeys.get(request.replaceKey) === id) replacementKeys.delete(request.replaceKey);
    for (const frameIndex of request.pending) {
      if (!active.has(frameIndex) && !retainedFrameIndices?.has(frameIndex)) diagnostics.staleQueuedRequirementsDropped++;
    }
    request.resolve({ status: 'superseded' });
  }

  function rejectRequestsForFrame(frameIndex, error) {
    for (const [id, request] of requests) {
      if (!request.pending.has(frameIndex)) continue;
      requests.delete(id);
      if (request.replaceKey && replacementKeys.get(request.replaceKey) === id) replacementKeys.delete(request.replaceKey);
      request.reject(error);
    }
  }

  function highStillNeeds(frameIndex) {
    for (const request of requests.values()) if (request.priority === 'high' && request.pending.has(frameIndex)) return true;
    return false;
  }

  function startFrame(frameIndex, priority) {
    active.set(frameIndex, { priority });
    diagnostics.activeFetches = active.size;
    diagnostics.peakActiveFetches = Math.max(diagnostics.peakActiveFetches, active.size);
    diagnostics.sourceFetchesStarted++;
    diagnostics.logicalSourceBytesRequested += sourceFrameByteLength;
    if (priority === 'high') diagnostics.highPriorityFetchesStarted++;
    Promise.resolve(fetchFrame(frameIndex)).then(() => {
      active.delete(frameIndex);
      diagnostics.activeFetches = active.size;
      diagnostics.sourceFetchesCompleted++;
      if (priority === 'high') {
        if (!highStillNeeds(frameIndex)) {
          diagnostics.staleFetchesStarted++;
          diagnostics.staleFetchesCompleted++;
          diagnostics.logicalSourceBytesForStaleFetches += sourceFrameByteLength;
        }
      }
      settleAvailableRequests();
      pump();
    }, (error) => {
      active.delete(frameIndex);
      diagnostics.activeFetches = active.size;
      rejectRequestsForFrame(frameIndex, error);
      pump();
    });
  }

  function pump() {
    settleAvailableRequests();
    let pending = updateQueueDiagnostics();
    while (active.size < concurrency) {
      const hasHigh = [...pending.values()].some((entry) => entry.priority === 'high');
      const candidates = [...pending.entries()]
        .filter(([, entry]) => entry.priority === (hasHigh ? 'high' : 'low'))
        .filter(([, entry]) => !backgroundPausedByMap || entry.priority === 'high')
        .sort(([leftIndex, left], [rightIndex, right]) => left.order - right.order || leftIndex - rightIndex);
      if (!candidates.length) break;
      const [frameIndex, entry] = candidates[0];
      startFrame(frameIndex, entry.priority);
      pending = updateQueueDiagnostics();
    }
  }

  function requestFrames(frameIndices, { priority = 'high', replaceKey = null, latestTargetGeneration = null } = {}) {
    if (priority !== 'high' && priority !== 'low') throw new Error('Source-frame priority must be high or low.');
    const unique = [...new Set(frameIndices)];
    if (priority === 'high') diagnostics.highRequirementSets++;
    else diagnostics.lowRequirementSets++;
    for (const frameIndex of unique) {
      if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= frameCount) throw new RangeError(`Source frame index must be an integer from 0 to ${frameCount - 1}.`);
    }
    if (replaceKey && replacementKeys.has(replaceKey)) cancelRequest(replacementKeys.get(replaceKey), new Set(unique));
    const pending = new Set();
    for (const frameIndex of unique) {
      if (isAvailable(frameIndex)) diagnostics.cacheHits++;
      else {
        diagnostics.cacheMisses++;
        pending.add(frameIndex);
      }
    }
    if (latestTargetGeneration !== null) diagnostics.latestTargetGeneration = latestTargetGeneration;
    if (!pending.size) return Promise.resolve({ status: 'ready' });
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const id = nextRequestId++;
    requests.set(id, { pending, priority, replaceKey, order: id, resolve, reject });
    if (replaceKey) replacementKeys.set(replaceKey, id);
    pump();
    return promise;
  }

  return {
    requestFrames,
    setBackgroundPrefetchPaused(paused) {
      backgroundPausedByMap = Boolean(paused);
      pump();
    },
    recordValidationScan() { diagnostics.validationScans++; },
    recordCacheEvent(event) {
      if (event.type === 'insertion') diagnostics.sourceCacheInsertions++;
      else if (event.type === 'eviction') diagnostics.lruEvictions++;
      updateSourceCacheDiagnostics();
    },
    diagnostics() {
      updateQueueDiagnostics();
      updateSourceCacheDiagnostics();
      return { ...diagnostics };
    }
  };
}

export function beginRealWeatherSequenceLoad(metadataUrl, { onTiming = null, sourceFrameCacheLimit = DEFAULT_SOURCE_FRAME_CACHE_LIMIT, sourceFrameFetchConcurrency = 1 } = {}) {
  const timing = typeof onTiming === 'function' ? onTiming : () => {};
  const metadataReady = loadSequenceMetadata(metadataUrl, timing);
  const supportReady = metadataReady.then(async (validated) => {
    timing('weather-support-fetch-start');
    const response = await fetchSequenceAsset(resolveSequenceAssetUrl(metadataUrl, validated.supportMaskAsset));
    timing('weather-support-fetch-headers');
    const buffer = await response.arrayBuffer();
    timing('weather-support-fetch-complete');
    const potentialWeatherMask = decodePackedWeatherSupport(buffer, validated.frameNodeCount);
    timing('weather-support-validation-complete');
    return potentialWeatherMask;
  });
  let scheduler = null;
  const sequenceReady = Promise.all([metadataReady, supportReady]).then(([validated, potentialWeatherMask]) => {
    const { longitudes, latitudes } = axesFromSequenceMetadata(validated);
    const sequence = new RealWeatherSequence({
      longitudes, latitudes, frameCount: validated.frameCount,
      longitudeSpacing: validated.longitudeSpacing, latitudeSpacing: validated.latitudeSpacing,
      timestamps: validated.timestamps, potentialWeatherMask, sourceFrameCacheLimit,
      onSourceFrameCacheEvent: (event) => scheduler?.recordCacheEvent(event)
    });
    timing('weather-sequence-construction-complete');
    return sequence;
  });
  const schedulerReady = Promise.all([metadataReady, sequenceReady]).then(([validated, sequence]) => {
    scheduler = createSourceFrameScheduler({
      frameCount: validated.frameCount,
      concurrency: sourceFrameFetchConcurrency,
      isAvailable: (frameIndex) => sequence.isSourceFrameAvailable(frameIndex),
      getSourceCacheEntryCount: () => sequence.sourceFrames.size,
      sourceFrameByteLength: validated.expectedFrameByteCount,
      async fetchFrame(frameIndex) {
      timing(`weather-frame-${frameIndex}-fetch-start`);
      const response = await fetchSequenceAsset(resolveSequenceAssetUrl(metadataUrl, validated.rainFrameAssets[frameIndex]));
      timing(`weather-frame-${frameIndex}-fetch-headers`);
      const buffer = await response.arrayBuffer();
      timing(`weather-frame-${frameIndex}-body-complete`);
      if (buffer.byteLength !== validated.expectedFrameByteCount) failSequence(`rain frame ${frameIndex} byte length is ${buffer.byteLength}, expected ${validated.expectedFrameByteCount}.`);
      const values = new Float32Array(buffer);
      if (values.length !== validated.frameNodeCount) failSequence(`rain frame ${frameIndex} element count does not match metadata.`);
      // A re-downloaded logical frame is new transport input. Validate every
      // payload rather than trusting that an earlier cache entry shared its bytes.
      scheduler.recordValidationScan();
      validateRainSourceFrame(values, frameIndex);
      sequence.addSourceFrame(frameIndex, values, { validated: true });
      timing(`weather-frame-${frameIndex}-validation-complete`);
      return values;
      }
    });
    return scheduler;
  });

  async function requestSourceFrames(frameIndices, options = {}) {
    const [sequence, frameScheduler] = await Promise.all([sequenceReady, schedulerReady]);
    const result = await frameScheduler.requestFrames(frameIndices, options);
    return { sequence, result };
  }

  async function requestSourceFrame(frameIndex, options = {}) {
    const { sequence, result } = await requestSourceFrames([frameIndex], options);
    return result.status === 'ready' ? sequence.sourceFrameAt(frameIndex) : null;
  }

  return {
    metadataReady,
    supportReady,
    sequenceReady,
    requestSourceFrame,
    requestSourceFrames,
    async loadSequence(initialFrameIndex = 0) {
      await requestSourceFrame(initialFrameIndex, { priority: 'high' });
      return sequenceReady;
    },
    async prefetchFrames(frameIndices) {
      await requestSourceFrames(frameIndices, { priority: 'low', replaceKey: 'background-prefetch' });
      return sequenceReady;
    },
    setBackgroundPrefetchPaused(paused) {
      void schedulerReady.then((frameScheduler) => frameScheduler.setBackgroundPrefetchPaused(paused));
    },
    diagnostics() {
      return scheduler?.diagnostics() || null;
    }
  };
}

export async function loadRealWeatherSequence(metadataUrl, options = {}) {
  return beginRealWeatherSequenceLoad(metadataUrl, options).loadSequence();
}
