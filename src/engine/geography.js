import {
  beginRealWeatherSequenceLoad,
  INITIAL_PLAYBACK_SOURCE_FRAME_COUNT,
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
  if (!activeWeatherField) throw new Error('Real weather field has not been loaded.');
  return activeWeatherField.prepareFrame(time).sample(longitude, latitude);
}

export function prepareGeographicFieldFrame(time) {
  if (!activeWeatherField) throw new Error('Real weather field has not been loaded.');
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
  const sequenceLoad = beginRealWeatherSequenceLoad(
    ACTIVE_REAL_WEATHER_METADATA_URL,
    { onTiming, retainAllSourceFrames: true, sourceFrameFetchConcurrency: 1 }
  );
  const field = await sequenceLoad.loadSequence();
  await sequenceLoad.fillAllSourceFrames();
  setActiveWeatherField(field);
  return field;
}

export function beginActiveWeatherLoad({ onTiming = null, onResidencyChange = null } = {}) {
  const sequenceLoad = beginRealWeatherSequenceLoad(
    ACTIVE_REAL_WEATHER_METADATA_URL,
    {
      onTiming,
      onResidencyChange,
      // The active finite forecast is intentionally fully resident after its
      // background fill. This is source payload ownership, not derived LOD
      // materialization; the latter remains bounded by the renderer lifecycle.
      retainAllSourceFrames: true,
      sourceFrameFetchConcurrency: 1
    }
  );
  const metadataReady = sequenceLoad.metadataReady;
  let fieldPromise = null;
  let rollingHorizonKey = null;
  let rollingHorizonPromise = null;
  let fullSequenceFillPromise = null;

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

  function startFullSequenceFill(field) {
    if (field.frameCount === undefined || fullSequenceFillPromise) return fullSequenceFillPromise;
    onTiming?.('full-sequence-fill-start');
    fullSequenceFillPromise = sequenceLoad.fillAllSourceFrames()
      .then((sequence) => {
        onTiming?.('full-sequence-residency-complete');
        return sequence;
      })
      .catch((error) => {
        console.error('Unable to complete full weather source residency.', error);
        return null;
      });
    return fullSequenceFillPromise;
  }

  return {
    metadataReady,
    supportReady: sequenceLoad.supportReady,
    loadSequence(initialFrameIndex = 0) {
      if (fieldPromise) return fieldPromise;
      fieldPromise = (async () => {
        await metadataReady;
        const field = await sequenceLoad.loadSequence(initialFrameIndex);
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
      const frameIndices = sourceFrameIndicesForInitialPlayback(field);
      await sequenceLoad.requestSourceFrames(frameIndices, { priority: 'high' });
      // Playback readiness remains bounded to the initial buffer. Continue
      // loading the rest of this immutable generation in the background.
      void startFullSequenceFill(field);
      return { field, frameIndices };
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
      const diagnostics = sequenceLoad.diagnostics();
      return diagnostics ? {
        ...diagnostics,
        automaticFullSequenceFill: true
      } : diagnostics;
    }
  };
}
