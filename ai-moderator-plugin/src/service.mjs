// Server side of the plugin: preview / check / accept / ask / status / decisions, the
// moderator queue, plus a plain Node HTTP handler that also works as Express or Connect middleware.
import crypto from 'node:crypto';
import { createModerator } from './moderator.mjs';

export class ModeratorError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

// What the writer reads about a comment a moderator is handling.
export const REVIEW_REASONS = {
  waiting: 'A moderator will look at this shortly. It stays unposted until they decide.',
  flagged: 'This was sent to a moderator automatically. It stays unposted.',
  approved: 'A moderator approved this.',
  upheld: 'A moderator looked at this and kept it unposted. You can edit it and post again.',
  expired: 'No moderator got to this in time, so it stays unposted. You can edit it and post again.',
};

function draft(value, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ModeratorError('Enter a nonempty comment within the allowed length.');
  return value.trim();
}

// options.moderator: from createModerator(); options.decisions: array for history (newest first);
// options.persist(item, decisions) → storage label, e.g. to save to a database. Defaults to memory only.
// options.reviewTimeoutMs: a waiting review nobody answers in this time stays unposted (fail closed).
export function createModeratorService({ moderator = createModerator(), decisions = [], persist = async () => 'Memory only', limit = 300, reviewTimeoutMs = 10 * 60_000 } = {}) {
  async function save(item) {
    try { item.storage = await persist(item, decisions); } catch { item.storage = 'Not saved - storage unavailable'; }
    decisions.splice(limit);
    return item.storage;
  }
  const find = id => {
    const item = decisions.find(x => x.id === id);
    if (!item) throw new ModeratorError('No such comment.', 404);
    return item;
  };
  // Expires a waiting review that ran out of time. Checked on read, so no background job is needed.
  async function expire(item) {
    const r = item.review;
    if (r?.status === 'waiting' && Date.now() - Date.parse(r.requested_at) > reviewTimeoutMs) {
      r.status = 'expired'; r.resolved_at = new Date().toISOString();
      await save(item);
    }
    return item;
  }
  function openReview(item, status) {
    item.review = { status, requested_at: new Date().toISOString(), resolved_at: null, decision: null };
  }
  // What the writer's widget sees about a comment under review. `text` is set only once approved.
  function statusOf(item) {
    const status = item.review?.status ?? 'none';
    const approved = status === 'approved';
    return {
      id: item.id, status, allowed: approved, text: approved ? item.original_text : null,
      reason: REVIEW_REASONS[status] ?? item.reason,
      expires_at: status === 'waiting' ? new Date(Date.parse(item.review.requested_at) + reviewTimeoutMs).toISOString() : null,
    };
  }

  return {
    decisions,
    preview: text => moderator.inspectDraft(draft(text)),
    async check(text, replyingTo) {
      const original = draft(text);
      const result = await moderator.moderate(original, { replyingTo: typeof replyingTo === 'string' ? replyingTo : undefined });
      const item = { ...result, id: crypto.randomUUID(), original_text: original, created_at: new Date().toISOString(), accepted: false, review: null };
      // Unsure comments wait for a person; severe ones go to moderators automatically and stay unposted.
      if (result.verdict === 'unsure') openReview(item, 'waiting');
      if (result.verdict === 'severe') openReview(item, 'flagged');
      decisions.unshift(item); await save(item); return item;
    },
    // Accepting returns the exact suggestion the writer was shown — it already passed the check.
    async accept(id) {
      const item = decisions.find(x => x.id === id);
      if (!item?.suggestion) throw new ModeratorError('No checked suggestion to accept.');
      item.accepted = true; item.accepted_at = new Date().toISOString();
      return { text: item.suggestion, allowed: true, storage: await save(item) };
    },
    // [Ask a moderator] — the comment waits, unposted, for a human.
    async ask(id) {
      const item = await expire(find(id));
      if (item.allowed) throw new ModeratorError('This comment can already be posted.');
      if (item.verdict === 'unavailable') throw new ModeratorError("This comment wasn't checked — try checking it again.");
      if (item.review?.status === 'upheld') throw new ModeratorError(REVIEW_REASONS.upheld);
      // Already waiting, flagged or approved: nothing new to open. Expired: the writer may ask again.
      if (!item.review || item.review.status === 'expired') { openReview(item, 'waiting'); await save(item); }
      return statusOf(item);
    },
    async status(id) { return statusOf(await expire(find(id))); },
    // Moderator side: open reviews, oldest first.
    async queue() {
      for (const item of decisions) await expire(item);
      return decisions.filter(x => x.review && !x.review.resolved_at).reverse().map(x => ({
        id: x.id, text: x.original_text, verdict: x.verdict, reason: x.reason, meaning: x.meaning || '',
        status: x.review.status, requested_at: x.review.requested_at,
        expires_at: x.review.status === 'waiting' ? new Date(Date.parse(x.review.requested_at) + reviewTimeoutMs).toISOString() : null,
      }));
    },
    // decision: 'approve' posts the original words; 'uphold' keeps them unposted. Severe can't be approved.
    async resolve(id, decision) {
      if (decision !== 'approve' && decision !== 'uphold') throw new ModeratorError('Decision must be "approve" or "uphold".');
      const item = await expire(find(id));
      if (!item.review || item.review.resolved_at) throw new ModeratorError('This one is already handled.', 409);
      if (decision === 'approve' && item.verdict === 'severe') throw new ModeratorError("Severe comments can't be approved; the writer has to edit it.");
      item.review.status = decision === 'approve' ? 'approved' : 'upheld';
      item.review.decision = decision; item.review.resolved_at = new Date().toISOString();
      await save(item);
      return statusOf(item);
    },
    recent: (n = 30) => decisions.slice(0, n),
  };
}

