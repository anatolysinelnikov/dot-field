import { TARGET_SPACING } from './config.js';

const VIEWPORT_MARGIN = 96;
// Complete support of the synthetic system across its deterministic trajectory.
// This is a data-support cull, not a camera-dependent sampling grid.
const WEATHER_SUPPORT = { west: -40, east: 32, south: 39, north: 71 };

function edgeLength(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function triangleMayBeVisible(points, width, height) {
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  return maxX >= -VIEWPORT_MARGIN && minX <= width + VIEWPORT_MARGIN
    && maxY >= -VIEWPORT_MARGIN && minY <= height + VIEWPORT_MARGIN;
}

function faceMayContainWeather(face, icosphere) {
  if (face.level < 3) return true;
  const coordinates = face.vertices.map((id) => icosphere.vertices[id].lngLat);
  const longitudes = coordinates.map(([longitude]) => longitude);
  const latitudes = coordinates.map(([, latitude]) => latitude);
  // Faces near the antimeridian remain eligible; the weather support is far
  // from it and a false positive here only costs a small amount of traversal.
  if (Math.max(...longitudes) - Math.min(...longitudes) > 180) return true;
  return Math.max(...longitudes) >= WEATHER_SUPPORT.west && Math.min(...longitudes) <= WEATHER_SUPPORT.east
    && Math.max(...latitudes) >= WEATHER_SUPPORT.south && Math.min(...latitudes) <= WEATHER_SUPPORT.north;
}

export function selectGeographicSamples(map, icosphere) {
  const canvas = map.getCanvas();
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const levels = new Map();
  let finest = 0;
  let leaves = 0;

  const visit = (face) => {
    if (!faceMayContainWeather(face, icosphere)) return;
    const vertices = face.vertices.map((id) => icosphere.vertices[id]);
    const projected = vertices.map((vertex) => map.project(vertex.lngLat));
    const visible = triangleMayBeVisible(projected, width, height);
    const longestEdge = Math.max(
      edgeLength(projected[0], projected[1]), edgeLength(projected[1], projected[2]), edgeLength(projected[2], projected[0])
    );
    // Projected geometric size drives refinement. Screen centre is never used.
    if ((visible || face.level < 2) && face.level < icosphere.maxLevel && longestEdge > TARGET_SPACING * 1.75) {
      for (const child of icosphere.subdivide(face)) visit(child);
      return;
    }
    if (!visible) return;
    leaves++;
    finest = Math.max(finest, face.level);
    for (const id of face.vertices) levels.set(id, Math.max(levels.get(id) ?? 0, face.level));
  };

  for (const root of icosphere.levels[0]) visit(root);
  return {
    samples: [...levels].map(([id, level]) => ({ vertex: icosphere.vertices[id], level, spacing: icosphere.sampleSpacing(level) })),
    finest,
    leaves
  };
}
