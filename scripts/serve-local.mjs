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
  '.u16': 'application/octet-stream',
  '.svg': 'image/svg+xml'
});

function acceptsGzip(header) {
  return typeof header === 'string' && header.split(',').some((entry) => {
    const [encoding, ...parameters] = entry.trim().toLowerCase().split(';');
    return encoding === 'gzip' && !parameters.some((parameter) => parameter.trim() === 'q=0');
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

function sourceAssetCanUseCompression(pathname) {
  return pathname.endsWith('.f32') || pathname.endsWith('.u16') || pathname.endsWith('/support.mask');
}

export function createLocalServer({ root = process.cwd(), compression = 'identity', logWeatherRequests = false } = {}) {
  if (compression !== 'identity' && compression !== 'gzip') throw new Error('compression must be identity or gzip.');
  const absoluteRoot = resolve(root);
  return createServer(async (request, response) => {
    let weatherPathname = null;
    let weatherRequestLogged = false;
    let servedEncoding = 'identity';
    let selectedFileBytes = null;
    try {
      const requestUrl = new URL(request.url || '/', 'http://local.invalid');
      let pathname = decodeURIComponent(requestUrl.pathname);
      if (sourceAssetCanUseCompression(pathname)) weatherPathname = pathname;
      if (pathname.endsWith('/')) pathname += 'index.html';
      const asset = resolve(absoluteRoot, `.${pathname}`);
      if (asset !== absoluteRoot && !asset.startsWith(`${absoluteRoot}${sep}`)) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      let selectedAsset = asset;
      let encoded = false;
      if (compression === 'gzip' && sourceAssetCanUseCompression(pathname) && acceptsGzip(request.headers['accept-encoding'])) {
        const sidecar = `${asset}.gz`;
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
      selectedFileBytes = details.size;
      servedEncoding = encoded ? 'gzip' : 'identity';
      if (logWeatherRequests && weatherPathname) {
        const acceptEncoding = request.headers['accept-encoding'];
        console.log(`${request.method || 'GET'} ${weatherPathname} | accept-encoding=${JSON.stringify(acceptEncoding ?? '<absent>')} | compression=${compression} | served=${servedEncoding} | bytes=${selectedFileBytes}`);
        weatherRequestLogged = true;
      }
      const headers = {
        'Content-Type': contentType(pathname),
        'Content-Length': details.size
      };
      if (sourceAssetCanUseCompression(pathname)) headers.Vary = 'Accept-Encoding';
      if (encoded) headers['Content-Encoding'] = 'gzip';
      response.writeHead(200, headers);
      if (request.method === 'HEAD') return response.end();
      createReadStream(selectedAsset).pipe(response);
    } catch (error) {
      if (logWeatherRequests && weatherPathname && !weatherRequestLogged) {
        const acceptEncoding = request.headers['accept-encoding'];
        console.log(`${request.method || 'GET'} ${weatherPathname} | accept-encoding=${JSON.stringify(acceptEncoding ?? '<absent>')} | compression=${compression} | served=${servedEncoding} | bytes=${selectedFileBytes ?? '<unavailable>'}`);
      }
      const status = error?.code === 'ENOENT' ? 404 : 400;
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(status === 404 ? 'Not found' : 'Bad request');
    }
  });
}

function parseArguments(argv) {
  const options = { host: '127.0.0.1', port: 8000, compression: 'identity', root: process.cwd(), logWeatherRequests: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--host') options.host = argv[++index];
    else if (argument === '--port') options.port = Number(argv[++index]);
    else if (argument === '--compression') options.compression = argv[++index];
    else if (argument === '--root') options.root = resolve(argv[++index]);
    else if (argument === '--log-weather-requests') options.logWeatherRequests = true;
    else if (argument === '--help') {
      console.log('Usage: node scripts/serve-local.mjs [--host 127.0.0.1] [--port 8000] [--compression identity|gzip] [--root path] [--log-weather-requests]');
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
