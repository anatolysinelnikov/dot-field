import { WEATHER_SUPPORT } from './geography.js';
import { angularDistance } from './icosphere.js';
import { clamp } from './math.js';

export const MIN_ICO_LEVEL = 3;
export const MAX_ICO_LEVEL = 8;
const SUPPORT_CULL_LEVEL = 3;

// One discrete level is selected for the whole active weather region. The
// thresholds depend only on MapLibre zoom, never on projected screen geometry.
export function zoomToIcosphereLevel(zoom) {
  return clamp(Math.floor(Number(zoom)) + 3, MIN_ICO_LEVEL, MAX_ICO_LEVEL);
}

function faceMayContainWeather(face, icosphere) {
  // Choose the support tile set once at the coarsest active level. Descendants
  // of those tiles are always retained, which preserves additive refinement.
  if (face.level !== SUPPORT_CULL_LEVEL) return true;
  const coordinates = face.vertices.map((index) => icosphere.vertices[index].lngLat);
  const longitudes = coordinates.map(([longitude]) => longitude);
  const latitudes = coordinates.map(([, latitude]) => latitude);
  // Faces near the antimeridian remain eligible. The configured experiment
  // region is far from it, so this conservative case only adds traversal.
  if (Math.max(...longitudes) - Math.min(...longitudes) > 180) return true;
  return Math.max(...longitudes) >= WEATHER_SUPPORT.west && Math.min(...longitudes) <= WEATHER_SUPPORT.east
    && Math.max(...latitudes) >= WEATHER_SUPPORT.south && Math.min(...latitudes) <= WEATHER_SUPPORT.north;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function selectGeographicSamples(icosphere, level) {
  const leaves = [];
  const collect = (face) => {
    if (!faceMayContainWeather(face, icosphere)) return;
    if (face.level === level) {
      leaves.push(face);
      return;
    }
    for (const child of icosphere.subdivide(face)) collect(child);
  };
  for (const root of icosphere.levels[0]) collect(root);

  const incidentEdges = new Map();
  const activeIndices = new Set();
  const addIncident = (index, distance) => {
    let edges = incidentEdges.get(index);
    if (!edges) {
      edges = [];
      incidentEdges.set(index, edges);
    }
    edges.push(distance);
  };
  const addEdge = (left, right) => {
    const distance = angularDistance(icosphere.vertices[left].position, icosphere.vertices[right].position);
    addIncident(left, distance);
    addIncident(right, distance);
  };

  for (const face of leaves) {
    const [a, b, c] = face.vertices;
    activeIndices.add(a);
    activeIndices.add(b);
    activeIndices.add(c);
    addEdge(a, b);
    addEdge(b, c);
    addEdge(c, a);
  }

  const samples = [...activeIndices].map((index) => {
    const vertex = icosphere.vertices[index];
    return {
      id: vertex.identity,
      vertex,
      level,
      // Actual incident edge lengths capture the small spacing variation of
      // the subdivided icosphere instead of assuming a global edge angle.
      spacing: mean(incidentEdges.get(index) || [])
    };
  });
  return { samples, level, leafCount: leaves.length };
}
