// Meta Model API client (Responses API, https://api.meta.ai/v1). Zero dependencies: plain fetch.
import fs from 'node:fs';

// Reads MODEL_API_KEY (the docs' name) or META_API_KEY from the environment or .env.local.
// Optional hooks, set by the app that hosts Lens (ARGUS uses them to stop at a credit budget):
//   key: the API key (otherwise read from the environment or .env.local)
//   before(model, content) → a reason string to refuse the call before it is made, or nothing
//   after(model, usage)    → the token counts of a finished answer
//   refused(status, message) → the API said no (e.g. out of credits)
const hooks = { key: null, before: null, after: null, refused: null };
export function configure(options = {}) { Object.assign(hooks, options); }
const usageOf = data => data?.usage || data?.response?.usage || null;

export function apiKey() {
  if (hooks.key) return hooks.key;
  if (process.env.MODEL_API_KEY) return process.env.MODEL_API_KEY.trim();
  if (process.env.META_API_KEY) return process.env.META_API_KEY.trim();
  try {
    // The project's own .env.local, wherever the process was started from.
    const env = fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
    const m = env.match(/^\s*(?:MODEL_API_KEY|META_API_KEY)\s*=\s*["']?([^"'\r\n]*)/m);
    return m && m[1].trim() ? m[1].trim() : null;
  } catch { return null; }
}

export const MODELS = { spark: 'muse-spark-1.3', wonder: 'muse-wonder-1.0', sam: 'sam-3.1' };
const BASE = process.env.MODEL_API_BASE || 'https://api.meta.ai/v1';

export class ModelError extends Error {}

// The answer text of a Responses API result.
function outputText(data) {
  if (typeof data.output_text === 'string') return data.output_text;
  return (data.output || []).filter(o => o.type === 'message')
    .flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('');
}

/**
 * One Responses API call. content = the user message's parts (input_text / input_image).
 * stream: SAM 3.1 streams its answer; we read the deltas and return the whole text.
 * Retries rate limits, server errors and dropped connections twice; never retries a timeout or a client error.
 */
export async function respond({ model, content, stream = false, extra = {}, timeoutMs = 60000 }) {
  const key = apiKey();
  if (!key) throw new ModelError('No Meta Model API key. Put MODEL_API_KEY=... in .env.local.');
  const stop = hooks.before?.(model, content);
  if (stop) throw new ModelError(stop);
  const body = JSON.stringify({ model, input: [{ type: 'message', role: 'user', content }], stream, ...extra });
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${BASE}/responses`, {
        method: 'POST', body, signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      if (err?.name === 'TimeoutError') throw new ModelError('The model took too long to answer.');
      // A dropped connection (it happens under load) is retried like a server error.
      if (attempt < 2) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1) + Math.random() * 500)); continue; }
      throw new ModelError('The model could not be reached.');
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1) + Math.random() * 500)); continue; }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      hooks.refused?.(res.status, err?.error?.message || '');
      throw new ModelError(`The model returned HTTP ${res.status}${err?.error?.message ? `: ${err.error.message}` : ''}.`);
    }
    if (!stream) { const data = await res.json(); hooks.after?.(model, usageOf(data)); return outputText(data); }
    // Server-sent events: collect the text deltas until the response completes.
    let text = '', buffer = '';
    for await (const chunk of res.body) {
      buffer += Buffer.from(chunk).toString('utf8');
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
        const line = event.split('\n').find(l => l.startsWith('data:'));
        if (!line) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return text;
        try {
          const e = JSON.parse(data);
          if (e.type === 'response.output_text.delta') text += e.delta;
          if (e.type === 'response.completed') { hooks.after?.(model, usageOf(e)); return text || outputText(e.response || {}); }
          if (e.type === 'error' || e.type === 'response.failed') throw new ModelError('The model failed while answering.');
        } catch (err) { if (err instanceof ModelError) throw err; }
      }
    }
    return text;
  }
}

/**
 * A streamed Responses API call, as the parsed server-sent events (`{ type, ... }`), for
 * consumers that read the stream themselves, such as @meta-sam/parser's parseImageStream.
 */
export async function* respondEvents({ model, content, extra = {}, timeoutMs = 60000 }) {
  const key = apiKey();
  if (!key) throw new ModelError('No Meta Model API key. Put MODEL_API_KEY=... in .env.local.');
  const stop = hooks.before?.(model, content);
  if (stop) throw new ModelError(stop);
  let res;
  try {
    res = await fetch(`${BASE}/responses`, {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: [{ type: 'message', role: 'user', content }], stream: true, ...extra }),
    });
  } catch (err) {
    throw new ModelError(err?.name === 'TimeoutError' ? 'The model took too long to answer.' : 'The model could not be reached.');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    hooks.refused?.(res.status, err?.error?.message || '');
    throw new ModelError(`The model returned HTTP ${res.status}${err?.error?.message ? `: ${err.error.message}` : ''}.`);
  }
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += Buffer.from(chunk).toString('utf8');
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
      const line = event.split('\n').find(l => l.startsWith('data:'));
      if (!line || line.slice(5).trim() === '[DONE]') continue;
      let e; try { e = JSON.parse(line.slice(5).trim()); } catch { continue; /* not JSON: skip */ }
      if (e.type === 'response.completed') hooks.after?.(model, usageOf(e));
      yield e;
    }
  }
}

// Pulls the first JSON object out of a reply, tolerating code fences and prose around it.
export function parseJson(text) {
  const cleaned = String(text).replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new ModelError('The model did not return JSON.');
  return JSON.parse(cleaned.slice(start, end + 1));
}
