import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadRealWeatherFixture } from './real-weather-fixture.mjs';
import { geographicHazardRadiusForSeverity } from '../src/engine/hazard-renderer.js';
import { lngLatToMercator } from '../src/engine/geographic-lod.js';

const GRID_SIZE = 2 ** 13;
const TILE_SIZE = 128;
const { metadata, weather } = await loadRealWeatherFixture({ retainAllSourceFrames: true });
const tiledRoot = new URL('../data/generated/tiled-rain/current/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', tiledRoot), 'utf8'));
const tileMap = new Map(manifest.tiles.map((tile) => [`${tile.x}:${tile.y}`, tile]));
const frame = weather.prepareFrame(0);
const phenomena = weather.phenomenaFrames.get(0);
const samples = [];

for (const code of [10, 11, 12]) {
  const sourceIndex = phenomena.findIndex((value) => value === code);
  assert.ok(sourceIndex >= 0, `source code ${code} exists`);
  const sourceX = sourceIndex % weather.longitudes.length;
  const sourceY = Math.floor(sourceIndex / weather.longitudes.length);
  const sourceLongitude = weather.longitudes[sourceX];
  const sourceLatitude = weather.latitudes[sourceY];
  const [mercatorX, mercatorY] = lngLatToMercator(sourceLongitude, sourceLatitude);
  const globalX = Math.round(mercatorX * GRID_SIZE);
  const globalY = Math.round(mercatorY * GRID_SIZE);
  const tileX = Math.floor(globalX / TILE_SIZE);
  const tileY = Math.floor(globalY / TILE_SIZE);
  const tile = tileMap.get(`${tileX}:${tileY}`);
  assert.ok(tile, `L13 tile exists for source code ${code}`);
  const block = tile.blocks[0];
  const reconstructedLongitude = globalX / GRID_SIZE * 360 - 180;
  const reconstructedLatitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * globalY / GRID_SIZE))) * 180 / Math.PI;
  const normal = frame.sample(reconstructedLongitude, reconstructedLatitude, {});
  const payload = block.storm ? new Uint8Array(await readFile(new URL(block.storm.asset, tiledRoot))) : null;
  const localX = globalX - tileX * TILE_SIZE;
  const localY = globalY - tileY * TILE_SIZE;
  const tiledSeverity = payload ? payload[localY * TILE_SIZE + localX] / 255 : 0;
  const tiledRadius = geographicHazardRadiusForSeverity('storm', tiledSeverity, 1 / GRID_SIZE);
  const normalRadius = geographicHazardRadiusForSeverity('storm', normal.storm, 1 / GRID_SIZE);
  assert.ok(Math.abs(tiledSeverity - normal.storm) <= 0.002, `tiled storm severity matches normal path for code ${code}: tiled=${tiledSeverity} normal=${normal.storm}`);
  assert.ok(Math.abs(tiledRadius - normalRadius) <= 0.000001, `tiled storm radius matches normal path for code ${code}`);
  samples.push({ code, sourceLongitude, sourceLatitude, globalX, globalY, normalSeverity: normal.storm, tiledSeverity, normalRadius, tiledRadius });
}

console.log(JSON.stringify({ status: 'passed', timestamp: metadata.time.timestamps[0], samples }, null, 2));
console.log('tiled real-phenomena comparison verifier: PASS');
