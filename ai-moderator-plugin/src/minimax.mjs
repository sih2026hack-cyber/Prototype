// Minimal MiniMax chat client. Any function with the same shape — call(messages, maxTokens) → string — can replace it.
export function createMiniMax({
  apiKey = process.env.MINIMAX_API_KEY,
  model = process.env.MINIMAX_MODEL || 'MiniMax-Text-01',
  url = process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/v1/text/chatcompletion_v2',
  timeoutMs = 90000,
} = {}) {
  if (url.endsWith('/v1')) url += '/chat/completions';
  if (/^https:\/\/[^/]+\/?$/.test(url)) url = url.replace(/\/$/, '') + '/v1/text/chatcompletion_v2';
  return async function call(messages, maxTokens = 1800) {
    if (!apiKey) throw new Error('MiniMax is not configured. Set MINIMAX_API_KEY.');
    let response;
    try {
      response = await fetch(url, {
        method: 'POST', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: maxTokens }),
      });
    } catch { throw new Error('MiniMax could not be reached. Check the connection.'); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`MiniMax returned HTTP ${response.status}.`);
    if (data.base_resp?.status_code) throw new Error(`MiniMax rejected the request (code ${data.base_resp.status_code}). Check the API key, account region and balance.`);
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('MiniMax returned no answer.');
    return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  };
}

// Parses model output that may be wrapped in a ```json fence.
export function parseJson(text) {
  return JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
}
