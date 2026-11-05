// The moderator engine. One call — moderate(text) — and one rule for the host app:
// post the comment only when `allowed` is true.
//
//   clean       → allowed. Post it.
//   rude        → not allowed. Plain reason + a suggested rewrite (already checked).
//   severe      → not allowed. An explanation of what is wrong and why; the writer
//                 rewrites it themselves (no AI rewrite of threats or hate).
//   unsure      → not allowed yet. A non-English comment the model can't read with
//                 confidence goes to a person instead of being guessed at.
//   unavailable → not allowed. The check could not run, so nothing is posted (fail closed).
import { createNemotron, parseJson } from './nemotron.mjs';
import { sameScript } from './lang.mjs';
import { MEANING_CHECK_PROMPT, REWRITE_PROMPT, SCORING_PROMPT } from './prompts.mjs';

const UNAVAILABLE = "We couldn't check this comment right now, so it hasn't been posted. Please try again in a moment.";
// A short, plain name for what's wrong, shown to the writer above the reason.
const LABELS = {
  insult: 'Personal attack',
  harassment: 'Harassment',
  threat: 'Threat',
  hate: 'Hate speech',
  sexual: 'Unwanted sexual content',
  self_harm: 'Encourages self-harm',
  spam: 'Spam',
};
export function labelFor(verdict, category) {
  if (verdict === 'clean' || verdict === 'unsure' || verdict === 'unavailable') return null;
  return LABELS[category] || (verdict === 'severe' ? 'Harmful' : 'Rude');
}

const UNSURE = "We couldn't be sure what this means, so a person will check it. It will be posted if they approve it.";

// Masks emails, 12-digit IDs and phone numbers before text leaves the server.
export function redact(text) {
  return String(text || '').replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[EMAIL]')
    .replace(/\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, '[ID]')
    .replace(/(?<!\w)\+?\d[\d ()-]{8,}\d(?!\w)/g, '[PHONE]');
}

