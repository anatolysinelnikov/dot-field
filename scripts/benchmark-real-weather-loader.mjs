import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const root = new URL('../data/generated/current/', import.meta.url);
const metadata = JSON.parse(await readFile(new URL('metadata.json', root)));
const buffer = Buffer.concat(await Promise.all(metadata.rain.frame_assets.map((asset) => readFile(new URL(asset, root)))));
const values = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / Float32Array.BYTES_PER_ELEMENT);
const frameSize = metadata.spatial_grid.width * metadata.spatial_grid.height;

function time(run) {
  const start = performance.now();
  const result = run();
  return { ms: performance.now() - start, result };
}

const validation = time(() => {
  for (let index = 0; index < values.length; index++) {
    if (!Number.isFinite(values[index]) || values[index] < 0) throw new Error(`invalid value ${index}`);
  }
});
const mask = time(() => {
  const result = new Uint8Array(frameSize);
  for (let index = 0; index < values.length; index++) if (values[index] > 0) result[index % frameSize] = 1;
  return result;
});
const fused = time(() => {
  const result = new Uint8Array(frameSize);
  let spatialIndex = 0;
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (!Number.isFinite(value) || value < 0) throw new Error(`invalid value ${index}`);
    if (value > 0) result[spatialIndex] = 1;
    spatialIndex++;
    if (spatialIndex === frameSize) spatialIndex = 0;
  }
  return result;
});
if (mask.result.some((value, index) => value !== fused.result[index])) throw new Error('fused mask differs from the old sequence-wide mask');

console.log(JSON.stringify({
  elements: values.length,
  frameSize,
  frameBytes: frameSize * Float32Array.BYTES_PER_ELEMENT,
  fullSequenceBytes: buffer.byteLength,
  oldValidationMs: validation.ms,
  oldPotentialMaskMs: mask.ms,
  combinedValidationAndMaskMs: fused.ms
}, null, 2));
