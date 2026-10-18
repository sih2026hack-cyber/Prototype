// No network: the model is a stub. Run with `npm test` inside this folder.
import assert from 'node:assert/strict';
import http from 'node:http';
import { inspectDraft, createModerator, createModeratorService, moderatorHandler } from '../src/index.mjs';

// Local rules
assert.equal(inspectDraft('I will kill him').verdict, 'high_risk');
assert.notEqual(inspectDraft('I will not kill him').verdict, 'high_risk');
assert.notEqual(inspectDraft('The character said "I will kill him" in the film.').verdict, 'high_risk');
assert.equal(inspectDraft('you are an idiot').verdict, 'review');
assert.equal(inspectDraft('Lovely weather today').verdict, 'unchecked');

// Model flow: score → rewrite → rescore; the rewrite is offered only after it passes the recheck.
const calm = 'I strongly disagree with this decision.';
const stub = async (messages) => {
  const system = messages[0].content, text = messages[1].content;
  if (system.includes('content-safety scorer')) return JSON.stringify(text === calm ? { score: 0.1, reason: 'Civil.', category: 'none' } : { score: 0.6, reason: 'Insulting.', category: 'insult' });
  return JSON.stringify({ rewrite: calm });
};
const moderator = createModerator({ call: stub });
const reviewed = await moderator.moderate('This decision is idiotic and so are you');
assert.equal(reviewed.verdict, 'review');
assert.equal(reviewed.corrected_text, calm);
assert.equal(reviewed.complete, true);

// A model failure falls back to the local result with a warning, and never throws.
const offline = createModerator({ call: async () => { throw new Error('MiniMax could not be reached.'); } });
const fallback = await offline.moderate('I will kill him');
assert.equal(fallback.verdict, 'high_risk');
assert.equal(fallback.corrected_text, null);
assert.match(fallback.warning, /MiniMax/);

// A direct threat keeps its warning even if the model scores it as safe.
const optimistic = createModerator({ call: async m => m[0].content.includes('content-safety scorer') ? '{"score":0.1,"reason":"ok","category":"none"}' : '{"rewrite":null}' });
assert.equal((await optimistic.moderate('I will kill him')).verdict, 'high_risk');

// HTTP routes: preview, check, accept, decisions
const saved = [];
const service = createModeratorService({ moderator, persist: async item => { saved.push(item.id); return 'Test store'; } });
const server = http.createServer(moderatorHandler(service, { base: '/api/plugin' })).listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/plugin`;
const post = (action, body) => fetch(`${base}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, data: await r.json() }));
try {
  assert.equal((await post('preview', { text: 'I will kill him' })).data.verdict, 'high_risk');
  const checked = await post('check', { text: 'This decision is idiotic and so are you' });
  assert.equal(checked.data.storage, 'Test store');
  assert.equal(checked.data.corrected_text, calm);
  const accepted = await post('accept', { id: checked.data.id });
  assert.equal(accepted.data.text, calm);
  assert.equal(saved.length, 2);
  assert.equal((await post('check', { text: '' })).status, 400);
  assert.equal((await post('accept', { id: 'missing' })).status, 400);
  const history = await fetch(`${base}/decisions`).then(r => r.json());
  assert.equal(history.decisions[0].accepted, true);
  assert.equal((await fetch(`${base}/other`, { method: 'POST' })).status, 404);
} finally { server.close(); }
console.log('AI moderator plugin checks passed.');
