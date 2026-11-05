// ARGUS uses the standalone comment moderator in ai-moderator-plugin/.
//
// Which model checks comments:
//   1. NVIDIA Nemotron on Nebius Token Factory (what the moderator was tuned and tested on),
//      but only while there are credits left.
//   2. MiniMax (the model the rest of ARGUS uses) once Nemotron's credits are used up, so no
//      extra money is spent on Nebius.
//
// "Credits used up" means either:
//   - NEBIUS_CREDIT_USD is set and the tracked spend has reached it. Spend is estimated from the
//     token counts Nebius returns, at NEMOTRON_PRICE_IN / NEMOTRON_PRICE_OUT dollars per million
//     tokens, and kept in data/runtime/nemotron-usage.json so it survives restarts; or
//   - Nebius itself refuses with a billing error (no balance, quota used, key blocked).
// Either way ARGUS stays on MiniMax until the usage file is reset or the budget is raised.
// A passing Nemotron failure (timeout, server error) sends just that one call to MiniMax.
import { env } from './config.mjs';
import { minimax } from './providers.mjs';
import { readLocal, saveLocal } from './storage.mjs';
import { createModerator, createNemotron } from '../ai-moderator-plugin/src/index.mjs';
export { inspectDraft } from '../ai-moderator-plugin/src/index.mjs';

const num = (value, fallback) => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : fallback; };
const PRICE_IN = num(env.NEMOTRON_PRICE_IN, 1.0);   // US$ per million input tokens (Nebius list price, Nov 2026)
const PRICE_OUT = num(env.NEMOTRON_PRICE_OUT, 3.0); // US$ per million output tokens
const BUDGET = env.NEBIUS_CREDIT_USD === undefined || env.NEBIUS_CREDIT_USD === '' ? null : num(env.NEBIUS_CREDIT_USD, 0);

const usage = readLocal('nemotron-usage', { input_tokens: 0, output_tokens: 0, spent_usd: 0, exhausted: null });
const state = {
  provider: !env.NEBIUS_API_KEY ? 'minimax' : usage.exhausted || (BUDGET !== null && usage.spent_usd >= BUDGET) ? 'minimax' : 'nemotron',
  reason: !env.NEBIUS_API_KEY ? 'NEBIUS_API_KEY is not set.' : usage.exhausted || (BUDGET !== null && usage.spent_usd >= BUDGET ? `Nemotron budget of $${BUDGET} reached.` : null),
};

function switchToMiniMax(reason) {
  state.provider = 'minimax'; state.reason = reason;
  usage.exhausted = reason; saveLocal('nemotron-usage', usage);
  console.log(`Moderator: switched from Nemotron to MiniMax. ${reason}`);
}

function track({ prompt_tokens = 0, completion_tokens = 0 }) {
  usage.input_tokens += prompt_tokens; usage.output_tokens += completion_tokens;
  usage.spent_usd = (usage.input_tokens * PRICE_IN + usage.output_tokens * PRICE_OUT) / 1e6;
  saveLocal('nemotron-usage', usage);
  if (BUDGET !== null && usage.spent_usd >= BUDGET) switchToMiniMax(`Nemotron budget of $${BUDGET} reached (about $${usage.spent_usd.toFixed(4)} used).`);
}

// Nebius refusing for money or access reasons, not a passing hiccup.
export function isOutOfCredits(error) {
  if (error?.status === 402 || error?.status === 401 || error?.status === 403) return true;
  return /credit|balance|quota|billing|payment|insufficient|funds|exceeded your/i.test(error?.detail || '');
}

const nemotron = env.NEBIUS_API_KEY ? createNemotron({ apiKey: env.NEBIUS_API_KEY, baseUrl: env.LLM_BASE_URL, model: env.LLM_MODEL, onUsage: track }) : null;

async function call(messages, maxTokens) {
  if (state.provider === 'nemotron') {
    try { return await nemotron(messages, maxTokens); }
    catch (error) {
      if (isOutOfCredits(error)) switchToMiniMax(`Nebius refused the request (HTTP ${error.status}): out of credits or key not allowed.`);
      // Otherwise a passing failure: this one call goes to MiniMax, Nemotron stays the default.
    }
  }
  return minimax(messages, maxTokens);
}

export const moderatorModel = () => ({
  provider: state.provider, reason: state.reason,
  nemotron: { budget_usd: BUDGET, spent_usd: Number(usage.spent_usd.toFixed(4)), input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
});
export const moderator = createModerator({ call });
export const moderate = moderator.moderate;
