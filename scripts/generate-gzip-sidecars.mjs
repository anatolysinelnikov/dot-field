import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const compress = promisify(gzip);

function parseArguments(argv) {
  let directory = null;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--dir') directory = argv[++index];
    else if (argv[index] === '--help') {
      console.log('Usage: node scripts/generate-gzip-sidecars.mjs --dir <unpublished-staging-directory>');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!directory) throw new Error('--dir is required; gzip sidecars must be generated in unpublished staging.');
  return { directory: resolve(directory) };
}

const { directory } = parseArguments(process.argv.slice(2));
if (directory.endsWith('/current') || directory.split('/').at(-1)?.startsWith('generation-')) {
  throw new Error(`Refusing to mutate the active or published weather directory: ${directory}`);
}
const metadata = JSON.parse(await readFile(resolve(directory, 'metadata.json'), 'utf8'));
if (metadata.generation_id) {
  throw new Error(`Refusing to mutate a generation-published directory: ${directory}`);
}
function manifestAssets(value, result = []) {
  if (Array.isArray(value)) {
    for (const child of value) manifestAssets(child, result);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'asset' && typeof child === 'string') result.push(child);
      else if (key.endsWith('_assets') && Array.isArray(child)) {
        for (const asset of child) if (typeof asset === 'string') result.push(asset);
      } else manifestAssets(child, result);
    }
  }
  return result;
}

const assets = [...new Set(manifestAssets(metadata))].map((asset) => resolve(directory, asset));
if (!assets.length) throw new Error('metadata.json does not reference any logical assets');
let logicalBytes = 0;
let encodedBytes = 0;

for (const asset of assets) {
  const input = await readFile(asset);
  const encoded = await compress(input, { level: 9 });
  await writeFile(`${asset}.gz`, encoded);
  logicalBytes += input.byteLength;
  encodedBytes += encoded.byteLength;
  console.log(`${asset}: ${input.byteLength} -> ${encoded.byteLength} bytes`);
}

console.log(`gzip sidecars complete: assets=${assets.length}; logical=${logicalBytes}; encoded=${encodedBytes} bytes`);
