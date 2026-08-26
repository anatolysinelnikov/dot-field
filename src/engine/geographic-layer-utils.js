import { LOOP_SECONDS } from './config.js';

const TEMPORAL_FRAME_SECONDS = 0.1;
// This is the number of intervals; the finite sequence also evaluates the
// terminal keyframe at index TEMPORAL_FRAME_COUNT.
export const TEMPORAL_FRAME_COUNT = Math.round(LOOP_SECONDS / TEMPORAL_FRAME_SECONDS);

export function geographicTemporalFrameAt(time) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(time) ? time : 0));
  const rawScaled = clamped * TEMPORAL_FRAME_COUNT;
  // Keep exact keyframe boundaries stable despite floating-point drift.
  const scaled = Math.abs(rawScaled - Math.round(rawScaled)) < 1e-9 ? Math.round(rawScaled) : rawScaled;
  const index = Math.floor(scaled);
  return { index, nextIndex: Math.min(index + 1, TEMPORAL_FRAME_COUNT), progress: scaled - index };
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
