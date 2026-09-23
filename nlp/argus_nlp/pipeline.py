"""
PIPELINE - the orchestrator Module 5 exposes to the rest of ARGUS.

Stage order matters and is not the order the original flowchart had:

  0 ingest      post metadata is carried through every stage; the dashboard's
                trends-over-time and the network module are useless without it
  1 guard       PII redaction, content hash, duplicate + media-only checks
  2 lexical     regex extraction WITH OFFSETS, over the original text
  3 variants    mask those offsets -> analysis_text and nlp_text
  4 language    detect, so VADER and en_core_web_sm can be gated
  5 nlp         spaCy, routed by language, batched
  6 sentiment   VADER -> escalation rules -> MiniMax
  7 assemble    versioned NLPResult

Extraction runs BEFORE cleaning (step 2 before step 3), which is the reverse
of the original diagram. Cleaning first means extracting from already-mangled
text and losing the offsets that make precise masking possible.

Batch processing is the real entry point: `process_batch` groups the spaCy and
LLM work so each model and each API call is used once for many posts.
"""

from __future__ import annotations

import logging
import time
from typing import Iterable

from argus_nlp.config import Settings, get_settings
from argus_nlp.llm.cache import LLMCache
from argus_nlp.llm.client import MiniMaxClient
from argus_nlp.schema import SCHEMA_VERSION, NLPResult, PostInput
from argus_nlp.stages import (
    event_signal,
    guard,
    language,
    lexical,
    nlp_core,
    sentiment,
    transformer_sentiment,
    variants,
)

log = logging.getLogger(__name__)


