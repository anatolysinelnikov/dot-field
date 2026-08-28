import {
  beginRealWeatherSequenceLoad,
  INITIAL_PLAYBACK_SOURCE_FRAME_COUNT,
  loadRealWeatherSequence,
  loadRealWeatherSnapshot,
  RealWeatherSequenceAssetsUnavailableError,
  rollingPlaybackSourceFrameIndices
} from './real-weather.js';
import { setGeographicWeatherSupport } from './geographic-lod.js';

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

let activeWeatherField = null;
const ACTIVE_REAL_WEATHER_METADATA_URL = './data/generated/current/metadata.json';

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
  setGeographicWeatherSupport(field.weatherSupport || field.bounds);
}

export async function loadActiveWeatherField({ onTiming = null } = {}) {
  let field;
  try {
    field = await loadRealWeatherSequence(
      ACTIVE_REAL_WEATHER_METADATA_URL,
      { onTiming, retainAllSourceFrames: true }
    );
  } catch (error) {
    if (!(error instanceof RealWeatherSequenceAssetsUnavailableError)) throw error;
    console.warn('Real weather sequence assets are unavailable; using the checked-in CSV snapshot.');
    field = await loadRealWeatherSnapshot('./data/mrl_z3_t+40min_376x239.csv');
  }
  setActiveWeatherField(field);
  return field;
}

export function beginActiveWeatherLoad({ onTiming = null, onResidencyChange = null } = {}) {
  const sequenceLoad = beginRealWeatherSequenceLoad(
    ACTIVE_REAL_WEATHER_METADATA_URL,
    { onTiming, onResidencyChange, retainAllSourceFrames: true }
  );
  let fallbackPromise = null;
  const metadataReady = sequenceLoad.metadataReady.catch((error) => {
    if (!(error instanceof RealWeatherSequenceAssetsUnavailableError)) throw error;
    console.warn('Real weather sequence assets are unavailable; using the checked-in CSV snapshot.');
    fallbackPromise = loadRealWeatherSnapshot('./data/mrl_z3_t+40min_376x239.csv');
    return null;
  });
  let fieldPromise = null;
  let rollingHorizonKey = null;
  let rollingHorizonPromise = null;

  function sourceFrameIndicesForInitialPlayback(field) {
    return Array.from({ length: Math.min(INITIAL_PLAYBACK_SOURCE_FRAME_COUNT, field.frameCount) }, (_, index) => index);
  }

  function rebaseRollingPrefetch(field, normalizedTime) {
    const frameIndices = rollingPlaybackSourceFrameIndices(field.frameCount, normalizedTime);
    const key = frameIndices.join(',');
    if (key === rollingHorizonKey) return rollingHorizonPromise || Promise.resolve({ status: 'ready' });
    rollingHorizonKey = key;
    rollingHorizonPromise = sequenceLoad.requestSourceFrames(frameIndices, {
      priority: 'low', replaceKey: 'rolling-playback-prefetch'
    }).then(({ result }) => result);
    return rollingHorizonPromise;
  }

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
    async requestSourceFrame(frameIndex, options = {}) {
      const field = await this.loadSequence(0);
      if (field.frameCount === undefined) return field;
      const { result } = await sequenceLoad.requestSourceFrames([frameIndex], options);
      return { field, result };
    },
    async requestTimes(normalizedTimes, options = {}) {
      const field = await this.loadSequence(0);
      if (field.frameCount === undefined) return field;
      const frameIndices = [...new Set(normalizedTimes.flatMap((time) => field.requiredSourceFrames(time)))];
      const { result } = await sequenceLoad.requestSourceFrames(frameIndices, options);
      return { field, result };
    },
    async requestTime(normalizedTime, options = {}) {
      return this.requestTimes([normalizedTime], options);
    },
    async prepareInitialPlaybackBuffer() {
      const field = await this.loadSequence(0);
      if (field.frameCount === undefined) return field;
      await sequenceLoad.requestSourceFrames(sourceFrameIndicesForInitialPlayback(field), { priority: 'high' });
      // Keep the small rolling horizon first so the resident fill does not
      // consume LOW work that is immediately useful to playback.
      void rebaseRollingPrefetch(field, 0)
        .catch((error) => console.error('Unable to prefetch the initial rolling playback weather buffer.', error))
        .then(() => sequenceLoad.fillAllSourceFrames())
        .catch((error) => console.error('Unable to fill the resident source-frame sequence.', error));
      return { field, frameIndices: sourceFrameIndicesForInitialPlayback(field) };
    },
    rebaseRollingPrefetch(normalizedTime) {
      return this.loadSequence(0).then((field) => {
        if (field.frameCount === undefined) return { status: 'ready' };
        return rebaseRollingPrefetch(field, normalizedTime);
      });
    },
    setBackgroundPrefetchPaused(paused) {
      sequenceLoad.setBackgroundPrefetchPaused(paused);
    },
    diagnostics() {
      return sequenceLoad.diagnostics();
    }
  };
}
