// No network: the model is a stub. Run with `npm test` inside plugin/.
import assert from 'node:assert/strict';
import http from 'node:http';
import { inspectDraft, createModerator, createModeratorService, moderatorHandler, parseJson, redact } from '../src/index.mjs';

// A stub model: scores come from a lookup table; rewrites/meaning checks from simple rules.
function stubModel({ scores, rewrite = 'I strongly disagree with this.', faithful = true, chatty = false, unsure = [], coarse = [], meanings = {} }) {
  return async (messages) => {
    const system = messages[0].content, user = messages[1].content;
    if (system.includes('content-safety scorer')) {
      const text = user.split('\n\n(')[0];
      const s = scores[text] ?? 0.05;
      const unsureText = (unsure || []).includes(text);
      const json = JSON.stringify({ meaning: unsureText ? 'not sure' : meanings[text] || '', sure: !unsureText, score: s, category: s >= 0.85 ? 'threat' : s >= 0.4 ? 'insult' : 'clean', reason: s >= 0.85 ? 'This threatens someone. Threats make people afraid.' : 'Plain reason.', coarse: coarse.includes(text) });
      return chatty ? `Sure! Here is my verdict: ${json} Hope that helps.` : json;
    }
    if (system.includes('proposed civil rewrite')) return JSON.stringify({ faithful });
    return JSON.stringify({ rewrite: typeof rewrite === 'function' ? rewrite(user) : rewrite });
  };
}

// --- typing hint: escalates, never allows ---
assert.equal(inspectDraft('I will kill him').hint, 'threat');
assert.equal(inspectDraft("I'll end you").hint, 'threat');
assert.notEqual(inspectDraft('I will not kill him').hint, 'threat');
assert.notEqual(inspectDraft('He said "I will kill you" in the trailer').hint, 'threat');
assert.equal(inspectDraft('The character said nothing, I will kill you').hint, 'threat', 'no "character" loophole');
assert.equal(inspectDraft('you are a moron').hint, 'check');
assert.equal(inspectDraft('உன்னை கொன்னுடுவேன்').hint, 'threat', 'Tamil threat');
assert.equal(inspectDraft('unna kolla poren').hint, 'threat', 'Tanglish threat');
assert.equal(inspectDraft('tujhe jaan se maar dunga').hint, 'threat', 'Hinglish threat');
assert.equal(inspectDraft('enakku idhu pudikala').hint, null, 'harmless Tanglish');
assert.equal(inspectDraft('Lovely weather today').hint, null);

// --- forgiving JSON + privacy masking ---
assert.deepEqual(parseJson('Here you go: {"a": 1} thanks'), { a: 1 });
assert.equal(redact('mail me at a.b@c.com or +91 98765 43210'), 'mail me at [EMAIL] or [PHONE]');

// --- clean posts ---
const m = createModerator({ call: stubModel({ scores: { 'you are an idiot': 0.55, 'I will hurt you': 0.95 } }) });
let r = await m.moderate('Great post!');
assert.equal(r.verdict, 'clean'); assert.equal(r.allowed, true); assert.equal(r.suggestion, null);

// --- rude: not allowed, checked suggestion offered ---
r = await m.moderate('you are an idiot');
assert.equal(r.verdict, 'rude'); assert.equal(r.allowed, false); assert.equal(r.suggestion, 'I strongly disagree with this.');

// --- severe: not allowed, explanation, NO AI rewrite ---
r = await m.moderate('I will hurt you');
assert.equal(r.verdict, 'severe'); assert.equal(r.allowed, false); assert.equal(r.suggestion, null);
assert.ok(r.reason);

// --- a threat the model under-scores is still severe (hint escalates) ---
const optimistic = createModerator({ call: stubModel({ scores: { 'I will kill him': 0.1 } }) });
assert.equal((await optimistic.moderate('I will kill him')).verdict, 'severe');

// --- chatty model replies still parse ---
const chatty = createModerator({ call: stubModel({ scores: { 'you are an idiot': 0.55 }, chatty: true }) });
assert.equal((await chatty.moderate('you are an idiot')).verdict, 'rude');

// --- unsure about a non-English comment → a person decides (not posted, no guess) ---
const unsureModel = createModerator({ call: stubModel({ scores: { 'enna idhu da': 0.1, 'poda dei': 0.95 }, unsure: ['enna idhu da', 'poda dei'] }) });
r = await unsureModel.moderate('enna idhu da');
assert.equal(r.verdict, 'unsure'); assert.equal(r.allowed, false); assert.equal(r.suggestion, null);
assert.equal((await unsureModel.moderate('poda dei')).verdict, 'severe', 'severe still wins over unsure');
const englishUnsure = createModerator({ call: async (m) => m[0].content.includes('content-safety') ? '{"meaning":"","sure":false,"score":0.1,"category":"clean","reason":"ok"}' : '{}' });
assert.equal((await englishUnsure.moderate('nice post')).verdict, 'clean', 'English is never unsure');
const borderline = createModerator({ call: async (m) => m[0].content.includes('content-safety') ? '{"meaning":"why do you even get this job","sure":true,"score":0.35,"category":"clean","reason":"ok"}' : '{}' });
assert.equal((await borderline.moderate('unakku ellam edhuku da indha velai')).verdict, 'unsure', 'non-English near the line goes to a person');
const englishBorderline = createModerator({ call: async (m) => m[0].content.includes('content-safety') ? '{"meaning":"","sure":true,"score":0.35,"category":"clean","reason":"ok"}' : '{}' });
assert.equal((await englishBorderline.moderate('you clearly did not test this')).verdict, 'clean', 'English near the line still posts');

