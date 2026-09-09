import { LOOP_SECONDS } from './config.js';

const TEMPORAL_FRAME_SECONDS = 0.1;
export const TEMPORAL_FRAME_COUNT = Math.round(LOOP_SECONDS / TEMPORAL_FRAME_SECONDS);

export function geographicTemporalFrameAt(time) {
  const wrapped = ((time % 1) + 1) % 1;
  const rawScaled = wrapped * TEMPORAL_FRAME_COUNT;
  // Keep exact keyframe boundaries stable despite floating-point drift.
  const scaled = Math.abs(rawScaled - Math.round(rawScaled)) < 1e-9 ? Math.round(rawScaled) : rawScaled;
  const index = Math.floor(scaled) % TEMPORAL_FRAME_COUNT;
  return { index, progress: scaled - Math.floor(scaled) };
}

function setMatrix(gl, location, value) {
  if (location && value) gl.uniformMatrix4fv(location, false, value);
}

export function setGeographicProjection(gl, locations, projection) {
  setMatrix(gl, locations.matrix, projection.mainMatrix);
  setMatrix(gl, locations.fallbackMatrix, projection.fallbackMatrix);
  setMatrix(gl, locations.projectionMatrix, projection.mainMatrix);
  if (locations.tileMercatorCoords) gl.uniform4f(locations.tileMercatorCoords, ...projection.tileMercatorCoords);
  if (locations.clippingPlane && projection.clippingPlane) gl.uniform4f(locations.clippingPlane, ...projection.clippingPlane);
  if (locations.projectionTransition) gl.uniform1f(locations.projectionTransition, projection.projectionTransition);
}
