// Server side of the plugin: preview / check / accept / decisions, plus a plain Node HTTP handler
// that also works as Express or Connect middleware.
import crypto from 'node:crypto';
import { createModerator, redact } from './moderator.mjs';

export class ModeratorError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

function draft(value, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ModeratorError('Enter a nonempty draft within the allowed length.');
  return redact(value.trim());
}

// options.moderator: from createModerator(); options.decisions: an array to keep history in (newest first);
// options.persist(item, decisions) → storage label (string), e.g. to save to a database. Defaults to memory only.
export function createModeratorService({ moderator = createModerator(), decisions = [], persist = async () => 'Memory only', limit = 300 } = {}) {
  async function save(item) {
    try { item.storage = await persist(item, decisions); } catch { item.storage = 'Not saved - storage unavailable'; }
    decisions.splice(limit);
    return item.storage;
  }
  return {
    decisions,
    preview: text => moderator.inspectDraft(draft(text)),
    async check(text) {
      const original = draft(text), result = await moderator.moderate(original);
      const item = { ...result, id: crypto.randomUUID(), original_text: original, created_at: new Date().toISOString(), accepted: false };
      decisions.unshift(item); await save(item); return item;
    },
    async accept(id) {
      const item = decisions.find(x => x.id === id);
      if (!item?.corrected_text || !item.complete) throw new ModeratorError('No verified suggestion to accept.');
      item.accepted = true; item.accepted_at = new Date().toISOString();
      return { text: item.corrected_text, storage: await save(item) };
    },
    recent: (n = 30) => decisions.slice(0, n),
  };
}

// Mounts POST {base}/preview, POST {base}/check, POST {base}/accept and GET {base}/decisions.
// Returns a (req, res, next) function; with no next it answers 404 for routes it does not own.
export function moderatorHandler(service = createModeratorService(), { base = '/api/plugin' } = {}) {
  const send = (res, value, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };
  async function body(req) {
    if (req.body && typeof req.body === 'object') return req.body; // already parsed (e.g. express.json())
    let value = ''; for await (const chunk of req) { value += chunk; if (value.length > 24000) throw new ModeratorError('Request too large.', 413); }
    try { return JSON.parse(value || '{}'); } catch { throw new ModeratorError('Invalid JSON.'); }
  }
  return async function handle(req, res, next) {
    const route = new URL(req.url, 'http://localhost').pathname;
    if (!route.startsWith(base + '/')) return next ? next() : send(res, { error: 'Not found' }, 404);
    const action = route.slice(base.length + 1);
    try {
      if (req.method === 'GET' && action === 'decisions') return send(res, { enabled: true, decisions: service.recent() });
      if (req.method !== 'POST') return next ? next() : send(res, { error: 'Not found' }, 404);
      const input = await body(req);
      if (action === 'preview') return send(res, service.preview(input.text));
      if (action === 'check') return send(res, await service.check(input.text));
      if (action === 'accept') return send(res, await service.accept(input.id));
      return next ? next() : send(res, { error: 'Not found' }, 404);
    } catch (error) {
      send(res, { error: error instanceof ModeratorError ? error.message : 'The moderator could not process this request.' }, error.status || 500);
    }
  };
}