// Writer routes: POST {base}/preview, /check, /accept, /ask, /status and GET {base}/decisions.
// Moderator routes: GET {base}/queue and POST {base}/resolve — only mounted when moderatorSecret
// is set, and they need header `x-moderator-admin: <moderatorSecret>`. Otherwise call
// service.queue() / service.resolve() from your own admin page.
// options.secret: if set, every request must send header `x-moderator-key: <secret>`.
// options.perMinute: max check/accept/ask requests per client IP per minute (protects your model credits).
export function moderatorHandler(service = createModeratorService(), { base = '/api/plugin', secret = null, moderatorSecret = null, perMinute = 20 } = {}) {
  const send = (res, value, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };
  const hits = new Map();
  function limited(req) {
    const ip = req.socket?.remoteAddress || 'unknown', now = Date.now();
    const recent = (hits.get(ip) || []).filter(t => now - t < 60000);
    recent.push(now); hits.set(ip, recent);
    return recent.length > perMinute;
  }
  async function body(req) {
    if (req.body && typeof req.body === 'object') return req.body; // already parsed (e.g. express.json())
    let value = ''; for await (const chunk of req) { value += chunk; if (value.length > 24000) throw new ModeratorError('Request too large.', 413); }
    try { return JSON.parse(value || '{}'); } catch { throw new ModeratorError('Invalid JSON.'); }
  }
  return async function handle(req, res, next) {
    const route = new URL(req.url, 'http://localhost').pathname;
    if (!route.startsWith(base + '/')) return next ? next() : send(res, { error: 'Not found' }, 404);
    const action = route.slice(base.length + 1);
    const pass = () => next ? next() : send(res, { error: 'Not found' }, 404);
    try {
      if (secret && req.headers['x-moderator-key'] !== secret) throw new ModeratorError('Not authorised.', 401);
      if (action === 'queue' || action === 'resolve') {
        if (!moderatorSecret) return pass();
        if (req.headers['x-moderator-admin'] !== moderatorSecret) throw new ModeratorError('Not authorised.', 401);
        if (req.method === 'GET' && action === 'queue') return send(res, { queue: await service.queue() });
        if (req.method === 'POST' && action === 'resolve') { const input = await body(req); return send(res, await service.resolve(input.id, input.decision)); }
        return pass();
      }
      if (req.method === 'GET' && action === 'decisions') return send(res, { decisions: service.recent() });
      if (req.method !== 'POST') return pass();
      const input = await body(req);
      if (action === 'preview') return send(res, service.preview(input.text));
      if (action === 'status') return send(res, await service.status(input.id));
      if (action !== 'check' && action !== 'accept' && action !== 'ask') return pass();
      if (limited(req)) throw new ModeratorError('Too many checks — wait a minute and try again.', 429);
      if (action === 'check') return send(res, await service.check(input.text, input.replyingTo));
      if (action === 'ask') return send(res, await service.ask(input.id));
      return send(res, await service.accept(input.id));
    } catch (error) {
      send(res, { error: error instanceof ModeratorError ? error.message : 'The moderator could not process this request.' }, error.status || 500);
    }
  };
}
