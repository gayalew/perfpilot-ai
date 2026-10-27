import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rewriteDocument, sameOrigin, transformResponse, type RuntimeItem } from './rewrite.js';

export interface RuntimeProxy {
  url: string;
  close(): Promise<void>;
}

async function transcodeWebp(body: Buffer): Promise<Buffer | null> {
  try {
    const sharp = (await import('sharp')).default;
    return await sharp(body).webp({ quality: 78 }).toBuffer();
  } catch {
    return null;
  }
}

/** Serves one origin with a single runtime fix applied to HTML or response bytes. */
export function startRuntimeProxy(options: { target: string; fix: string; items?: RuntimeItem[] }): Promise<RuntimeProxy> {
  const items = options.items ?? [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const upstream = sameOrigin(options.target, req.url ?? '/');
      if (!upstream) {
        res.writeHead(400);
        res.end('blocked');
        return;
      }
      const fetched = await fetch(upstream);
      const type = fetched.headers.get('content-type') ?? 'application/octet-stream';
      let body = Buffer.from(await fetched.arrayBuffer());
      if (type.includes('text/html')) {
        const rewritten = rewriteDocument(body.toString('utf8'), options.fix, items);
        body = Buffer.from(rewritten.html);
      }
      const transformed = await transformResponse({
        fix: options.fix,
        contentType: type.includes('text/html') ? 'text/html; charset=utf-8' : type,
        body,
        accept: String(req.headers.accept ?? ''),
        transcode: transcodeWebp,
      });
      const headers: Record<string, string | number> = {
        'content-type': transformed.contentType,
        'content-length': transformed.body.length,
        'cache-control': 'no-store',
      };
      if (transformed.encoding) headers['content-encoding'] = transformed.encoding;
      res.writeHead(fetched.status, headers);
      res.end(transformed.body);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      const target = new URL(options.target);
      resolve({
        url: `http://127.0.0.1:${address.port}${target.pathname}${target.search}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