// Instant typing hint (no network). It never allows anything — only the AI check
// decides — but it can make a verdict stricter: a direct threat it recognises is
// never let through by an optimistic model answer.
export function inspectDraft(input) {
  const text = String(input).normalize('NFKC').replace(/[’‘]/g, "'").replace(/[​-‍﻿]/g, '');
  const direct = /\b(?:i|we)\s+(?:will|shall|would|might|want to|plan to|am going to|are going to|am gonna|are gonna|gonna)\s+(?:(?:fucking|really|just)\s+)?(?:kill|murder|shoot|stab|hurt|attack|beat up)\s+(?:you|u|him|her|them|someone|people|everyone)\b/i;
  const contracted = /\b(?:i'll|we'll|ill)\s+(?:kill|shoot|stab|hurt|murder|end)\s+(?:you|u|him|her|them|someone|everyone)\b/i;
  const quoted = /["“][^"”]*\b(?:kill|shoot|stab|hurt|murder)\b[^"”]*["”]/i;
  const negated = /\b(?:not|never|won't|wouldn't|don't|do not|will not)\b[^.!?;]{0,25}\b(?:kill|shoot|stab|hurt|murder)\b/i;
  // Common "I'll kill you" phrasings in Tamil, Tanglish, Hindi and Hinglish — the model's
  // reading of these languages is less reliable, so the code backs it up (escalation only).
  const indic = /(?:கொன்னுடுவேன்|கொன்னுருவேன்|கொல்லுவேன்|கொன்றுவிடுவேன்|கொல்லப்போறேன்|konnuduven|konnuruven|kolluven|kolla\s*poren|kondruven|मार\s*(?:दूंगा|डालूंगा|दूँगा)|जान\s*से\s*मार|maar\s*(?:dunga|daalunga|dalunga)|jaan\s*se\s*maar)/i;
  const threat = text.match(direct) || text.match(contracted) || text.match(indic);
  if (threat && !quoted.test(text) && !negated.test(text)) {
    return { hint: 'threat', message: 'This reads as a threat to hurt someone.' };
  }
  if (/\b(?:kill|murder|shoot|stab|rape|bomb|kys)\b/i.test(text) || /\b(?:idiot|stupid|moron|loser|shut up|hate you)\b/i.test(text)) {
    return { hint: 'check', message: 'This might come across as hostile. It will be checked when you post.' };
  }
  return { hint: null, message: null };
}

/**
 * options.call       async (messages, maxTokens) => string. Defaults to Nemotron on Token Factory.
 * options.apiKey / baseUrl / model / timeoutMs   passed to the default Nemotron client.
 * options.cleanMax   scores below this post (default 0.40).
 * options.severeMin  scores at or above this are severe (default 0.85).
 * options.unsureMin  a NON-English comment scoring from here up to cleanMax is too close to
 *                    call, so a person decides instead of the model's guess (default 0.25).
 */
export function createModerator({ call, cleanMax = 0.4, severeMin = 0.85, unsureMin = 0.25, ...nemotron } = {}) {
  const ask = call || createNemotron(nemotron);

  async function json(system, user, maxTokens) {
    return parseJson(await ask([{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens));
  }

  // The model's verdict on the words alone: { score, category, reason, meaning, unsure }.
  async function score(text) {
    let out = await json(SCORING_PROMPT, text, 500);
    // The reason is shown to the writer, so it must be in their language. One retry.
    if (typeof out.reason === 'string' && !sameScript(text, out.reason)) {
      try {
        const retry = await json(SCORING_PROMPT, `${text}\n\n(Write the "reason" in the exact language and script of the comment above.)`, 500);
        if (typeof retry.reason === 'string' && sameScript(text, retry.reason)) out = retry;
      } catch { /* keep the first verdict */ }
    }
    if (!Number.isFinite(out.score)) throw new Error('The model returned no usable score.');
    return {
      score: Math.min(1, Math.max(0, out.score)),
      category: typeof out.category === 'string' ? out.category : 'other',
      reason: typeof out.reason === 'string' && out.reason.trim() ? out.reason.trim() : 'This comment was flagged by the safety check.',
      // The model's English reading of a non-English comment ('' for English).
      meaning: typeof out.meaning === 'string' ? out.meaning.trim() : '',
      // Only non-English comments can be unsure; an English one is always read as written.
      unsure: out.sure === false && typeof out.meaning === 'string' && out.meaning.trim() !== '',
      // Swearing or vulgarity, harmful or not. Never changes the verdict; a suggestion must not have it.
      coarse: out.coarse === true,
    };
  }

  // Does the rewrite still say what the writer meant? A quality gate, so it fails open.
  async function keepsMeaning(text, rewrite, context) {
    try {
      const out = await json(MEANING_CHECK_PROMPT, `${context}Original comment: ${text}\nProposed rewrite: ${rewrite}`, 60);
      return out.faithful !== false;
    } catch { return true; }
  }

  // A suggestion is offered only if it is in the writer's script, keeps their
  // meaning, and itself scores clean with no swearing. Two attempts; otherwise null (the writer
  // still gets the reason, and can edit).
  // meaning: the scorer's English reading of the comment ('' when it is English).
  async function suggest(text, reason, replyingTo, meaning = '') {
    const context = replyingTo ? `Post being replied to: ${String(replyingTo).trim().slice(0, 300)}\n` : '';
    let feedback = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      let rewrite;
      try {
        const out = await json(REWRITE_PROMPT, `${context}Comment: ${text}\nIt was flagged for: ${reason}${feedback}`, 300);
        rewrite = typeof out.rewrite === 'string' ? out.rewrite.trim() : '';
      } catch { continue; }
      if (!rewrite || rewrite === text) continue;
      let why = null;
      if (!sameScript(text, rewrite)) why = 'it was in a different language than the original comment';
      else if (!(await keepsMeaning(text, rewrite, context))) why = 'it changed what the author was saying';
      else {
        const check = await score(rewrite).catch(() => null);
        if (!check) continue;
        // Same alphabet isn't enough: Tanglish in, English out is still the wrong language.
        // The scorer reads English with an empty "meaning", so that tells us.
        const wrongLanguage = meaning !== '' && check.meaning === '';
        if (check.score < cleanMax && !check.coarse && !wrongLanguage) return rewrite;
        why = check.score >= cleanMax ? check.reason
          : wrongLanguage ? 'it was in English, but the comment was not — write it in the same language as the comment, typed the same way'
          : 'it still had swear words or crude language in it';
      }
      feedback = `\nYour previous rewrite was: ${rewrite}\nIt was rejected because: ${why}\nTry again — the author's point, minus the abuse, in the exact language and script of the original.`;
    }
    return null;
  }

  /**
   * moderate(text, { replyingTo, suggest }) → { allowed, verdict, score, category, reason, suggestion }
   * replyingTo: the post being replied to. It only shapes the suggestion — the verdict
   * is always judged on the comment's own words.
   * suggest: false skips the rewrite (verdict only — used by the eval).
   */
  async function moderate(text, { replyingTo, suggest: wantSuggestion = true } = {}) {
    const original = redact(String(text || '').trim());
    if (!original) return { allowed: false, verdict: 'unavailable', score: null, category: null, reason: 'Write something first.', suggestion: null };

    let scored;
    try { scored = await score(original); }
    catch { return { allowed: false, verdict: 'unavailable', score: null, category: null, reason: UNAVAILABLE, suggestion: null }; }

    // The typing hint can only make things stricter, never looser.
    if (inspectDraft(original).hint === 'threat' && scored.score < severeMin) {
      scored = { score: severeMin, category: 'threat', reason: 'This reads as a threat to hurt someone, whatever you meant by it. It can\'t be posted.' };
    }

    const base = { score: scored.score, category: scored.category, reason: scored.reason, meaning: scored.meaning ?? '' };
    const label = (verdict) => labelFor(verdict, scored.category);
    if (scored.score >= severeMin) return { allowed: false, verdict: 'severe', ...base, label: label('severe'), suggestion: null };
    // Can't read it with confidence: don't guess either way — a person decides. Models rarely
    // admit doubt, so a non-English comment just under the line counts as unsure too.
    const borderline = scored.meaning !== '' && scored.score >= unsureMin && scored.score < cleanMax;
    if (scored.unsure || borderline) return { allowed: false, verdict: 'unsure', ...base, reason: UNSURE, suggestion: null };
    if (scored.score < cleanMax) return { allowed: true, verdict: 'clean', ...base, suggestion: null };
    // Rude: a failed suggestion never discards the verdict.
    const suggestion = wantSuggestion ? await suggest(original, scored.reason, replyingTo, scored.meaning).catch(() => null) : null;
    return { allowed: false, verdict: 'rude', ...base, label: label('rude'), suggestion };
  }

  return { moderate, score, inspectDraft };
}
