import {
  loadRealWeatherSequence,
  loadRealWeatherSnapshot,
  RealWeatherSequenceAssetsUnavailableError
} from './real-weather.js';

export const WEATHER_REGION = Object.freeze({
  center: [45.0300, 43.3500],
  initialZoom: 5.8
});

// Nonzero snapshot envelope plus one source-grid cell on every side. The
// complete CSV field remains available to the provider sampler.
export const WEATHER_SUPPORT = Object.freeze({
  west: 39.93113,
  east: 50.12886,
  south: 41.57035,
  north: 45.12740
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

export function prepareGeographicSamplingGeometry(frame, samples, reusable = null) {
  const longitudes = new Float64Array(samples.length);
  const latitudes = new Float64Array(samples.length);
  for (let index = 0; index < samples.length; index++) {
    longitudes[index] = samples[index].lngLat[0];
    latitudes[index] = samples[index].lngLat[1];
  }
  return frame.prepareSamplingGeometry(longitudes, latitudes, reusable);
}

export function geographicPreparedIntensityAtGeometry(frame, geometry, index, output) {
  return frame.samplePrepared(geometry, index, output);
}

export function geographicPreparedIntensityAtXY(frame, longitude, latitude, output) {
  return frame.sample(longitude, latitude, output);
}

export function setActiveWeatherField(field) {
  activeWeatherField = field;
}

export async function loadActiveWeatherField() {
  let field;
  try {
    field = await loadRealWeatherSequence(
      './data/generated/202608262200/metadata.json',
      './data/generated/202608262200/rain.f32'
    );
  } catch (error) {
    if (!(error instanceof RealWeatherSequenceAssetsUnavailableError)) throw error;
    console.warn('Real weather sequence assets are unavailable; using the checked-in CSV snapshot.');
    field = await loadRealWeatherSnapshot('./data/mrl_z3_t+40min_376x239.csv');
  }
  setActiveWeatherField(field);
  return field;
}
