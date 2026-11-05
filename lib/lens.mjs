// Argus Lens inside ARGUS: is an image or video AI-made, and is it harmful to post? (lens/)
//
// Lens runs on Meta's paid Model API (Muse Wonder + SAM 3.1) and has no cheaper backup model
// (MiniMax can't see images), so the rule is: use Meta only while credits last, then stop.
// "Credits used up" means either:
//   - META_CREDIT_USD is set and the estimated spend has reached it. Spend is estimated from the
//     token counts Meta returns plus SAM's per-image / per-frame price, and kept in
//     data/runtime/meta-usage.json so it survives restarts; or
//   - Meta refuses a request for billing reasons (no balance, quota used, key blocked).
// After that every check answers "Couldn't check" without calling Meta, until the usage file is
// deleted or the budget is raised. The file-label check (code, free) still works.
import { env } from './config.mjs';
import { readLocal, saveLocal } from './storage.mjs';
import { createLens } from '../lens/src/lens.mjs';
import { configure, MODELS } from '../lens/src/meta.mjs';
import { mp4Info } from '../lens/src/mp4.mjs';

const num = (value, fallback) => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : fallback; };
// US$ list prices (Nov 2026): per million tokens for the Muse models, per image / frame for SAM.
const PRICES = {
  [MODELS.wonder]: { in: 4.0, out: 20.0 },
  [MODELS.spark]: { in: 1.25, out: 4.25 },
  samImage: num(env.SAM_PRICE_PER_IMAGE, 0.0025),
  samFrame: num(env.SAM_PRICE_PER_FRAME, 0.0002),
};
const BUDGET = env.META_CREDIT_USD === undefined || env.META_CREDIT_USD === '' ? null : num(env.META_CREDIT_USD, 0);
const KEY = env.MODEL_API_KEY || env.META_API_KEY || '';

const usage = readLocal('meta-usage', { spent_usd: 0, calls: 0, exhausted: null });
const save = () => saveLocal('meta-usage', usage);
const outOfBudget = () => BUDGET !== null && usage.spent_usd >= BUDGET;
function exhaust(reason) {
  if (usage.exhausted) return;
  usage.exhausted = reason; save();
  console.log(`Lens: stopped using the Meta API. ${reason}`);
}
function spend(usd) {
  usage.spent_usd += usd; usage.calls += 1; save();
  if (outOfBudget()) exhaust(`Meta budget of $${BUDGET} reached (about $${usage.spent_usd.toFixed(4)} used).`);
}

// SAM is priced per image or per video frame, so it is counted when the call is made.
function samCost(content) {
  const video = content.find(c => c.type === 'input_video');
  if (!video) return PRICES.samImage;
  try {
    const info = mp4Info(Buffer.from(String(video.video_url).split(',')[1] || '', 'base64'));
    return (info?.frameTimes.length || 1800) * PRICES.samFrame; // unknown length: assume 60 s at 30 fps
  } catch { return 1800 * PRICES.samFrame; }
}

configure({
  key: KEY || null,
  before(model, content) {
    if (usage.exhausted) return `Meta API credits are used up, so this wasn't checked. ${usage.exhausted}`;
    if (outOfBudget()) { exhaust(`Meta budget of $${BUDGET} reached.`); return "Meta API credits are used up, so this wasn't checked."; }
    if (model === MODELS.sam) spend(samCost(content));
  },
  after(model, tokens) {
    const price = PRICES[model];
    if (!price || !tokens) return;
    spend(((tokens.input_tokens || 0) * price.in + (tokens.output_tokens || 0) * price.out) / 1e6);
  },
  refused(status, message) {
    if (status === 402 || status === 401 || status === 403 || /credit|balance|quota|billing|payment|insufficient|funds/i.test(message)) {
      exhaust(`Meta refused the request (HTTP ${status}): out of credits or key not allowed.`);
    }
  },
});

export const lens = createLens(env.LENS_MODEL ? { model: env.LENS_MODEL } : {});
export const lensStatus = () => ({
  configured: Boolean(KEY),
  available: Boolean(KEY) && !usage.exhausted && !outOfBudget(),
  reason: !KEY ? 'MODEL_API_KEY is not set: only the free file-label check runs.' : usage.exhausted,
  budget_usd: BUDGET, spent_usd: Number(usage.spent_usd.toFixed(4)), calls: usage.calls,
});
