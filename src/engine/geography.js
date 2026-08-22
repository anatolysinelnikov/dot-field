import { intensityAt } from './field.js';
import { mix, smoothstep } from './math.js';

// Keep the geographic experiment anchor in one place. Changing this object is
// sufficient to move the synthetic system to another test region.
export const WEATHER_REGION = Object.freeze({
  center: [-0.1, 51.5],
  longitudeSpan: 1.8,
  latitudeSpan: 1.2,
  trajectory: Object.freeze({ startX: 0.33, endX: 0.67 }),
  fieldSupport: Object.freeze({ xRadius: 0.92, yRadius: 0.76 }),
  initialZoom: 6.2
});

const [centerLongitude, centerLatitude] = WEATHER_REGION.center;
const supportXMin = Math.min(WEATHER_REGION.trajectory.startX, WEATHER_REGION.trajectory.endX)
  - WEATHER_REGION.fieldSupport.xRadius;
const supportXMax = Math.max(WEATHER_REGION.trajectory.startX, WEATHER_REGION.trajectory.endX)
  + WEATHER_REGION.fieldSupport.xRadius;

// Complete deterministic support of the moving synthetic field. This is the
// only geographic support definition consumed by topology/LOD code.
export const WEATHER_SUPPORT = Object.freeze({
  west: centerLongitude + (supportXMin - 0.5) * WEATHER_REGION.longitudeSpan,
  east: centerLongitude + (supportXMax - 0.5) * WEATHER_REGION.longitudeSpan,
  south: centerLatitude - WEATHER_REGION.fieldSupport.yRadius * WEATHER_REGION.latitudeSpan,
  north: centerLatitude + WEATHER_REGION.fieldSupport.yRadius * WEATHER_REGION.latitudeSpan
});

function wrappedLongitudeDelta(longitude, centerLongitude) {
  return ((longitude - centerLongitude + 540) % 360) - 180;
}

export function geographicToSynthetic(longitude, latitude) {
  return {
    x: wrappedLongitudeDelta(longitude, centerLongitude) / WEATHER_REGION.longitudeSpan + 0.5,
    y: 0.5 - (latitude - centerLatitude) / WEATHER_REGION.latitudeSpan
  };
}

export function geographicIntensityAt(longitude, latitude, time) {
  const point = geographicToSynthetic(longitude, latitude);
  // The trajectory belongs to field time, never to the map camera or viewport.
  const travelX = mix(WEATHER_REGION.trajectory.startX, WEATHER_REGION.trajectory.endX, smoothstep(0, 1, time));
  return intensityAt(point.x, point.y, time, travelX);
}