// --- fail closed: model down → not allowed ---
const offline = createModerator({ call: async () => { throw new Error('down'); } });
r = await offline.moderate('kys');
assert.equal(r.verdict, 'unavailable'); assert.equal(r.allowed, false);

// --- a failed rewrite never discards the verdict ---
let calls = 0;
const flaky = createModerator({ call: async (msgs) => {
  if (msgs[0].content.includes('content-safety scorer')) return '{"score":0.55,"category":"insult","reason":"x"}';
  calls++; throw new Error('rewrite step down');
} });
r = await flaky.moderate('you are an idiot');
assert.equal(r.verdict, 'rude'); assert.equal(r.allowed, false); assert.equal(r.suggestion, null); assert.ok(calls >= 1);

// --- suggestion gates: wrong language or changed meaning is never offered ---
const english = createModerator({ call: stubModel({ scores: { 'तुम बेवकूफ हो': 0.55 }, rewrite: 'I disagree.' }) });
assert.equal((await english.moderate('तुम बेवकूफ हो')).suggestion, null, 'Hindi in must not get English out');
const tamil = createModerator({ call: stubModel({ scores: { 'நீ ஒரு முட்டாள்': 0.55 }, rewrite: 'I disagree.' }) });
assert.equal((await tamil.moderate('நீ ஒரு முட்டாள்')).suggestion, null, 'Tamil in must not get English out');
const unfaithful = createModerator({ call: stubModel({ scores: { 'you are an idiot': 0.55 }, faithful: false }) });
assert.equal((await unfaithful.moderate('you are an idiot')).suggestion, null);
// A suggestion that scores clean but still swears is not offered; the retry is.
let tries = 0;
const crude = createModerator({ call: stubModel({ scores: { 'ur content and you are absolute shit': 0.6 }, coarse: ['This content is absolute shit.'], rewrite: () => (++tries === 1 ? 'This content is absolute shit.' : 'I think this content is really bad.') }) });
assert.equal((await crude.moderate('ur content and you are absolute shit')).suggestion, 'I think this content is really bad.');
const alwaysCrude = createModerator({ call: stubModel({ scores: { 'you are shit': 0.6 }, coarse: ['This is shit.'], rewrite: 'This is shit.' }) });
assert.equal((await alwaysCrude.moderate('you are shit')).suggestion, null, 'never offer a suggestion that swears');
// Tanglish in, English out is rejected even though both use English letters.
let tanglishTries = 0;
const tanglish = createModerator({ call: stubModel({ scores: { 'nee oru loosu': 0.5 }, meanings: { 'nee oru loosu': "you're crazy", 'nee solradhu enakku puriyala': "what you say doesn't seem right to me" }, rewrite: () => (++tanglishTries === 1 ? "I don't agree with this." : 'nee solradhu enakku puriyala') }) });
assert.equal((await tanglish.moderate('nee oru loosu')).suggestion, 'nee solradhu enakku puriyala');

// --- the post being replied to reaches the rewrite prompt ---
let sawPost = false;
const ctx = createModerator({ call: stubModel({ scores: { 'i hate you': 0.45 }, rewrite: u => { sawPost = u.includes('Post being replied to: singing'); return "I'm not a fan of your singing."; } }) });
r = await ctx.moderate('i hate you', { replyingTo: 'singing at an event' });
assert.ok(sawPost); assert.equal(r.suggestion, "I'm not a fan of your singing.");

// --- HTTP routes: preview, check, accept, decisions, secret, rate limit ---
const saved = [];
const service = createModeratorService({ moderator: m, persist: async item => { saved.push(item.id); return 'Test store'; } });
const server = http.createServer(moderatorHandler(service, { base: '/api/plugin', perMinute: 5 })).listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/plugin`;
const post = (action, body, headers = {}) => fetch(`${base}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(async res => ({ status: res.status, data: await res.json() }));
try {
  assert.equal((await post('preview', { text: 'I will kill him' })).data.hint, 'threat');
  const checked = await post('check', { text: 'you are an idiot' });
  assert.equal(checked.data.allowed, false);
  assert.equal(checked.data.suggestion, 'I strongly disagree with this.');
  const accepted = await post('accept', { id: checked.data.id });
  assert.equal(accepted.data.text, 'I strongly disagree with this.'); assert.equal(accepted.data.allowed, true);
  assert.equal((await post('check', { text: '' })).status, 400);
  assert.equal((await post('accept', { id: 'missing' })).status, 400);
  const limitedStatus = [];
  for (let i = 0; i < 4; i++) limitedStatus.push((await post('check', { text: 'hello' })).status);
  assert.ok(limitedStatus.includes(429), 'rate limit kicks in');
  const history = await fetch(`${base}/decisions`).then(res => res.json());
  assert.equal(history.decisions.find(d => d.id === checked.data.id).accepted, true);
} finally { server.close(); }

