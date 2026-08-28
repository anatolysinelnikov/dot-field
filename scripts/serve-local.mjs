import { createServer } from 'node:http';
import { access, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const MIME_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.f32': 'application/octet-stream',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mask': 'application/octet-stream',
  '.svg': 'image/svg+xml'
});

function acceptsBrotli(header) {
  return typeof header === 'string' && header.split(',').some((entry) => {
    const [encoding, ...parameters] = entry.trim().toLowerCase().split(';');
    return encoding === 'br' && !parameters.some((parameter) => parameter.trim() === 'q=0');
  });
}

function contentType(pathname) {
  return MIME_TYPES[extname(pathname)] || 'application/octet-stream';
}

function localNetworkAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

function sourceAssetCanUseBrotli(pathname) {
  return pathname.endsWith('.f32') || pathname.endsWith('/support.mask');
}

export function createLocalServer({ root = process.cwd(), compression = 'identity' } = {}) {
  if (compression !== 'identity' && compression !== 'br') throw new Error('compression must be identity or br.');
  const absoluteRoot = resolve(root);
  return createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', 'http://local.invalid');
      let pathname = decodeURIComponent(requestUrl.pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';
      const asset = resolve(absoluteRoot, `.${pathname}`);
      if (asset !== absoluteRoot && !asset.startsWith(`${absoluteRoot}${sep}`)) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      let selectedAsset = asset;
      let encoded = false;
      if (compression === 'br' && sourceAssetCanUseBrotli(pathname) && acceptsBrotli(request.headers['accept-encoding'])) {
        const sidecar = `${asset}.br`;
        try {
          await access(sidecar);
          selectedAsset = sidecar;
          encoded = true;
        } catch {
          // Sidecars are optional generated development artifacts. Identity is
          // deliberately retained when one has not been generated.
        }
      }
      const details = await stat(selectedAsset);
      if (!details.isFile()) throw new Error('Not a file');
      const headers = {
        'Content-Type': contentType(pathname),
        'Content-Length': details.size
      };
      if (sourceAssetCanUseBrotli(pathname)) headers.Vary = 'Accept-Encoding';
      if (encoded) headers['Content-Encoding'] = 'br';
      response.writeHead(200, headers);
      if (request.method === 'HEAD') return response.end();
      createReadStream(selectedAsset).pipe(response);
    } catch (error) {
      const status = error?.code === 'ENOENT' ? 404 : 400;
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(status === 404 ? 'Not found' : 'Bad request');
    }
  });
}

function parseArguments(argv) {
  const options = { host: '127.0.0.1', port: 8000, compression: 'identity', root: process.cwd() };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--host') options.host = argv[++index];
    else if (argument === '--port') options.port = Number(argv[++index]);
    else if (argument === '--compression') options.compression = argv[++index];
    else if (argument === '--root') options.root = resolve(argv[++index]);
    else if (argument === '--help') {
      console.log('Usage: node scripts/serve-local.mjs [--host 127.0.0.1] [--port 8000] [--compression identity|br] [--root path]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('port must be an integer from 1 to 65535.');
  return options;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = parseArguments(process.argv.slice(2));
  const server = createLocalServer(options);
  server.listen(options.port, options.host, () => {
    const lanAddress = localNetworkAddress();
    console.log(`Development server (${options.compression}) — do not expose to the Internet.`);
    console.log(`Local:   http://127.0.0.1:${options.port}/`);
    if (options.host === '0.0.0.0' && lanAddress) console.log(`Network: http://${lanAddress}:${options.port}/`);
    else if (options.host === '0.0.0.0') console.log(`Network: http://<computer-LAN-IP>:${options.port}/`);
  });
}
