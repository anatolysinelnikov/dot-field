#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sha256ArrayBuffer, sha256Hex } from '../src/engine/sha256.js';

function nodeDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const cases = [
  [new Uint8Array(), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  [new TextEncoder().encode('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad']
];
const multiBlock = Uint8Array.from({ length: 4097 }, (_, index) => (index * 73 + 19) & 0xff);
cases.push([multiBlock, nodeDigest(multiBlock)]);

const manifestPaths = [
  '../data/generated/tiled-rain/current/manifest.json',
  '../data/generated/tiled-rain-motion/current/manifest.json'
];
for (const path of manifestPaths) cases.push([await readFile(new URL(path, import.meta.url))]);

for (const [bytes, expected] of cases) {
  const fallback = sha256Hex(bytes);
  const node = nodeDigest(bytes);
  assert.equal(fallback, expected || node);
  assert.equal(fallback, node);
  assert.match(fallback, /^[0-9a-f]{64}$/);

  const preferred = await sha256ArrayBuffer(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  );
  assert.equal(preferred, fallback);

  const savedCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
  try {
    const fallbackPath = await sha256ArrayBuffer(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    );
    assert.equal(fallbackPath, fallback);
  } finally {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: savedCrypto });
  }

  if (webcrypto?.subtle) {
    const webCryptoDigest = await webcrypto.subtle.digest('SHA-256', bytes);
    assert.equal(sha256Hex(bytes), Buffer.from(webCryptoDigest).toString('hex'));
  }
}

console.log(JSON.stringify({
  status: 'passed',
  cases: cases.length,
  webcrypto_checked: Boolean(webcrypto?.subtle),
  manifest_paths: manifestPaths
}, null, 2));
