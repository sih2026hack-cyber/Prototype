// Test bench for the ARGUS extension, so it can be tried without signing in anywhere.
// Serves stand-in pages and forwards /api/* to the ARGUS server (default http://localhost:8787).
//   /         fake YouTube / Reddit / Instagram comment boxes  (comment moderator, moderator.js)
//   /social   a fake social feed with comment boxes             (comment moderator)
//   /test     a fake image feed (add ?auto=1 for automatic checks) (Argus Lens, lens.js)
// Run: npm start (ARGUS), then node extension/test/serve.mjs  →  http://localhost:8792
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = path.join(HERE, '..', '..', 'lens', 'page', 'samples');
const FILES = {
  '/': ['fixtures.html', 'text/html'],
  '/social': ['social.html', 'text/html'],
  '/direct/t/test': ['social.html', 'text/html'], // an Instagram-messages-like path
  '/content.js': ['../moderator.js', 'text/javascript'],
  '/test': ['feed.html', 'text/html'],
  '/ext/content.js': ['../lens.js', 'text/javascript'],
};
const API = (process.env.ARGUS_API || 'http://localhost:8787').replace(/\/$/, '');
const port = Number(process.env.PORT || 8792);

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      const upstream = await fetch(API + url.pathname + url.search, {
        method: req.method,
        headers: { 'Content-Type': req.headers['content-type'] || 'application/json' },
        body: req.method === 'GET' ? undefined : Buffer.concat(chunks), // images stay binary
      });
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      res.end(await upstream.text());
    } catch {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `The ARGUS server is not running at ${API}.` }));
    }
    return;
  }
  const sample = url.pathname.match(/^\/samples\/([a-z-]+\.(webp|mp4))$/);
  if (sample && fs.existsSync(path.join(SAMPLES, sample[1]))) {
    res.writeHead(200, { 'Content-Type': sample[2] === 'mp4' ? 'video/mp4' : 'image/webp' });
    return res.end(fs.readFileSync(path.join(SAMPLES, sample[1])));
  }
  const file = FILES[url.pathname];
  if (!file) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': file[1] + '; charset=utf-8' });
  res.end(fs.readFileSync(path.join(HERE, file[0])));
}).listen(port, '127.0.0.1', () => console.log(`Extension test bench on http://localhost:${port} (ARGUS API: ${API})`));
