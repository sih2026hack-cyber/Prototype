// The comment moderator uses Nemotron only while its credits last, then MiniMax.
// Runs the real server against fake Nebius and MiniMax APIs on localhost: no money is spent.
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const clean = JSON.stringify({score: 0.05, category: 'none', reason: 'Friendly.', meaning: '', sure: true, coarse: false});
const answer = (res, content, usage) => { res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify({choices: [{message: {content}}], usage})); };

// Fake APIs. nebius.mode: 'ok' answers (and reports tokens), 'broke' refuses with HTTP 402.
const calls = {nebius: 0, minimax: 0}, nebius = {mode: 'ok'};
const fake = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  if (req.url.startsWith('/nebius')) {
    calls.nebius++;
    if (nebius.mode === 'broke') { res.writeHead(402, {'Content-Type': 'application/json'}); return res.end(JSON.stringify({error: {message: 'Insufficient balance'}})); }
    return answer(res, clean, {prompt_tokens: 600, completion_tokens: 40});
  }
  calls.minimax++;
  answer(res, clean);
});
await new Promise(r => fake.listen(8797, '127.0.0.1', r));

async function withServer(extraEnv, fn) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-credits-test-'));
  fs.writeFileSync(path.join(temp, 'corpus.json'), '[]');
  const child = spawn(process.execPath, ['server.mjs'], {cwd: new URL('..', import.meta.url), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, PORT: '8798', ARGUS_DATA_DIR: temp, AUTO_INGEST: 'false', AUTO_DISCOVERY: 'false', YOUTUBE_API_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_SERVICE_KEY: '',
    NEBIUS_API_KEY: 'fake', LLM_BASE_URL: 'http://127.0.0.1:8797/nebius', MINIMAX_API_KEY: 'fake', MINIMAX_BASE_URL: 'http://127.0.0.1:8797/minimax', NEBIUS_CREDIT_USD: '', ...extraEnv,
  }});
  try {
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Test server did not start')), 10000); child.once('exit', code => reject(new Error('Test server exited ' + code))); child.stdout.once('data', () => { clearTimeout(timer); resolve(); }); });
    const base = 'http://localhost:8798';
    await fn({
      check: text => fetch(base + '/api/plugin/check', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({text})}).then(r => r.json()),
      model: () => fetch(base + '/api/health').then(r => r.json()).then(h => h.moderator_model),
    });
  } finally { child.kill(); await new Promise(r => child.exitCode !== null ? r() : child.once('exit', r)); fs.rmSync(temp, {recursive: true, force: true}); }
}

try {
  // 1. Credits left: Nemotron checks the comment and the spend is tracked.
  await withServer({}, async ({check, model}) => {
    assert.equal((await model()).provider, 'nemotron');
    const r = await check('Lovely video, thanks!'); assert.equal(r.allowed, true);
    assert.equal(calls.nebius, 1); assert.equal(calls.minimax, 0);
    assert.ok((await model()).nemotron.spent_usd > 0);

    // 2. Nebius says the balance is gone: that check and every later one use MiniMax.
    nebius.mode = 'broke';
    assert.equal((await check('Great explanation.')).allowed, true);
    const m = await model(); assert.equal(m.provider, 'minimax'); assert.match(m.reason, /402/);
    const nebiusCalls = calls.nebius;
    await check('Nice one.'); assert.equal(calls.nebius, nebiusCalls, 'no more Nebius calls once credits are gone');
  });

  // 3. A budget: once the tracked spend reaches NEBIUS_CREDIT_USD, Nemotron stops being called.
  nebius.mode = 'ok'; calls.nebius = 0; calls.minimax = 0;
  await withServer({NEBIUS_CREDIT_USD: '0.0005'}, async ({check, model}) => {
    await check('Thanks for sharing.'); // ~600 in + 40 out tokens ≈ $0.00072, over the $0.0005 budget
    assert.equal((await model()).provider, 'minimax');
    await check('Very helpful.');
    assert.equal(calls.nebius, 1); assert.equal(calls.minimax, 1);
  });
  console.log('Nemotron-while-credits-last, then MiniMax, checks passed; no real APIs contacted.');
} finally { fake.close(); }
