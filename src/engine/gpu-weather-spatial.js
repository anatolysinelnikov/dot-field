import {
  mercatorXForIndex,
  mercatorYForIndex,
  mercatorXToLongitude,
  mercatorYToLatitude
} from './geographic-lod.js';

function sourceAxisPosition(sequence, axis, value) {
  const coordinates = axis === 'longitude' ? sequence.longitudes : sequence.latitudes;
  return sequence.locate(coordinates, value);
}
// CPU reference for the stable-GPU procedural coordinate contract. This is
// intentionally called only by setup/verification code; the draw path derives
// the same value from its L14 instance or fragment coordinates in GLSL.
export function proceduralSourceCoordinateForIndex(levelData, sequence, index) {
  if (!Number.isInteger(index) || index < 0 || index >= levelData.count) {
    throw new Error('Procedural weather sample index is out of bounds.');
  }
  const column = index % levelData.width;
  const row = (index - column) / levelData.width;
  const longitude = mercatorXToLongitude(mercatorXForIndex(levelData, index));
  const latitude = mercatorYToLatitude(mercatorYForIndex(levelData, index));
  if (longitude < sequence.bounds.west || longitude > sequence.bounds.east
    || latitude < sequence.bounds.south || latitude > sequence.bounds.north) return null;
  const longitudePosition = sourceAxisPosition(sequence, 'longitude', longitude);
  const latitudePosition = sourceAxisPosition(sequence, 'latitude', latitude);
  return {
    column,
    row,
    sourceX: longitudePosition.index + longitudePosition.fraction,
    sourceY: latitudePosition.index + latitudePosition.fraction
  };
}

function sourceCoordinateForMercator(sequence, x, y) {
  const longitude = mercatorXToLongitude(x);
  const latitude = mercatorYToLatitude(y);
  if (longitude < sequence.bounds.west || longitude > sequence.bounds.east
    || latitude < sequence.bounds.south || latitude > sequence.bounds.north) return null;
  const longitudePosition = sourceAxisPosition(sequence, 'longitude', longitude);
  const latitudePosition = sourceAxisPosition(sequence, 'latitude', latitude);
  return [
    longitudePosition.index + longitudePosition.fraction,
    latitudePosition.index + latitudePosition.fraction
  ];
}

// Every L14 sample is a product of the monotone longitude/latitude mappings.
// Enumerating the four window corners therefore gives the exact source-node
// tile rectangle without constructing a per-sample position or tile array.
export function sourceTileRangeForL14Window(levelData, sequence, tileSize = 128) {
  if (!levelData || levelData.level !== 14) throw new Error('Stable GPU weather tile ranges require L14 level data.');
  const points = [
    sourceCoordinateForMercator(sequence, mercatorXForIndex(levelData, 0), mercatorYForIndex(levelData, 0)),
    sourceCoordinateForMercator(sequence, mercatorXForIndex(levelData, levelData.width - 1), mercatorYForIndex(levelData, 0)),
    sourceCoordinateForMercator(sequence, mercatorXForIndex(levelData, 0), mercatorYForIndex(levelData, levelData.count - levelData.width)),
    sourceCoordinateForMercator(sequence, mercatorXForIndex(levelData, levelData.width - 1), mercatorYForIndex(levelData, levelData.count - 1))
  ].filter(Boolean);
  if (!points.length) return Object.freeze({ minTileX: 0, maxTileX: -1, minTileY: 0, maxTileY: -1 });
  const sourceXs = points.map(([x]) => x);
  const sourceYs = points.map(([, y]) => y);
  return Object.freeze({
    minTileX: Math.floor(Math.min(...sourceXs) / tileSize),
    maxTileX: Math.floor(Math.max(...sourceXs) / tileSize),
    minTileY: Math.floor(Math.min(...sourceYs) / tileSize),
    maxTileY: Math.floor(Math.max(...sourceYs) / tileSize)
  });
}
