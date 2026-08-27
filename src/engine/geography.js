import {
  beginRealWeatherSequenceLoad,
  loadRealWeatherSequence,
  loadRealWeatherSnapshot,
  RealWeatherSequenceAssetsUnavailableError
} from './real-weather.js';

function mercatorXToLongitude(x) {
  return x * 360 - 180;
}

function mercatorYToLatitude(y) {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;
}

export const WEATHER_REGION = Object.freeze({
  center: [45.0300, 43.3500],
  initialZoom: 5.8
});

// The full positive-rain union across all 19 source frames plus one full
// source-grid cell on every side. The binary sequence adds one further
// source-grid cell as its bilinear interpolation halo.
export const WEATHER_SUPPORT = Object.freeze({
  west: 29.719999313354492,
  east: 71.63999938964844,
  south: 41.79999923706055,
  north: 70.44000244140625
});

let activeWeatherField = null;

export function geographicToSynthetic(longitude, latitude) {
  // Preserve the shared renderer-facing function name; real-data frames use
  // geographic coordinates directly rather than synthetic x/y coordinates.
  return { x: longitude, y: latitude };
}

export function geographicIntensityAt(longitude, latitude, time) {
  if (!activeWeatherField) throw new Error('Real weather snapshot has not been loaded.');
  return activeWeatherField.prepareFrame(time).sample(longitude, latitude);
}

export function prepareGeographicFieldFrame(time) {
  if (!activeWeatherField) throw new Error('Real weather snapshot has not been loaded.');
  return activeWeatherField.prepareFrame(time);
}

export function geographicPreparedIntensityAt(frame, point, output) {
  return frame.sample(point.x, point.y, output);
}

export function prepareGeographicSamplingGeometry(frame, levelData, reusable = null) {
  if (typeof frame.prepareRectangularSamplingGeometry === 'function'
    && levelData.width > 0 && levelData.height > 0 && levelData.width * levelData.height === levelData.count) {
    const longitudes = new Float64Array(levelData.width);
    const latitudes = new Float64Array(levelData.height);
    for (let column = 0; column < levelData.width; column++) {
      longitudes[column] = mercatorXToLongitude((levelData.minI + column) * levelData.spacing);
    }
    for (let row = 0; row < levelData.height; row++) {
      latitudes[row] = mercatorYToLatitude((levelData.minJ + row) * levelData.spacing);
    }
    return frame.prepareRectangularSamplingGeometry(longitudes, latitudes, levelData.width, levelData.height, reusable);
  }

  // Generic provider fallback for non-rectangular or legacy provider frames.
  const longitudes = new Float64Array(levelData.count);
  const latitudes = new Float64Array(levelData.count);
  for (let index = 0; index < levelData.count; index++) {
    const column = index % levelData.width;
    const row = Math.floor(index / levelData.width);
    longitudes[index] = mercatorXToLongitude((levelData.minI + column) * levelData.spacing);
    latitudes[index] = mercatorYToLatitude((levelData.minJ + row) * levelData.spacing);
  }
  return frame.prepareSamplingGeometry(longitudes, latitudes, reusable);
}

export function geographicPreparedIntensityAtGeometry(frame, geometry, index, output) {
  return frame.samplePrepared(geometry, index, output);
}

export function geographicPreparedIntensityAtGeometryBatch(frame, geometry) {
  return frame.samplePreparedBatch(geometry);
}

export function geographicPrepareTemporalSampling(frame, geometry) {
  return typeof frame?.prepareTemporalSampling === 'function'
    ? frame.prepareTemporalSampling(geometry)
    : null;
}

export function geographicPreparedIntensityAtXY(frame, longitude, latitude, output) {
  return frame.sample(longitude, latitude, output);
}

export function setActiveWeatherField(field) {
  activeWeatherField = field;
}

export async function loadActiveWeatherField({ onTiming = null } = {}) {
  let field;
  try {
    field = await loadRealWeatherSequence(
      './data/generated/202608262200/metadata.json',
      { onTiming }
    );
  } catch (error) {
    if (!(error instanceof RealWeatherSequenceAssetsUnavailableError)) throw error;
    console.warn('Real weather sequence assets are unavailable; using the checked-in CSV snapshot.');
    field = await loadRealWeatherSnapshot('./data/mrl_z3_t+40min_376x239.csv');
  }
  setActiveWeatherField(field);
  return field;
}

export function beginActiveWeatherLoad({ onTiming = null } = {}) {
  const sequenceLoad = beginRealWeatherSequenceLoad(
    './data/generated/202608262200/metadata.json',
    { onTiming }
  );
  let fallbackPromise = null;
  const metadataReady = sequenceLoad.metadataReady.catch((error) => {
    if (!(error instanceof RealWeatherSequenceAssetsUnavailableError)) throw error;
    console.warn('Real weather sequence assets are unavailable; using the checked-in CSV snapshot.');
    fallbackPromise = loadRealWeatherSnapshot('./data/mrl_z3_t+40min_376x239.csv');
    return null;
  });
  let fieldPromise = null;

  return {
    metadataReady,
    supportReady: sequenceLoad.supportReady,
    loadSequence(initialFrameIndex = 0) {
      if (fieldPromise) return fieldPromise;
      fieldPromise = (async () => {
        const metadata = await metadataReady;
        let field;
        if (metadata === null) {
          field = await fallbackPromise;
        } else {
          try {
            field = await sequenceLoad.loadSequence(initialFrameIndex);
          } catch (error) {
            if (!(error instanceof RealWeatherSequenceAssetsUnavailableError)) throw error;
            console.warn('Real weather sequence assets are unavailable; using the checked-in CSV snapshot.');
            field = await loadRealWeatherSnapshot('./data/mrl_z3_t+40min_376x239.csv');
          }
        }
        setActiveWeatherField(field);
        return field;
      })();
      return fieldPromise;
    },
    async requestSourceFrame(frameIndex) {
      const field = await this.loadSequence(0);
      if (field.frameCount === undefined) return field;
      await sequenceLoad.requestSourceFrame(frameIndex);
      return field;
    },
    async requestTime(normalizedTime) {
      const field = await this.loadSequence(0);
      if (field.frameCount === undefined) return field;
      await Promise.all(field.requiredSourceFrames(normalizedTime).map((frameIndex) => sequenceLoad.requestSourceFrame(frameIndex)));
      return field;
    },
    async prefetchRemaining({ concurrency = 1 } = {}) {
      const field = await this.loadSequence(0);
      if (field.frameCount === undefined) return field;
      await sequenceLoad.prefetchFrames(Array.from({ length: field.frameCount - 1 }, (_, index) => index + 1), { concurrency });
      // The bounded LRU intentionally cannot retain all 19 frames. Restore
      // the opening adjacent pair after the forward pass so enabled playback
      // can start at t=0 without an avoidable on-demand stall.
      await sequenceLoad.requestSourceFrame(0);
      await sequenceLoad.requestSourceFrame(1);
      return field;
    }
  };
}
