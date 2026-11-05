// The browser extension's routes (/api/ext/*, /api/lens/*) and the Lens page, against fake model
// APIs on localhost: no money is spent. Also checks Lens stops calling Meta once credits are gone.
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

function png(width, height) {
  const crcTable = Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4), sum = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), data]); len.writeUInt32BE(data.length); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height, 0x80); for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const clean = JSON.stringify({score: 0.05, category: 'none', reason: 'Friendly.', meaning: '', sure: true, coarse: false});
const lensAnswer = JSON.stringify({verdict: 'no_ai_signs', confidence: 0.7, kind: 'photo', summary: 'Nothing unusual.', signs: [], edits: [], harm: {harmful: false, category: 'none'}, privacy: []});
const calls = {meta: 0, minimax: 0}, meta = {mode: 'ok'};
const fake = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  res.setHeader('Content-Type', 'application/json');
  if (req.url.startsWith('/meta')) {
    calls.meta++;
    if (meta.mode === 'broke') { res.writeHead(402); return res.end(JSON.stringify({error: {message: 'Insufficient credit'}})); }
    return res.end(JSON.stringify({output_text: lensAnswer, usage: {input_tokens: 1500, output_tokens: 300}}));
  }
  calls.minimax++;
  res.end(JSON.stringify({choices: [{message: {content: clean}}]}));
});
await new Promise(r => fake.listen(8796, '127.0.0.1', r));

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-ext-test-'));
fs.writeFileSync(path.join(temp, 'corpus.json'), '[]');
const KEY = 'test-extension-key';
const child = spawn(process.execPath, ['server.mjs'], {cwd: new URL('..', import.meta.url), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
  ...process.env, PORT: '8795', ARGUS_DATA_DIR: temp, AUTO_INGEST: 'false', AUTO_DISCOVERY: 'false', YOUTUBE_API_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_SERVICE_KEY: '',
  NEBIUS_API_KEY: '', MINIMAX_API_KEY: 'fake', MINIMAX_BASE_URL: 'http://127.0.0.1:8796/minimax',
  MODEL_API_KEY: 'fake', MODEL_API_BASE: 'http://127.0.0.1:8796/meta', META_CREDIT_USD: '', ARGUS_EXTENSION_KEY: KEY,
}});
const base = 'http://localhost:8795', ext = {Origin: 'chrome-extension://abcdefghijklmnop', 'x-extension-key': KEY};
const post = (route, body, headers = ext) => fetch(base + route, {method: 'POST', headers: {'Content-Type': 'application/json', ...headers}, body: JSON.stringify(body)});
try {
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Test server did not start')), 10000); child.once('exit', code => reject(new Error('Test server exited ' + code))); child.stdout.once('data', () => { clearTimeout(timer); resolve(); }); });

  // Comment moderator routes, as the extension calls them.
  const checked = await post('/api/ext/check', {text: 'Lovely video, thanks!', site: 'youtube'}).then(r => r.json());
  assert.equal(checked.allowed, true); assert.equal(checked.verdict, 'clean'); assert.ok(checked.id);
  const dm = await post('/api/ext/check', {text: 'See you tomorrow', site: 'whatsapp'}).then(r => r.json());
  assert.equal(dm.id, null, 'private messages are not stored');
  assert.equal((await post('/api/ext/peek', {text: 'Nice'}).then(r => r.json())).verdict, 'clean');
  assert.deepEqual(await fetch(base + '/api/ext/status?id=ping', {headers: ext}).then(r => r.json()), {status: 'none'});
  assert.equal((await post('/api/ext/check', {text: 'hi', site: 'myspace'})).status, 400);

  // The extension key: required from the extension, and the extension can reach only its own routes.
  assert.equal((await post('/api/ext/check', {text: 'hi', site: 'youtube'}, {Origin: ext.Origin})).status, 401);
  assert.equal((await fetch(base + '/api/overview', {headers: ext})).status, 403);

  // The Lens page and its sample.
  const page = await fetch(base + '/lens');
  assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /blob:/);
  assert.match(await page.text(), /\/lens\/lens\.js/);
  const sample = await fetch(base + '/lens/samples/cafe.webp');
  assert.equal(sample.status, 200);
  // A plain 64×64 PNG with no AI label in the file, so the verdict comes from the (fake) model.
  const image = png(64, 64);

  // Lens with credits: Meta is asked, spend is tracked.
  const sendImage = () => fetch(base + '/api/lens/assess', {method: 'POST', headers: ext, body: image}).then(r => r.json());
  assert.equal((await sendImage()).verdict, 'no_ai_signs');
  let health = await fetch(base + '/api/health').then(r => r.json());
  assert.equal(health.lens.available, true); assert.ok(health.lens.spent_usd > 0);

  // Meta says the credit is gone: that check can't be made, and Meta is never called again.
  meta.mode = 'broke';
  assert.equal((await sendImage()).verdict, 'unavailable');
  health = await fetch(base + '/api/health').then(r => r.json());
  assert.equal(health.lens.available, false); assert.match(health.lens.reason, /402/);
  const metaCalls = calls.meta;
  const after = await sendImage();
  assert.equal(after.verdict, 'unavailable'); assert.match(after.error, /credits are used up/);
  assert.equal(calls.meta, metaCalls, 'no more Meta calls once credits are gone');
  console.log('Extension routes, Lens page and Lens credit-stop checks passed; no real APIs contacted.');
} finally {
  child.kill(); await new Promise(r => child.exitCode !== null ? r() : child.once('exit', r));
  fake.close(); fs.rmSync(temp, {recursive: true, force: true});
}
