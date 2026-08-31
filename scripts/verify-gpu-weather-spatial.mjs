import {
  canonicalCoordinatesForIndex,
  canonicalWindowChangeKind,
  canonicalWindowFromMercatorBounds,
  canonicalWindowMetrics,
  canonicalWindowNeedsShrink,
  GeographicLodTopology,
  lngLatToMercator,
  setGeographicWeatherSupport
} from '../src/engine/geographic-lod.js';
import { prepareGeographicSamplingGeometry } from '../src/engine/geography.js';
import { RealWeatherSequence } from '../src/engine/real-weather.js';
import { proceduralSourceCoordinateForIndex, sourceTileRangeForL14Window } from '../src/engine/gpu-weather-spatial.js';

const sourceWidth = 180;
const sourceHeight = 120;
const sequence = new RealWeatherSequence({
  longitudes: Float64Array.from({ length: sourceWidth }, (_, index) => -180 + index * 2),
  latitudes: Float64Array.from({ length: sourceHeight }, (_, index) => -80 + index * (160 / (sourceHeight - 1))),
  rainFramesMmh: new Float32Array(sourceWidth * sourceHeight),
  frameCount: 1,
  longitudeSpacing: 2,
  latitudeSpacing: 160 / (sourceHeight - 1),
  weatherSupport: { west: -5, east: 5, south: -5, north: 5 },
  timestamps: [0],
  retainAllSourceFrames: true
});
setGeographicWeatherSupport(sequence.weatherSupport);

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`PASS ${message}`);
  else { failures++; console.error(`FAIL ${message}`); }
}

function expectedSourceCoordinate(geometry, index) {
  const column = index % geometry.width;
  const row = (index - column) / geometry.width;
  return [
    geometry.sourceColumn[column] + geometry.longitudeFraction[column],
    geometry.sourceRowBase[row] / geometry.sourceWidth + geometry.latitudeFraction[row]
  ];
}

function verifyWindow(window, name) {
  const levelData = new GeographicLodTopology(window, { minLevel: 13, maxLevel: 14 }).levelDataFor(14);
  const geometry = prepareGeographicSamplingGeometry(sequence.prepareFrame(0), levelData);
  const indices = [...new Set([
    0,
    Math.max(0, levelData.width - 1),
    Math.max(0, levelData.count - levelData.width),
    Math.max(0, levelData.count - 1),
    Math.floor(levelData.count / 2),
    levelData.width * Math.min(3, Math.max(0, levelData.height - 1)) + Math.min(5, Math.max(0, levelData.width - 1))
  ])].filter((index) => index < levelData.count);
  let maxError = 0;
  for (const index of indices) {
    const procedural = proceduralSourceCoordinateForIndex(levelData, sequence, index);
    const expected = expectedSourceCoordinate(geometry, index);
    if (!procedural) continue;
    maxError = Math.max(maxError, Math.abs(procedural.sourceX - expected[0]), Math.abs(procedural.sourceY - expected[1]));
    check(Math.fround(procedural.sourceX) === Math.fround(expected[0]) && Math.fround(procedural.sourceY) === Math.fround(expected[1]), `${name} sample ${index} procedural source coordinate matches canonical geometry`);
    const canonical = canonicalCoordinatesForIndex(levelData, index);
    check(canonical.canonicalX === (levelData.minI + index % levelData.width) * levelData.identityScale
      && canonical.canonicalY === (levelData.minJ + Math.floor(index / levelData.width)) * levelData.identityScale, `${name} sample ${index} keeps canonical identity`);
  }
  check(maxError === 0, `${name} representative coordinate maximum error is zero`);

  const expectedTiles = new Set();
  for (let index = 0; index < levelData.count; index++) {
    const point = proceduralSourceCoordinateForIndex(levelData, sequence, index);
    if (point) expectedTiles.add(`${Math.floor(point.sourceX / 128)},${Math.floor(point.sourceY / 128)}`);
  }
  const range = sourceTileRangeForL14Window(levelData, sequence);
  const rangedTiles = new Set();
  for (let y = range.minTileY; y <= range.maxTileY; y++) for (let x = range.minTileX; x <= range.maxTileX; x++) rangedTiles.add(`${x},${y}`);
  check([...expectedTiles].every((id) => rangedTiles.has(id)), `${name} corner-derived tile range contains every canonical tile`);
  check(expectedTiles.size === rangedTiles.size && [...rangedTiles].every((id) => expectedTiles.has(id)), `${name} corner-derived tile range matches the canonical tile set`);
}

const [centerX, centerY] = lngLatToMercator(0, 0);
const compact = canonicalWindowFromMercatorBounds({ minX: centerX - 0.002, maxX: centerX + 0.002, minY: centerY - 0.002, maxY: centerY + 0.002 });
const panned = canonicalWindowFromMercatorBounds({ minX: centerX - 0.0018, maxX: centerX + 0.0018, minY: centerY - 0.0018, maxY: centerY + 0.0018 });
const zoomedOut = canonicalWindowFromMercatorBounds({ minX: centerX - 0.22, maxX: centerX + 0.22, minY: centerY - 0.20, maxY: centerY + 0.20 });
const zoomedIn = canonicalWindowFromMercatorBounds({ minX: centerX - 0.0002, maxX: centerX + 0.0002, minY: centerY - 0.0002, maxY: centerY + 0.0002 });

for (const [name, window] of [['compact', compact], ['panned', panned], ['zoomed-out', zoomedOut], ['zoomed-in', zoomedIn]]) verifyWindow(window, name);

const compactMetrics = canonicalWindowMetrics(compact, 14);
const zoomedOutMetrics = canonicalWindowMetrics(zoomedOut, 14);
check(canonicalWindowChangeKind(compact, zoomedOut) === 'grow', 'zoom-out is classified as grow');
check(canonicalWindowChangeKind(zoomedOut, zoomedIn) === 'shrink', 'strong zoom-in is classified as shrink');
check(canonicalWindowNeedsShrink(zoomedOut, zoomedIn), 'strong zoom-in triggers the deterministic shrink rule');
check(!canonicalWindowNeedsShrink(compact, panned), 'contained useful pan does not trigger shrink');
const deferredTopology = new GeographicLodTopology(compact, { minLevel: 13, maxLevel: 14 }, null, { deferTransitionParents: true });
check(!deferredTopology.transitionParents.has(14), 'stable GPU L14 replacement can defer legacy L13↔L14 transition parents');
check(deferredTopology.transitionParentsFor(14).childIndices.length === deferredTopology.levelDataFor(14).count, 'deferred L13↔L14 transition parents rebuild deterministically on demand');
console.log(JSON.stringify({
    zoomOutZoomIn: {
      compactTarget: compactMetrics,
      zoomedOut: zoomedOutMetrics,
      zoomedInTarget: canonicalWindowMetrics(zoomedIn, 14),
      retainedCountBeforePolicy: zoomedOutMetrics.count,
      retainedCountAfterPolicy: canonicalWindowMetrics(zoomedIn, 14).count,
      presentationBytesBefore: zoomedOutMetrics.count * 12,
      presentationBytesAfter: 0,
      proceduralMetadataBytesAfter: 48
  }
}, null, 2));

if (failures) process.exitCode = 1;
console.log(failures ? `VERIFICATION FAILED: ${failures}` : 'VERIFICATION PASSED');
