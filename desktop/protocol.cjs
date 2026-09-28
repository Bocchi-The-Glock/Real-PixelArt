// Static assets only. No image-processing server or arbitrary filesystem access.
const fs = require('node:fs/promises');
const path = require('node:path');
const ORIGIN = 'pixelart://app';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.zip': 'application/zip',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
};
const CSP = "default-src 'self'; script-src 'self'; " +
  "worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; " +
  "connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'";

function assetPath(root, address) {
  const url = new URL(address);
  if (url.protocol !== 'pixelart:' || url.host !== 'app' || url.username || url.password) return null;
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  if (/[\\\0:]/.test(pathname)) return null;
  const file = path.resolve(root, '.' + pathname);
  const relative = path.relative(path.resolve(root), file);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
  return file;
}

function assetHandler(root) {
  return async request => {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
    try {
      const file = assetPath(root, request.url);
      if (!file) return new Response('Forbidden', { status: 403 });
      const bytes = await fs.readFile(file);
      return new Response(request.method === 'HEAD' ? null : bytes, { headers: {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Content-Length': String(bytes.length),
        'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff',
      } });
    } catch (error) {
      return new Response('Asset unavailable', { status: error instanceof URIError ? 400 : 404 });
    }
  };
}
module.exports = { ORIGIN, assetPath, assetHandler };
