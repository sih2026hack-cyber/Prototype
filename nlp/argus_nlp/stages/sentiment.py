"""
SENTIMENT - VADER first pass, explicit escalation rules, MiniMax second pass.

The original flowchart had a decision diamond labelled "Ambiguous / Complex
context?" with nothing behind it. Undefined, that diamond resolves in practice
to either "escalate everything" (which destroys the low-running-cost claim) or
"escalate nothing" (which makes the LLM tier decorative). So the rules are
written out here, each one named, and every decision records WHICH rule fired.

That log is the answer to "how do you keep the cost down?" - it is a measured
escalation rate with reasons attached, not an assertion.

Escalate when any of:

  non_english            VADER is English-only; it cannot score this at all
  code_mixed             romanised or mixed-script text; VADER's lexicon misses it
  low_language_conf      we are not sure enough what language this is
  no_lexicon_match       VADER recognised no sentiment word at all (tunable -
                         this is the main cost dial, see EscalationSettings)
  weak_signal            it found sentiment words but they nearly cancel out
  mixed_polarity         strong positive AND strong negative in one post
  sarcasm_marker         phrasing suggesting the literal reading is wrong
  risk_signals           Module 4 needs an explanation for this one anyway

Never escalate when:

  too short              below a couple of tokens there is nothing to reason about
  empty                  nothing left after cleaning (media-only post)
  cache hit / cap        handled inside the LLM client
"""

from __future__ import annotations

import functools

from argus_nlp.config import EscalationSettings
from argus_nlp.schema import (
    LanguageInfo,
    LexicalFeatures,
    RiskSignals,
    SentimentResult,
    VaderScores,
)
from argus_nlp.stages.lexical import find_sarcasm_markers
from argus_nlp.stages.language import is_english


@functools.lru_cache(maxsize=1)
def _analyzer():
    from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

    return SentimentIntensityAnalyzer()


def label_from_compound(compound: float) -> str:
    """VADER's own documented cut-offs."""
    if compound >= 0.05:
        return "positive"
    if compound <= -0.05:
        return "negative"
    return "neutral"


def score_with_vader(text: str) -> VaderScores:
    raw = _analyzer().polarity_scores(text)
    return VaderScores(
        compound=raw["compound"], pos=raw["pos"], neu=raw["neu"], neg=raw["neg"]
    )


def first_pass_transformer(
    label: str,
    score: float,
    confidence: float,
    language: LanguageInfo,
    lexical: LexicalFeatures,
    risk: RiskSignals,
    settings: EscalationSettings,
) -> SentimentResult:
    """Tier 1 using the fine-tuned transformer instead of VADER.

    The escalation rules differ from VADER's on purpose. `no_lexicon_match`,
    `weak_signal` and `mixed_polarity` are all artefacts of how a lexicon
    works - a transformer has no lexicon to miss, and reading a post with no
    sentiment words is exactly what it is good at. They are replaced by one
    honest signal: the model's own confidence, which is well calibrated
    (59% correct below 0.70, 98% above 0.95).

    The language gate is unchanged. This model is English-only too, so
    non-English and code-mixed posts still go to the LLM.
    """
    result = SentimentResult()

    if lexical.is_empty_after_clean:
        result.source = "skipped_empty"
        result.label = "unavailable"
        return result

    reasons: list[str] = []

    if is_english(language):
        result.label = label if label in ("positive", "negative", "neutral") else "neutral"
        result.score = score
        result.confidence = round(confidence, 4)
        result.source = "transformer"
        if confidence < settings.model_confidence_floor:
            reasons.append("low_model_confidence")
    else:
        result.label = "unavailable"
        result.source = "unavailable"
        if language.primary_lang not in ("en", "und"):
            reasons.append("non_english")
        if language.primary_lang == "und":
            reasons.append("low_language_conf")

    if language.is_code_mixed:
        reasons.append("code_mixed")
    if is_english(language) and language.lang_confidence < settings.min_lang_confidence:
        reasons.append("low_language_conf")
    if risk.has_risk:
        # not about accuracy - the moderator plugin needs an explanation
        reasons.append("risk_signals")

    result.escalation_reasons = sorted(set(reasons))
    result.escalated = bool(result.escalation_reasons)
    return result


