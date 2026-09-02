import { request } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalServer } from './serve-local.mjs';

const compress = promisify(gzip);
const currentRoot = new URL('../data/generated/current/', import.meta.url);
const currentMetadata = JSON.parse(await readFile(new URL('metadata.json', currentRoot), 'utf8'));
const originalFrameFile = new URL(currentMetadata.rain.frame_assets[0], currentRoot);
const originalSupportFile = new URL(currentMetadata.support_mask.asset, currentRoot);
const fixtureRoot = await mkdtemp(join(tmpdir(), 'dot-field-gzip-verifier-'));
const framePath = 'data/generated/generation-gzip-test/rain/frame-000.f32';
const supportPath = 'data/generated/generation-gzip-test/support.mask';
const u16Path = 'data/generated/generation-gzip-test/tiles/block-000.u16';
const frameFile = join(fixtureRoot, framePath);
const supportFile = join(fixtureRoot, supportPath);
const u16File = join(fixtureRoot, u16Path);
await mkdir(join(fixtureRoot, 'data/generated/generation-gzip-test/rain'), { recursive: true });
await mkdir(join(fixtureRoot, 'data/generated/generation-gzip-test/tiles'), { recursive: true });

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function rawRequest(port, path, headers) {
  return new Promise((resolvePromise, reject) => {
    const client = request({ host: '127.0.0.1', port, path: `/${path}`, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolvePromise({ statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    client.on('error', reject);
    client.end();
  });
}

const original = await readFile(originalFrameFile);
await writeFile(frameFile, original);
const sidecar = await compress(original, { level: 9 });
await writeFile(`${frameFile}.gz`, sidecar);
const originalSupport = await readFile(originalSupportFile);
await writeFile(supportFile, originalSupport);
const supportSidecar = await compress(originalSupport, { level: 9 });
await writeFile(`${supportFile}.gz`, supportSidecar);
const originalU16 = Buffer.alloc(128 * 128 * 2);
for (let index = 0; index < 128 * 128; index++) originalU16.writeUInt16LE((index * 17) % 65536, index * 2);
await writeFile(u16File, originalU16);
const u16Sidecar = await compress(originalU16, { level: 9 });
await writeFile(`${u16File}.gz`, u16Sidecar);
const server = createLocalServer({ root: fixtureRoot, compression: 'gzip' });
await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Local gzip verifier did not receive a TCP port.');

try {
  const compressed = await rawRequest(address.port, framePath, { 'Accept-Encoding': 'gzip' });
  check(compressed.statusCode === 200, 'gzip source frame request must succeed');
  check(compressed.headers['content-encoding'] === 'gzip', 'gzip source frame must emit Content-Encoding: gzip');
  check(compressed.headers.vary === 'Accept-Encoding', 'gzip source frame must emit Vary: Accept-Encoding');
  check(compressed.headers['content-type'] === 'application/octet-stream', 'gzip source frame must retain binary content type');
  check(Number(compressed.headers['content-length']) === sidecar.byteLength, 'gzip source frame must emit encoded Content-Length');
  check(compressed.body.equals(sidecar), 'gzip source frame must serve the generated sidecar bytes');

  const compressedSupport = await rawRequest(address.port, supportPath, { 'Accept-Encoding': 'gzip' });
  check(compressedSupport.headers['content-encoding'] === 'gzip', 'gzip support mask must emit Content-Encoding: gzip');
  check(compressedSupport.headers.vary === 'Accept-Encoding', 'gzip support mask must emit Vary: Accept-Encoding');
  check(Number(compressedSupport.headers['content-length']) === supportSidecar.byteLength, 'gzip support mask must emit encoded Content-Length');
  check(compressedSupport.body.equals(supportSidecar), 'gzip support mask must serve the generated sidecar bytes');

  const compressedU16 = await rawRequest(address.port, u16Path, { 'Accept-Encoding': 'gzip' });
  check(compressedU16.statusCode === 200, 'gzip UInt16 block request must succeed');
  check(compressedU16.headers['content-encoding'] === 'gzip', 'gzip UInt16 block must emit Content-Encoding: gzip');
  check(compressedU16.headers.vary === 'Accept-Encoding', 'gzip UInt16 block must emit Vary: Accept-Encoding');
  check(compressedU16.headers['content-type'] === 'application/octet-stream', 'gzip UInt16 block must retain binary content type');
  check(Number(compressedU16.headers['content-length']) === u16Sidecar.byteLength, 'gzip UInt16 block must emit encoded Content-Length');
  check(compressedU16.body.equals(u16Sidecar), 'gzip UInt16 block must serve the generated sidecar bytes');

  const identity = await rawRequest(address.port, framePath, { 'Accept-Encoding': 'identity' });
  check(!identity.headers['content-encoding'], 'Identity request must not emit Content-Encoding');
  check(Number(identity.headers['content-length']) === original.byteLength, 'Identity source frame must emit logical Content-Length');
  check(identity.body.equals(original), 'Identity source frame must serve the logical frame bytes');

  const identityU16 = await rawRequest(address.port, u16Path, { 'Accept-Encoding': 'identity' });
  check(!identityU16.headers['content-encoding'], 'Identity UInt16 block must not emit Content-Encoding');
  check(Number(identityU16.headers['content-length']) === originalU16.byteLength, 'Identity UInt16 block must emit logical Content-Length');
  check(identityU16.body.equals(originalU16), 'Identity UInt16 block must serve the logical bytes');

  const decodedResponse = await fetch(`http://127.0.0.1:${address.port}/${framePath}`, { headers: { 'Accept-Encoding': 'gzip' } });
  const decoded = Buffer.from(await decodedResponse.arrayBuffer());
  check(decoded.byteLength === original.byteLength, 'Fetch must transparently decode the exact logical source frame length');
  check(decoded.equals(original), 'Fetch must transparently decode exact Float32 source frame bits');
  const decodedU16Response = await fetch(`http://127.0.0.1:${address.port}/${u16Path}`, { headers: { 'Accept-Encoding': 'gzip' } });
  const decodedU16 = Buffer.from(await decodedU16Response.arrayBuffer());
  check(decodedU16.byteLength === originalU16.byteLength, 'Fetch must transparently decode the exact logical UInt16 block length');
  check(decodedU16.equals(originalU16), 'Fetch must transparently decode exact UInt16 block bytes');
  console.log(`local gzip server verification passed: Float32 identity=${original.byteLength}; UInt16 identity=${originalU16.byteLength}; UInt16 gzip=${u16Sidecar.byteLength}; transparent decoded bytes are exact`);
} finally {
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  await rm(fixtureRoot, { recursive: true, force: true });
}
