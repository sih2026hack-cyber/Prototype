// The ARGUS browser extension's server side (extension/):
//   Comment moderator: POST /api/ext/check, /api/ext/peek, /api/ext/suggest; GET /api/ext/status?id=
//   Argus Lens:        POST /api/lens/assess (image bytes), /api/lens/assess-video (MP4 bytes)
// The Lens page (/lens) uses the same Lens routes. Model keys never leave the server.
// Every route is rate limited per client, since each check spends model credits.
import { ModeratorError } from '../ai-moderator-plugin/src/index.mjs';

export const EXT_SITES = ['youtube', 'reddit', 'instagram', 'instagram_dm', 'whatsapp'];
/** Private messages: checked but never stored, never shown to a moderator. */
const PRIVATE_SITES = ['whatsapp', 'instagram_dm'];
const UNSURE_PRIVATE = "We can't read this one confidently, so it isn't sent. Try rephrasing it more clearly.";
const MAX_COMMENT_CHARS = 2000;
const MAX_IMAGE = 10 * 1024 * 1024, MAX_VIDEO = 20 * 1024 * 1024;

const send = (res, value, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };

function limiter(perMinute) {
  const hits = new Map();
  return req => {
    const ip = req.socket?.remoteAddress || 'unknown', now = Date.now();
    const recent = (hits.get(ip) || []).filter(t => now - t < 60_000);
    recent.push(now); hits.set(ip, recent);
    if (hits.size > 5000) hits.delete(hits.keys().next().value);
    return recent.length > perMinute;
  };
}

async function readBody(req, max, tooBig) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new ModeratorError(tooBig, 413); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function readJson(req) {
  try { return JSON.parse((await readBody(req, 24000, 'Request too large.')).toString('utf8') || '{}'); }
  catch (error) { if (error instanceof ModeratorError) throw error; throw new ModeratorError('Invalid JSON.'); }
}
const commentText = value => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > MAX_COMMENT_CHARS) throw new ModeratorError(`Expected a comment of 1-${MAX_COMMENT_CHARS} characters.`);
  return text;
};
const context = value => typeof value === 'string' ? value.slice(0, 500) : undefined;

// The plugin's review states, in the extension's words.
const EXT_STATUS = { waiting: 'pending', approved: 'approved', upheld: 'rejected', expired: 'expired' };

/**
 * plugin: the ARGUS moderator service (createModeratorService), so extension checks appear in
 *   the same decisions list and moderator queue as checks from the dashboard.
 * moderator: the engine, for checks that must not be stored (private messages, typing hints).
 * lens: { assess, assessVideo } from lib/lens.mjs.
 * Returns handle(req, res, url) → true when it answered.
 */
export function createExtensionApi({ plugin, moderator, lens, checksPerMinute = 20, lensPerMinute = 10 }) {
  const commentLimited = limiter(checksPerMinute), lensLimited = limiter(lensPerMinute);

  async function check(input) {
    const text = commentText(input.text), site = input.site;
    if (!EXT_SITES.includes(site)) throw new ModeratorError(`Expected site: ${EXT_SITES.join(' | ')}.`);
    if (PRIVATE_SITES.includes(site)) {
      const r = await moderator.moderate(text, { replyingTo: context(input.replyingTo) });
      return { id: null, allowed: r.allowed, verdict: r.verdict, reason: r.verdict === 'unsure' ? UNSURE_PRIVATE : r.reason, label: r.label ?? null, suggestion: r.suggestion ?? null };
    }
    const item = await plugin.check(text, context(input.replyingTo));
    item.site = site; // shown in the decisions list
    return { id: item.verdict === 'unavailable' ? null : item.id, allowed: item.allowed, verdict: item.verdict, reason: item.reason, label: item.label ?? null, suggestion: item.suggestion ?? null };
  }

  async function status(id) {
    try { return { status: EXT_STATUS[(await plugin.status(id)).status] || 'none' }; }
    catch { return { status: 'none' }; }
  }

  return async function handle(req, res, url) {
    const route = url.pathname;
    if (!route.startsWith('/api/ext/') && !route.startsWith('/api/lens/')) return false;
    try {
      if (route === '/api/ext/status' && req.method === 'GET') return send(res, await status(url.searchParams.get('id') || '')), true;
      if (req.method !== 'POST') return send(res, { error: 'Not found' }, 404), true;
      if (route.startsWith('/api/ext/')) {
        if (commentLimited(req)) throw new ModeratorError('Too many checks — wait a minute and try again.', 429);
        const input = await readJson(req);
        if (route === '/api/ext/check') return send(res, await check(input)), true;
        if (route === '/api/ext/peek') {
          // The live hint while typing: verdict only, nothing stored, nothing sent to moderators.
          const r = await moderator.moderate(commentText(input.text), { suggest: false });
          return send(res, { verdict: r.verdict, reason: r.reason, label: r.label ?? null }), true;
        }
        if (route === '/api/ext/suggest') {
          // A better way to say a rude draft, made only when the writer asks for it.
          const r = await moderator.moderate(commentText(input.text), { replyingTo: context(input.replyingTo) });
          return send(res, { suggestion: r.verdict === 'rude' ? r.suggestion : null, reason: r.reason }), true;
        }
      }
      if (route === '/api/lens/assess' || route === '/api/lens/assess-video') {
        if (lensLimited(req)) throw new ModeratorError('Too many checks — wait a minute and try again.', 429);
        const video = route.endsWith('video');
        const bytes = await readBody(req, video ? MAX_VIDEO : MAX_IMAGE, video ? 'Videos up to 20 MB.' : 'Images up to 10 MB.');
        if (!bytes.length) throw new ModeratorError(`No ${video ? 'video' : 'image'} was sent.`);
        try { return send(res, await (video ? lens.assessVideo : lens.assess)(bytes)), true; }
        catch (error) { console.error(error); throw new ModeratorError(`Lens could not check this ${video ? 'video' : 'image'}.`, 500); }
      }
      return send(res, { error: 'Not found' }, 404), true;
    } catch (error) {
      send(res, { error: error instanceof ModeratorError ? error.message : 'The request could not be processed.' }, error.status || 500);
      return true;
    }
  };
}
