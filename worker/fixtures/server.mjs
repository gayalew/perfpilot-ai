// Tiny fixture server for smoke-testing the measurement engine.
// /slow : render-blocking script that burns CPU, plus a large uncompressed payload.
// /fast : the same content without the blocking work.
import http from 'node:http';

const port = Number(process.env.PORT ?? 4173);
const filler = 'x'.repeat(600_000);

const page = (head, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Fixture</title>${head}</head>
<body><main><h1>PerfPilot fixture</h1><p>Hello world.</p>${body}</main></body></html>`;

const routes = {
  '/slow': page(
    '<script src="/blocking.js"></script><script src="/big.js"></script>',
    '<p>This page does too much work before it can paint.</p>',
  ),
  '/fast': page('', '<p>This page paints immediately.</p>'),
};

http
  .createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/blocking.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end('var t=Date.now();while(Date.now()-t<350){}');
    }
    if (url === '/big.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(`/*${filler}*/`);
    }
    const html = routes[url];
    if (!html) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  })
  .listen(port, () => console.log(`fixture server on http://localhost:${port}`));
