// Standalone demo of the drop-in widget: NEBIUS_API_KEY=... node demo/server.mjs  →  http://localhost:8790
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { moderatorHandler, createModeratorService } from '../src/index.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = { '/': ['demo/index.html', 'text/html'], '/moderator-widget.js': ['widget/moderator-widget.js', 'text/javascript'], '/moderator-widget.css': ['widget/moderator-widget.css', 'text/css'] };
// The demo page has a moderator panel, so it carries this secret. A real site keeps it off writer pages.
const api = moderatorHandler(createModeratorService(), { base: '/api/plugin', moderatorSecret: 'demo-moderator' });
const port = Number(process.env.PORT || 8790);

http.createServer((req, res) => {
  const file = FILES[new URL(req.url, 'http://localhost').pathname];
  if (!file) return api(req, res);
  res.writeHead(200, { 'Content-Type': file[1] + '; charset=utf-8' });
  res.end(fs.readFileSync(path.join(ROOT, file[0])));
}).listen(port, '127.0.0.1', () => console.log(`AI moderator demo on http://localhost:${port}${process.env.NEBIUS_API_KEY ? '' : ' (NEBIUS_API_KEY not set: every check will fail closed)'}`));
