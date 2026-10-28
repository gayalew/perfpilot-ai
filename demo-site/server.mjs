// Minimal static file server. It is intentionally naive: no compression, no cache headers.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const port = Number(process.env.PORT ?? 4200);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

http
  .createServer(async (req, res) => {
    try {
      let path = decodeURIComponent((req.url ?? '/').split('?')[0]);
      if (path.endsWith('/')) path += 'index.html';
      const file = normalize(join(root, path));
      if (!file.startsWith(root)) throw new Error('outside root');
      let body = await readFile(file);
      if (process.env.DEMO_REGRESSION === '1' && extname(file) === '.html') {
        body = Buffer.from(body.toString('utf8').replace('</title>', '</title><script src="/regression.js"></script>'));
      }
      const ext = extname(file);
      const contentType = types[ext] ?? 'application/octet-stream';
      const acceptEncoding = req.headers['accept-encoding'] ?? '';
      const shouldCompress = acceptEncoding.includes('gzip') && (contentType.startsWith('text/') || contentType === 'text/javascript' || ext === '.js');

      if (shouldCompress) {
        res.setHeader('Content-Encoding', 'gzip');
        res.writeHead(200, { 'content-type': contentType });
        await pipeline(Readable.from(body), createGzip(), res);
      } else {
        res.writeHead(200, { 'content-type': contentType });
        res.end(body);
      }
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    }
  })
  .listen(port, () => console.log(`demo site on http://localhost:${port}`));