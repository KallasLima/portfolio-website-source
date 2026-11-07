const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.gz': 'application/gzip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};
function createPreviewServer() {
  return http.createServer(async (req, res) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405);
        res.end('Preview is read-only.');
        return;
      }
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const parts = pathname.split('/').filter(Boolean);
      if (
        parts.some(
          (p) => p.startsWith('.') || p.includes('\\') || p.includes(String.fromCharCode(0)),
        ) ||
        parts[0] === 'node_modules' ||
        parts[0] === 'scripts'
      ) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      let file = path.resolve(root, '.' + pathname);
      if (!file.startsWith(root + path.sep) && file !== root) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const stat = await fs.stat(file);
      if (stat.isDirectory()) file = path.join(file, 'index.html');
      const type = mime[path.extname(file)];
      if (!type) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const bytes = await fs.readFile(file);
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': bytes.length,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      res.writeHead(error instanceof URIError ? 400 : 404);
      res.end('Not found');
    }
  });
}
if (require.main === module) {
  const port = Number(process.env.PORT ?? 4551);
  const server = createPreviewServer().listen(port, '127.0.0.1', () =>
    console.log(`Portfolio preview: http://127.0.0.1:${port}`),
  );
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => server.close(() => process.exit(0)));
}
module.exports = { createPreviewServer };
