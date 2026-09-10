import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const argv = process.argv.slice(2);

function readArg(flag, fallback) {
  const index = argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value ?? fallback;
}

const host = readArg('--host', '127.0.0.1');
const port = Number(readArg('--port', '4322'));
const root = path.resolve(readArg('--root', 'dist'));

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.xml', 'application/xml; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function normalizeUrlPath(rawPath) {
  let pathname = '/';
  try {
    pathname = new URL(rawPath, 'http://localhost').pathname;
  } catch {
    pathname = '/';
  }
  return decodeURIComponent(pathname);
}

function safeJoin(base, candidate) {
  const resolved = path.resolve(base, `.${candidate}`);
  if (!resolved.startsWith(base)) return null;
  return resolved;
}

function pickFile(pathname) {
  const hasExtension = path.extname(pathname) !== '';
  const candidates = hasExtension
    ? [pathname]
    : pathname.endsWith('/')
      ? [`${pathname}index.html`]
      : [pathname, `${pathname}.html`, `${pathname}/index.html`];

  for (const item of candidates) {
    const absolute = safeJoin(root, item);
    if (!absolute) continue;
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
      return absolute;
    }
  }

  return null;
}

if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`[serve-dist] dist root not found: ${root}`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('Method Not Allowed');
    return;
  }

  const pathname = normalizeUrlPath(req.url || '/');
  const filePath = pickFile(pathname);
  if (!filePath) {
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = contentTypes.get(ext) || 'application/octet-stream';
  res.statusCode = 200;
  res.setHeader('content-type', contentType);
  res.setHeader('cache-control', 'no-cache');

  if (method === 'HEAD') {
    res.end();
    return;
  }

  fs.createReadStream(filePath)
    .on('error', () => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
      }
      res.end('Internal Server Error');
    })
    .pipe(res);
});

server.listen(port, host, () => {
  console.log(`[serve-dist] serving "${root}" on http://${host}:${port}`);
});
