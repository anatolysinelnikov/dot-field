import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { brotliCompress, constants } from 'node:zlib';
import { promisify } from 'node:util';

const compress = promisify(brotliCompress);

function parseArguments(argv) {
  let directory = null;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--dir') directory = argv[++index];
    else if (argv[index] === '--help') {
      console.log('Usage: node scripts/generate-brotli-sidecars.mjs --dir <unpublished-staging-directory>');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!directory) throw new Error('--dir is required; Brotli sidecars must be generated in unpublished staging.');
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
const rainDirectory = resolve(directory, 'rain');
const rainFrames = (await readdir(rainDirectory)).filter((name) => name.endsWith('.f32')).sort();
const assets = [...rainFrames.map((name) => resolve(rainDirectory, name)), resolve(directory, 'support.mask')];
let logicalBytes = 0;
let encodedBytes = 0;

for (const asset of assets) {
  const input = await readFile(asset);
  const encoded = await compress(input, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 9 }
  });
  await writeFile(`${asset}.br`, encoded);
  logicalBytes += input.byteLength;
  encodedBytes += encoded.byteLength;
  console.log(`${asset}: ${input.byteLength} -> ${encoded.byteLength} bytes`);
}

console.log(`Brotli sidecars complete: assets=${assets.length}; logical=${logicalBytes}; encoded=${encodedBytes} bytes`);