// --- moderator review: ask, unsure waits, severe flagged, approve/uphold, timeout fails closed ---
const reviewModerator = createModerator({ call: stubModel({ scores: { 'you are an idiot': 0.55, 'I will hurt you': 0.95, 'enna idhu da': 0.1 }, unsure: ['enna idhu da'] }) });
const reviews = createModeratorService({ moderator: reviewModerator, reviewTimeoutMs: 60_000 });
const rude = await reviews.check('you are an idiot');
assert.equal(rude.review, null, 'rude waits for the writer, not a moderator');
let state = await reviews.ask(rude.id);
assert.equal(state.status, 'waiting'); assert.equal(state.allowed, false); assert.equal(state.text, null); assert.ok(state.reason);
const unsureItem = await reviews.check('enna idhu da');
assert.equal(unsureItem.review.status, 'waiting', 'unsure goes to a person on its own');
const severeItem = await reviews.check('I will hurt you');
assert.equal(severeItem.review.status, 'flagged', 'severe goes to moderators automatically');
assert.deepEqual((await reviews.queue()).map(q => q.id), [rude.id, unsureItem.id, severeItem.id]);
await assert.rejects(reviews.resolve(severeItem.id, 'approve'), /can't be approved/);
assert.equal((await reviews.ask(severeItem.id)).allowed, false, 'asking about severe never opens a way to post');
state = await reviews.resolve(rude.id, 'approve');
assert.equal(state.allowed, true); assert.equal(state.text, 'you are an idiot');
assert.equal((await reviews.status(rude.id)).allowed, true);
await assert.rejects(reviews.resolve(rude.id, 'uphold'), /already handled/);
state = await reviews.resolve(unsureItem.id, 'uphold');
assert.equal(state.status, 'upheld'); assert.equal(state.allowed, false);
await assert.rejects(reviews.ask(unsureItem.id), /kept it unposted/);
await assert.rejects(reviews.ask((await reviews.check('Great post!')).id), /already be posted/);
// Nobody answers in time → stays unposted.
const quick = createModeratorService({ moderator: reviewModerator, reviewTimeoutMs: 20 });
const late = await quick.check('you are an idiot');
await quick.ask(late.id);
await new Promise(r => setTimeout(r, 40));
state = await quick.status(late.id);
assert.equal(state.status, 'expired'); assert.equal(state.allowed, false);
await assert.rejects(quick.resolve(late.id, 'approve'), /already handled/);
assert.equal((await quick.queue()).length, 0);
assert.equal((await quick.ask(late.id)).status, 'waiting', 'the writer may ask again after a timeout');

// HTTP: writer can ask and read status; moderator routes need their own secret, and are off without one.
const reviewServer = http.createServer(moderatorHandler(reviews, { moderatorSecret: 'mod' })).listen(0);
const openServer = http.createServer(moderatorHandler(reviews)).listen(0);
try {
  const rb = `http://127.0.0.1:${reviewServer.address().port}/api/plugin`;
  const call = (action, body, headers = {}) => fetch(`${rb}/${action}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) }).then(async res => ({ status: res.status, data: await res.json() }));
  const fresh = await call('check', { text: 'you are an idiot' });
  assert.equal((await call('ask', { id: fresh.data.id })).data.status, 'waiting');
  assert.equal((await call('status', { id: fresh.data.id })).data.allowed, false);
  assert.equal((await call('status', { id: 'missing' })).status, 404);
  assert.equal((await call('queue')).status, 401);
  assert.equal((await call('resolve', { id: fresh.data.id, decision: 'approve' })).status, 401, 'a writer cannot approve their own comment');
  assert.ok((await call('queue', null, { 'x-moderator-admin': 'mod' })).data.queue.some(q => q.id === fresh.data.id));
  assert.equal((await call('resolve', { id: fresh.data.id, decision: 'approve' }, { 'x-moderator-admin': 'mod' })).data.allowed, true);
  assert.equal((await call('status', { id: fresh.data.id })).data.text, 'you are an idiot');
  const openBase = `http://127.0.0.1:${openServer.address().port}/api/plugin`;
  assert.equal((await fetch(`${openBase}/queue`)).status, 404, 'no moderatorSecret → no moderator routes');
} finally { reviewServer.close(); openServer.close(); }

const locked = http.createServer(moderatorHandler(service, { secret: 's3cret' })).listen(0);
try {
  const url = `http://127.0.0.1:${locked.address().port}/api/plugin/preview`;
  assert.equal((await fetch(url, { method: 'POST', body: '{"text":"hi"}' })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'x-moderator-key': 's3cret' }, body: '{"text":"hi"}' })).status, 200);
} finally { locked.close(); }

console.log('AI moderator plugin checks passed.');
