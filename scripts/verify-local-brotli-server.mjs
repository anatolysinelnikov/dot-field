import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createLocalServer } from './serve-local.mjs';

const framePath = 'data/generated/current/rain/frame-000.f32';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function rawRequest(port, headers) {
  return new Promise((resolvePromise, reject) => {
    const client = request({ host: '127.0.0.1', port, path: `/${framePath}`, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolvePromise({ statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    client.on('error', reject);
    client.end();
  });
}

const server = createLocalServer({ compression: 'br' });
await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Local Brotli verifier did not receive a TCP port.');

try {
  const original = await readFile(framePath);
  const sidecar = await readFile(`${framePath}.br`);
  const compressed = await rawRequest(address.port, { 'Accept-Encoding': 'br' });
  check(compressed.statusCode === 200, 'Brotli source frame request must succeed');
  check(compressed.headers['content-encoding'] === 'br', 'Brotli source frame must emit Content-Encoding: br');
  check(compressed.headers.vary === 'Accept-Encoding', 'Brotli source frame must emit Vary: Accept-Encoding');
  check(compressed.headers['content-type'] === 'application/octet-stream', 'Brotli source frame must retain binary content type');
  check(Number(compressed.headers['content-length']) === sidecar.byteLength, 'Brotli source frame must emit encoded Content-Length');
  check(compressed.body.equals(sidecar), 'Brotli source frame must serve the generated sidecar bytes');

  const identity = await rawRequest(address.port, { 'Accept-Encoding': 'identity' });
  check(!identity.headers['content-encoding'], 'Identity request must not emit Content-Encoding');
  check(Number(identity.headers['content-length']) === original.byteLength, 'Identity source frame must emit logical Content-Length');
  check(identity.body.equals(original), 'Identity source frame must serve the logical frame bytes');

  const decodedResponse = await fetch(`http://127.0.0.1:${address.port}/${framePath}`, { headers: { 'Accept-Encoding': 'br' } });
  const decoded = Buffer.from(await decodedResponse.arrayBuffer());
  check(decoded.byteLength === original.byteLength, 'Fetch must transparently decode the exact logical source frame length');
  check(decoded.equals(original), 'Fetch must transparently decode exact Float32 source frame bits');
  console.log(`local Brotli server verification passed: identity=${original.byteLength}; br=${sidecar.byteLength}; decoded Float32 bytes are exact`);
} finally {
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}
