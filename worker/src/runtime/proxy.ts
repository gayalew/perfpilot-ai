import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rewriteDocument, sameOrigin, transformResponse, type RuntimeItem } from './rewrite.js';

export interface RuntimeProxy {
  url: string;
  notes: string[];
  close(): Promise<void>;
}

const REDIRECT_HOP_CAP = 5;
const HOP_PARAM = '__pp_hop';

async function transcodeWebp(body: Buffer): Promise<Buffer | null> {
  try {
    const sharp = (await import('sharp')).default;
    return await sharp(body).webp({ quality: 78 }).toBuffer();
  } catch {
    return null;
  }
}

function requestParts(requestPath: string): { path: string; hop: number } {
  const parsed = new URL(requestPath, 'http://127.0.0.1');
  const raw = Number(parsed.searchParams.get(HOP_PARAM) ?? '0');
  parsed.searchParams.delete(HOP_PARAM);
  return { path: `${parsed.pathname}${parsed.search}`, hop: Number.isInteger(raw) && raw > 0 ? raw : 0 };
}

/** Serves one origin with a single runtime fix applied to HTML or response bytes. */
export function startRuntimeProxy(options: { target: string; fix: string; items?: RuntimeItem[] }): Promise<RuntimeProxy> {
  const items = options.items ?? [];
  const notes: string[] = [];
  const noteBlocked = (): void => {
    if (!notes.includes('blocked redirect')) notes.push('blocked redirect');
  };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const parts = requestParts(req.url ?? '/');
      const upstream = sameOrigin(options.target, parts.path);
      if (!upstream) {
        res.writeHead(400);
        res.end('blocked');
        return;
      }
      const fetched = await fetch(upstream, { redirect: 'manual' });
      if (fetched.status >= 300 && fetched.status < 400) {
        const location = fetched.headers.get('location');
        let resolved: URL | null = null;
        try {
          resolved = location ? new URL(location, upstream) : null;
        } catch {
          resolved = null;
        }
        const targetOrigin = new URL(options.target).origin;
        const address = server.address() as AddressInfo | null;
        if (!resolved || resolved.origin !== targetOrigin || !address || parts.hop >= REDIRECT_HOP_CAP) {
          noteBlocked();
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          res.end('blocked redirect');
          return;
        }
        const next = new URL(`http://127.0.0.1:${address.port}${resolved.pathname}${resolved.search}`);
        next.searchParams.set(HOP_PARAM, String(parts.hop + 1));
        if (resolved.hash) next.hash = resolved.hash;
        res.writeHead(fetched.status, { location: next.toString(), 'cache-control': 'no-store' });
        res.end();
        return;
      }
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
        notes,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
