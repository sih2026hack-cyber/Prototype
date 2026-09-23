"""
TIER 1: a fine-tuned transformer, with VADER as the fallback.

VADER is a hand-built lexicon from 2014. `twitter-roberta-base-sentiment-latest`
is RoBERTa fine-tuned on ~124M tweets for exactly this 3-class task. Measured
on the 498-post human-annotated Sentiment140 set:

    tier 1 alone                      escalation   overall
    VADER                    72.1%          60%      86.1%
    roberta                  86.6%          11%      88.5%

Two wins at once. roberta is not just more accurate - it is more accurate
*and* right far more often, so the expensive tier is needed on 11% of posts
instead of 60%.

Its confidence is also well calibrated, which is what makes that possible:

    confidence      n     correct
    0.50 - 0.70    74        59%
    0.70 - 0.85   107        85%
    0.85 - 0.95   180        93%
    0.95 +        121        98%

So "escalate below 0.60" reliably picks out the posts it is guessing on.

IMPORTANT: this model is English-only, exactly like VADER. It does not read
Tanglish or Hindi. Non-English and code-mixed posts still route to the LLM -
the language gate in `sentiment.py` is unchanged and still does that work.

Loading is lazy and failure is non-fatal: if torch, transformers or the model
weights are missing, `available` is False and the pipeline falls back to VADER
rather than refusing to run. A teammate without a 500MB download still gets a
working pipeline, just a less accurate one.
"""

from __future__ import annotations

import logging
import os
import threading

from argus_nlp.schema import SentimentLabel

log = logging.getLogger(__name__)

DEFAULT_MODEL = "cardiffnlp/twitter-roberta-base-sentiment-latest"

# Below this confidence the model is guessing - measured at 59% correct in
# 0.50-0.70 against 93%+ above 0.85. Split-half validated: one half of the
# data peaks at 0.60 and the other at 0.80, so the exact value is noise, but
# everything in 0.60-0.80 beat both "never escalate" and "always escalate".
# 0.60 is the cheapest of them, at 11% escalation.
DEFAULT_CONFIDENCE_FLOOR = 0.60

_MAX_TOKENS = 128


class TransformerScorer:
    """Batched 3-class sentiment. Thread-safe lazy load, degrades to unavailable."""

    def __init__(self, model_name: str = DEFAULT_MODEL, batch_size: int = 32) -> None:
        self.model_name = model_name
        self.batch_size = batch_size
        self._lock = threading.Lock()
        self._loaded = False
        self._broken = False
        self._tok = None
        self._model = None
        self._id2label: dict[int, str] = {}

    # ---- loading ---------------------------------------------------------

    def _load(self) -> None:
        if self._loaded or self._broken:
            return
        with self._lock:
            if self._loaded or self._broken:
                return
            try:
                import torch
                from transformers import (
                    AutoModelForSequenceClassification,
                    AutoTokenizer,
                )
            except ImportError as exc:
                log.warning(
                    "transformer tier unavailable (%s); falling back to VADER. "
                    "pip install torch transformers to enable it.", exc
                )
                self._broken = True
                return

            try:
                self._tok = AutoTokenizer.from_pretrained(self.model_name)
                self._model = AutoModelForSequenceClassification.from_pretrained(
                    self.model_name
                )
                self._model.eval()
            except Exception as exc:                       # network, disk, corrupt cache
                log.warning(
                    "could not load %s (%s); falling back to VADER",
                    self.model_name, exc
                )
                self._broken = True
                return

            self._torch = torch
            self._id2label = {
                i: str(l).lower() for i, l in self._model.config.id2label.items()
            }
            self._loaded = True
            log.info("transformer tier ready: %s", self.model_name)

    @property
    def available(self) -> bool:
        self._load()
        return self._loaded

    # ---- scoring ---------------------------------------------------------

    def score_batch(self, texts: list[str]) -> list[tuple[SentimentLabel, float, float]]:
        """(label, signed score in -1..1, confidence in 0..1) per text.

        Returns an empty list if the model is unavailable, so the caller can
        fall back without having to ask first.
        """
        if not texts or not self.available:
            return []

        torch = self._torch
        out: list[tuple[SentimentLabel, float, float]] = []
        with torch.no_grad():
            for start in range(0, len(texts), self.batch_size):
                chunk = texts[start : start + self.batch_size]
                encoded = self._tok(
                    chunk, return_tensors="pt", padding=True,
                    truncation=True, max_length=_MAX_TOKENS,
                )
                probs = torch.softmax(self._model(**encoded).logits, dim=-1)
                for row in probs:
                    best = int(row.argmax())
                    label = self._id2label.get(best, "neutral")
                    confidence = float(row[best])
                    out.append((label, _signed_score(self._id2label, row), confidence))
        return out