def first_pass(
    analysis_text: str,
    language: LanguageInfo,
    lexical: LexicalFeatures,
    risk: RiskSignals,
    settings: EscalationSettings,
) -> SentimentResult:
    """VADER (when the post is English) plus the escalation decision.

    Returns a result that is already usable. `escalated` says whether the
    caller should ask the LLM to overwrite it.
    """
    result = SentimentResult()

    if lexical.is_empty_after_clean or not analysis_text.strip():
        result.source = "skipped_empty"
        result.label = "unavailable"
        return result

    # No confidence floor here on purpose: if the detector's best guess is
    # English, VADER gives a baseline score and low confidence merely adds an
    # escalation reason below. Gating VADER on confidence left 10.7% of an
    # all-English corpus with no score at all.
    english = is_english(language)
    reasons: list[str] = []

    if english:
        vader = score_with_vader(analysis_text)
        result.vader = vader
        result.label = label_from_compound(vader.compound)
        result.score = vader.compound
        result.confidence = round(min(1.0, abs(vader.compound)), 4)
        result.source = "vader"

        # Two different failures wear the same compound score, and they cost
        # very different amounts to chase - so they get separate names.
        found_nothing = vader.neu >= 1.0 and vader.pos == 0.0 and vader.neg == 0.0
        if found_nothing:
            # VADER recognised no sentiment word at all. Could be a genuinely
            # factual post, or one that is negative in meaning but uses no word
            # in the lexicon. Escalating is the only way to tell them apart.
            if settings.escalate_no_lexicon_match:
                reasons.append("no_lexicon_match")
        elif abs(vader.compound) < settings.weak_compound:
            # It found sentiment words but they nearly cancel - real ambiguity.
            reasons.append("weak_signal")

        if vader.pos > settings.mixed_polarity and vader.neg > settings.mixed_polarity:
            reasons.append("mixed_polarity")
    else:
        # No score at all rather than a fabricated neutral. This is the whole
        # point of gating VADER on language.
        result.label = "unavailable"
        result.score = 0.0
        result.confidence = 0.0
        result.source = "unavailable"

        if language.primary_lang not in ("en", "und"):
            reasons.append("non_english")
        if language.primary_lang == "und":
            reasons.append("low_language_conf")

    if language.is_code_mixed:
        reasons.append("code_mixed")
    if english and language.lang_confidence < settings.min_lang_confidence:
        reasons.append("low_language_conf")
    if find_sarcasm_markers(analysis_text):
        reasons.append("sarcasm_marker")
    if risk.has_risk:
        reasons.append("risk_signals")
    if lexical.question_count and settings.escalate_questions:
        # A question can contain a strong sentiment word while expressing no
        # sentiment at all - "need a GOOD filter, got some?", "Harvard versus
        # Stanford - who WINS?". VADER matches the word, scores it confidently
        # positive, and so never escalates. Measured on the Sentiment140 test
        # set: of the 15 question posts VADER kept, it got 6 right and the LLM
        # gets 13 - a net +7 for 8% more escalation.
        reasons.append("question")

    # too little text to reason about - do not spend a call on it
    token_estimate = len(analysis_text.split())
    if token_estimate < settings.min_tokens:
        result.escalated = False
        result.escalation_reasons = []
        return result

    result.escalation_reasons = sorted(set(reasons))
    result.escalated = bool(result.escalation_reasons)
    return result


def apply_llm(result: SentimentResult, answer: dict | None) -> SentimentResult:
    """Merge an LLM answer into a first-pass result.

    A missing answer is not an error state to crash on - it means we keep what
    VADER said (or keep "unavailable" for a non-English post) and record that
    the escalation was attempted and failed, so the dashboard can be honest
    about coverage.
    """
    if not result.escalated:
        return result

    if answer is None:
        if result.source == "vader":
            result.source = "vader_llm_failed"
        elif result.source == "transformer":
            result.source = "transformer_llm_failed"
        else:
            result.source = "unavailable"
            result.label = "unavailable"
            result.confidence = 0.0
        return result

    result.label = answer["label"]
    result.score = float(answer["score"])
    result.emotions = list(answer.get("emotions") or [])
    result.llm_rationale = answer.get("rationale")
    result.source = "minimax"
    # the LLM saw context VADER could not; treat it as the stronger signal,
    # but do not claim certainty it never expressed
    result.confidence = round(min(1.0, 0.6 + abs(result.score) * 0.4), 4)
    return result