class Pipeline:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.duplicates = guard.DuplicateRegistry()

        self._cache: LLMCache | None = None
        self._llm: MiniMaxClient | None = None

    # ---- lazily built so the pipeline works with no API key at all -------

    @property
    def llm(self) -> MiniMaxClient | None:
        if not self.settings.llm.available:
            return None
        if self._llm is None:
            self._cache = LLMCache(self.settings.cache_path)
            self._llm = MiniMaxClient(self.settings.llm, self._cache)
        return self._llm

    # ---- public ----------------------------------------------------------

    def process(self, post: PostInput) -> NLPResult:
        return self.process_batch([post])[0]

    def process_batch(self, posts: Iterable[PostInput]) -> list[NLPResult]:
        posts = list(posts)
        if not posts:
            return []

        started = time.perf_counter()
        results = [self._stages_before_nlp(p) for p in posts]

        self._run_nlp(results)
        self._run_sentiment(results)

        total_ms = (time.perf_counter() - started) * 1000
        per_post = round(total_ms / len(results), 3)
        for result in results:
            result.timings_ms["batch_total_per_post"] = per_post
        return results

    # ---- stages 1-4 (per post, all cheap) --------------------------------

    def _stages_before_nlp(self, post: PostInput) -> NLPResult:
        t0 = time.perf_counter()
        errors: list[str] = []

        text = post.original_text or ""
        pii_flags = None
        if self.settings.redact_pii:
            text, pii_flags = guard.redact_pii(text)

        digest = guard.content_hash(text)
        is_dup = self.duplicates.check_and_add(digest)

        feats = lexical.extract(text)
        risk = lexical.assess_risk(text, feats)
        # runs on EVERY post, not just escalated ones - only ~22% reach the
        # LLM, so an LLM-only event signal would leave the dashboard blank
        # for four fifths of the corpus
        event = event_signal.detect(text)
        analysis_text, nlp_text = variants.build(text, feats)
        # detect on nlp_text: hashtags are segmented into real words there, which
        # materially improves detection on hashtag-heavy posts
        lang = language.detect(nlp_text or analysis_text)

        result = NLPResult(
            schema_version=SCHEMA_VERSION,
            post_id=post.post_id,
            source=post.source,
            author_ref_hash=guard.hash_author(post.author_ref, self.settings.hash_salt),
            timestamp=post.timestamp,
            parent_id=post.parent_id,
            original_text=text,
            analysis_text=analysis_text,
            nlp_text=nlp_text,
            content_hash=digest,
            is_duplicate=is_dup,
            language=lang,
            lexical=feats,
            risk=risk,
            event=event,
            nlp=nlp_core.NLPFeatures(),
            errors=errors,
        )
        if pii_flags is not None:
            result.pii = pii_flags
        result.model_versions = {
            "schema": SCHEMA_VERSION,
            "vader": "vaderSentiment-3.3.2",
            "llm": self.settings.llm.model if self.settings.llm.available else "disabled",
        }
        result.timings_ms["lexical_stages"] = round(
            (time.perf_counter() - t0) * 1000, 3
        )
        return result

    # ---- stage 5 ---------------------------------------------------------

    def _run_nlp(self, results: list[NLPResult]) -> None:
        t0 = time.perf_counter()
        texts = [r.nlp_text for r in results]
        langs = [r.language.primary_lang for r in results]
        try:
            features = nlp_core.process_many(texts, langs)
        except Exception as exc:                        # a model failure must not
            log.exception("spaCy stage failed")         # take the whole batch down
            for r in results:
                r.errors.append(f"nlp_stage_failed: {exc}")
            return

        for result, feats in zip(results, features):
            result.nlp = feats
            if feats.spacy_model:
                result.model_versions["spacy"] = feats.spacy_model
            # hashtag words are real topic signal; make them visible as lemmas
            for word in result.lexical.hashtag_words:
                if word not in feats.lemmas:
                    feats.lemmas.append(word)

        elapsed = round((time.perf_counter() - t0) * 1000 / max(len(results), 1), 3)
        for result in results:
            result.timings_ms["nlp"] = elapsed

    # ---- stage 6 ---------------------------------------------------------

    def _run_sentiment(self, results: list[NLPResult]) -> None:
        t0 = time.perf_counter()
        esc = self.settings.escalation

        # Tier 1: the transformer when it is available, VADER otherwise. The
        # fallback is silent by design - a teammate without torch or the
        # weights still gets a working pipeline, just a less accurate one, and
        # `sentiment.source` on every row records which one actually answered.
        scores = []
        if self.settings.use_transformer_tier1:
            scorer = transformer_sentiment.get_scorer(self.settings.transformer_model)
            scores = scorer.score_batch([r.analysis_text for r in results])

        if len(scores) == len(results):
            for result, (label, score, confidence) in zip(results, scores):
                result.sentiment = sentiment.first_pass_transformer(
                    label, score, confidence,
                    result.language, result.lexical, result.risk, esc,
                )
            self._tier1 = "transformer"
        else:
            for result in results:
                result.sentiment = sentiment.first_pass(
                    result.analysis_text, result.language,
                    result.lexical, result.risk, esc,
                )
            self._tier1 = "vader"

        pending = [r for r in results if r.sentiment.escalated]
        if pending:
            client = self.llm
            if client is None:
                # degrade honestly: English keeps its VADER score, non-English
                # is reported as unavailable rather than given a fake neutral
                for result in pending:
                    sentiment.apply_llm(result.sentiment, None)
            else:
                answers = client.analyse([r.analysis_text for r in pending])
                for result, answer in zip(pending, answers):
                    sentiment.apply_llm(result.sentiment, answer)
                    event_signal.apply_llm(result.event, answer)

        elapsed = round((time.perf_counter() - t0) * 1000 / max(len(results), 1), 3)
        for result in results:
            result.timings_ms["sentiment"] = elapsed

    # ---- reporting -------------------------------------------------------

    def escalation_report(self, results: list[NLPResult]) -> dict:
        """Escalation rate with reasons - the cost story, measured."""
        total = len(results) or 1
        escalated = [r for r in results if r.sentiment.escalated]
        reasons: dict[str, int] = {}
        for result in escalated:
            for reason in result.sentiment.escalation_reasons:
                reasons[reason] = reasons.get(reason, 0) + 1
        sources: dict[str, int] = {}
        for result in results:
            sources[result.sentiment.source] = sources.get(result.sentiment.source, 0) + 1
        return {
            "posts": len(results),
            "escalated": len(escalated),
            "escalation_rate": round(len(escalated) / total, 4),
            "reasons": dict(sorted(reasons.items(), key=lambda kv: -kv[1])),
            "sentiment_sources": sources,
            "duplicates": sum(1 for r in results if r.is_duplicate),
        }

    def close(self) -> None:
        if self._cache is not None:
            self._cache.close()