def _signed_score(id2label: dict[int, str], row) -> float:
    """Collapse the 3-way distribution to one -1..1 number.

    P(positive) - P(negative), so it stays comparable with VADER's compound
    and with the LLM's score. Everything downstream - the dashboard, the
    trend charts - reads one scale, not three.
    """
    score = 0.0
    for idx, label in id2label.items():
        value = float(row[idx])
        if label.startswith("pos"):
            score += value
        elif label.startswith("neg"):
            score -= value
    return round(max(-1.0, min(1.0, score)), 4)


class HostedTransformerScorer:
    """The same RoBERTa model served by the Hugging Face Inference API.

    Used where torch cannot run (e.g. a 512 MB Render instance). Returns the same
    (label, signed score, confidence) triples, so escalation to the LLM is unchanged.
    Any API failure returns [] and the pipeline falls back to VADER, as before.
    """

    def __init__(self, model_name: str = DEFAULT_MODEL, token: str = "", batch_size: int = 16) -> None:
        self.model_name = model_name
        self.token = token
        self.batch_size = batch_size
        self.url = os.environ.get("HF_INFERENCE_URL", "https://router.huggingface.co/hf-inference/models/") + model_name

    @property
    def available(self) -> bool:
        return bool(self.token)

    def score_batch(self, texts: list[str]) -> list[tuple[SentimentLabel, float, float]]:
        if not texts or not self.available:
            return []
        out: list[tuple[SentimentLabel, float, float]] = []
        try:
            import requests
            for start in range(0, len(texts), self.batch_size):
                chunk = [t[:1000] for t in texts[start : start + self.batch_size]]
                response = requests.post(
                    self.url, timeout=60,
                    headers={"Authorization": f"Bearer {self.token}"},
                    json={"inputs": chunk, "parameters": {"top_k": 3, "truncation": True}, "options": {"wait_for_model": True}},
                )
                response.raise_for_status()
                rows = response.json()
                if len(chunk) == 1 and rows and isinstance(rows[0], dict):
                    rows = [rows]
                if len(rows) != len(chunk):
                    raise ValueError("unexpected response shape")
                for row in rows:
                    probs = {str(item["label"]).lower(): float(item["score"]) for item in row}
                    label = max(probs, key=probs.get)
                    score = round(max(-1.0, min(1.0, probs.get("positive", 0.0) - probs.get("negative", 0.0))), 4)
                    out.append((label, score, probs[label]))
        except Exception as exc:                            # network, quota, cold start
            log.warning("hosted transformer tier failed (%s); falling back to VADER", exc)
            return []
        return out


_scorer = None


def get_scorer(model_name: str = DEFAULT_MODEL):
    """Process-wide singleton - loading 500MB of weights per batch is not free.

    ARGUS_SENTIMENT_BACKEND: "local" (torch), "hf" (Inference API) or "auto" (default):
    local when torch loads, otherwise the Inference API when HF_TOKEN is set.
    """
    global _scorer
    if _scorer is None or _scorer.model_name != model_name:
        backend = os.environ.get("ARGUS_SENTIMENT_BACKEND", "auto").lower()
        token = os.environ.get("HF_TOKEN", "")
        local = TransformerScorer(model_name) if backend != "hf" else None
        if local is not None and (backend == "local" or local.available or not token):
            _scorer = local
        else:
            _scorer = HostedTransformerScorer(model_name, token)
    return _scorer


def reset_scorer() -> None:
    """Test hook."""
    global _scorer
    _scorer = None
