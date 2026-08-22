import { intensityAt } from './field.js';
import { mix, smoothstep } from './math.js';

// Keep the geographic experiment anchor in one place. Changing this object is
// sufficient to move the synthetic system to another test region.
export const WEATHER_REGION = Object.freeze({
  center: [-4.0, 55.0],
  longitudeSpan: 32,
  latitudeSpan: 20,
  initialZoom: 3.25
});

function wrappedLongitudeDelta(longitude, centerLongitude) {
  return ((longitude - centerLongitude + 540) % 360) - 180;
}

export function geographicToSynthetic(longitude, latitude) {
  const [centerLongitude, centerLatitude] = WEATHER_REGION.center;
  return {
    x: wrappedLongitudeDelta(longitude, centerLongitude) / WEATHER_REGION.longitudeSpan + 0.5,
    y: 0.5 - (latitude - centerLatitude) / WEATHER_REGION.latitudeSpan
  };
}

export function geographicIntensityAt(longitude, latitude, time) {
  const point = geographicToSynthetic(longitude, latitude);
  // The trajectory belongs to field time, never to the map camera or viewport.
  const travelX = mix(0.33, 0.67, smoothstep(0, 1, time));
  return intensityAt(point.x, point.y, time, travelX);
}
