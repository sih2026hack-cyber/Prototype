"""
MiniMax client for the escalated sentiment tier.

Kept behind a narrow interface on purpose. The team's own Technical
Architecture doc argues for Claude over MiniMax on data-sovereignty grounds
for an NTRO-sponsored problem statement; MiniMax is the current choice, but
swapping provider should be a config change and a different `_endpoint`
payload, not a rewrite of the sentiment stage.

Everything that can fail, does, eventually: timeouts, rate limits, truncated
JSON, a model that decides to answer in prose. The contract with the caller is
therefore that this class NEVER raises for an API problem - it returns fewer
results than asked for, and the sentiment stage keeps the VADER answer and
records `sentiment_source = "vader_llm_failed"`.
"""

from __future__ import annotations

import json
import logging
import random
import re
import time
from typing import Any

import requests

from argus_nlp.config import LLMSettings
from argus_nlp.llm.cache import LLMCache, make_key

log = logging.getLogger(__name__)


class LLMConfigError(RuntimeError):
    """Raised for API errors that retrying cannot fix.

    A bad key or an exhausted balance is a setup problem, not a transient
    fault. Swallowing it would degrade every post to "vader_llm_failed" and
    look like a quiet accuracy drop rather than a broken configuration.
    """


# MiniMax application-level statuses that no amount of retrying will fix.
FATAL_API_STATUSES = {
    1004: "authentication failed",
    1008: "insufficient balance",
    2049: "invalid api key",
}

# Bump whenever the prompt below changes - it is part of the cache key, so
# stale answers generated under older instructions are not reused.
PROMPT_VERSION = "v3"

ALLOWED_LABELS = {"positive", "negative", "neutral"}
ALLOWED_EMOTIONS = {
    "sarcasm", "anger", "anxiety", "excitement", "joy", "sadness",
    "fear", "disgust", "hope", "frustration", "gratitude", "confusion",
}

SYSTEM_PROMPT = """You are a sentiment analyst for a social-media monitoring system.

You will receive a numbered list of social-media posts. They may be in any \
language, may mix languages within one post (for example romanised Tamil or \
Hindi written with English), and may use slang, sarcasm or irony.

For EACH post return one object with these fields:
  id        the post's number, exactly as given
  label     one of: positive, negative, neutral
  score     a number from -1.0 (most negative) to 1.0 (most positive)
  emotions  zero or more of: sarcasm, anger, anxiety, excitement, joy, sadness,
            fear, disgust, hope, frustration, gratitude, confusion
  language  the post's dominant language as an ISO 639-1 code, or "mixed"
  rationale one short clause, at most 12 words, saying why

Judge the writer's actual attitude, not the literal words. If a post is \
sarcastic, the label must reflect what is meant, not what is said, and \
"sarcasm" must appear in emotions.

Score only sentiment the writer actually expresses. Do NOT infer feelings \
from the subject matter. These are all NEUTRAL, however pleasant or \
unpleasant the underlying topic:
  - news headlines and announcements ("Company names new chief scientist")
  - factual statements and plans ("On my way to see the new film")
  - questions, links and quoted text carrying no opinion of the writer's own

A post is positive or negative only when the writer reveals their own \
evaluation - through praise, complaint, emotion, intensifiers or tone. \
"Going to the match tonight" is neutral; "Can't wait for the match!" is \
positive. When a post merely reports something, return neutral.

Describing an ordinary activity is not sentiment, however agreeable the \
activity sounds. "with the boyfriend, eating a quesadilla", "got a new pair \
of shoes, pics later" and "spent the day reading" are all NEUTRAL - the \
writer states what happened and offers no view on it. Do not read enjoyment \
into pleasant-sounding subjects, or distress into unpleasant-sounding ones.

Weigh only the writer's own words. A single evaluative word ("love", "awful", \
"brilliant", "hate") makes a post polar; an emotive TOPIC does not.

Reply with a JSON array only. No prose, no markdown fences."""


def _extract_json_array(content: str) -> list[dict[str, Any]] | None:
    """Pull a JSON array out of a model reply that may be wrapped in prose."""
    content = content.strip()
    content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content, flags=re.MULTILINE)
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        # a JSON array embedded in prose
        match = re.search(r"\[.*\]", content, re.DOTALL)
        if match:
            try:
                parsed = json.loads(match.group(0))
            except json.JSONDecodeError:
                return _salvage_objects(content)
        else:
            # no closing bracket at all - truncated, or not an array
            return _salvage_objects(content)
    if isinstance(parsed, dict):
        parsed = [parsed]
    return parsed if isinstance(parsed, list) else None


BAREWORD_VALUE_RE = re.compile(
    r'("(?:label|language)"\s*:\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*(?=[,\}])'
)


def _salvage_objects(content: str) -> list[dict[str, Any]] | None:
    """Recover whatever complete objects the reply does contain.

    Models occasionally emit not-quite-JSON, and one slip should not discard
    the whole batch. Two failures seen in practice, in a single reply:

        "label": neutral,        <- bareword where a string belongs
        ...  }                   <- array never closed, reply just stops

    Strict json.loads rejects both, losing all ten posts over one missing
    quote. So scan for balanced {...} blocks and parse each on its own: a
    truncated tail simply yields fewer objects, and the ones that arrived
    intact are kept. Nothing is invented - a block that still will not parse
    is dropped, and its post keeps the VADER answer.
    """
    content = BAREWORD_VALUE_RE.sub(r'\1"\2"', content)

    objects: list[dict[str, Any]] = []
    depth = 0
    start = -1
    in_string = False
    escaped = False

    for i, ch in enumerate(content):
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start >= 0:
                try:
                    item = json.loads(content[start : i + 1])
                except json.JSONDecodeError:
                    continue
                if isinstance(item, dict):
                    objects.append(item)

    return objects or None


def _clean_item(raw: dict[str, Any]) -> dict[str, Any] | None:
    """Validate one model answer. A malformed item is dropped, not guessed at."""
    label = str(raw.get("label", "")).strip().lower()
    if label not in ALLOWED_LABELS:
        return None
    try:
        score = float(raw.get("score", 0.0))
    except (TypeError, ValueError):
        score = 0.0
    score = max(-1.0, min(1.0, score))

    emotions = raw.get("emotions") or []
    if isinstance(emotions, str):
        emotions = [emotions]
    emotions = [
        e.strip().lower()
        for e in emotions
        if isinstance(e, str) and e.strip().lower() in ALLOWED_EMOTIONS
    ]

    event_polarity = str(raw.get("event_polarity", "")).strip().lower()
    if event_polarity not in ("negative", "positive", "none"):
        event_polarity = None
    try:
        event_severity = max(0.0, min(1.0, float(raw.get("event_severity", 0.0))))
    except (TypeError, ValueError):
        event_severity = 0.0

    rationale = raw.get("rationale")
    return {
        "event_polarity": event_polarity,
        "event_severity": event_severity,
        "label": label,
        "score": score,
        "emotions": emotions,
        "language": str(raw.get("language", "")).strip().lower() or None,
        "rationale": str(rationale).strip()[:200] if rationale else None,
    }


class MiniMaxClient:
    def __init__(self, settings: LLMSettings, cache: LLMCache) -> None:
        self.settings = settings
        self.cache = cache
        self._session = requests.Session()

    # ---- public ----------------------------------------------------------

    def analyse(self, texts: list[str]) -> list[dict[str, Any] | None]:
        """Score `texts`, in order. `None` means no answer for that post.

        Cache hits cost nothing and do not count against the daily cap.
        """
        results: list[dict[str, Any] | None] = [None] * len(texts)
        pending: list[int] = []

        for idx, text in enumerate(texts):
            key = make_key(text, self.settings.model, PROMPT_VERSION)
            hit = self.cache.get(key)
            if hit is not None:
                results[idx] = hit
            else:
                pending.append(idx)

        if not pending:
            return results
        if not self.settings.available:
            log.warning("LLM tier unavailable (no API key or disabled)")
            return results

        size = max(1, self.settings.batch_size)
        for start in range(0, len(pending), size):
            chunk = pending[start : start + size]

            if self.cache.calls_today() >= self.settings.daily_call_cap:
                log.warning(
                    "daily LLM call cap of %d reached - %d posts left unescalated",
                    self.settings.daily_call_cap,
                    len(pending) - start,
                )
                break

            answers = self._call_batch([texts[i] for i in chunk])
            if answers is None:
                continue
            for offset, idx in enumerate(chunk):
                item = answers.get(offset + 1)
                if item is None:
                    continue
                results[idx] = item
                self.cache.set(
                    make_key(texts[idx], self.settings.model, PROMPT_VERSION),
                    self.settings.model,
                    item,
                )

        return results

    # ---- internals -------------------------------------------------------

    def _call_batch(self, texts: list[str]) -> dict[int, dict[str, Any]] | None:
        numbered = "\n".join(
            f"{i + 1}. {t[:1500]}" for i, t in enumerate(texts)
        )
        payload = {
            "model": self.settings.model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": numbered},
            ],
            "temperature": 0.1,
            "max_tokens": self.settings.max_tokens,
        }
        headers = {
            "Authorization": f"Bearer {self.settings.api_key}",
            "Content-Type": "application/json",
        }

        content = self._post_with_retry(payload, headers)
        if content is None:
            return None

        parsed = _extract_json_array(content)
        if parsed is None:
            # Include the reply itself. "unparseable content" on its own gives
            # you nothing to act on - whether the model wrote prose, got cut
            # off mid-array, or answered in a different shape entirely all
            # need different fixes.
            log.warning(
                "LLM returned unparseable content; keeping VADER results. "
                "len=%d start=%.120r end=%.60r",
                len(content), content[:120], content[-60:],
            )
            return None

        out: dict[int, dict[str, Any]] = {}
        for raw in parsed:
            if not isinstance(raw, dict):
                continue
            try:
                item_id = int(raw.get("id"))
            except (TypeError, ValueError):
                continue
            cleaned = _clean_item(raw)
            if cleaned is not None:
                out[item_id] = cleaned
        return out

    def _post_with_retry(self, payload: dict, headers: dict) -> str | None:
        for attempt in range(self.settings.max_retries):
            try:
                self.cache.record_calls(1)
                response = self._session.post(
                    self.settings.base_url,
                    json=payload,
                    headers=headers,
                    timeout=self.settings.timeout_s,
                )
            except requests.RequestException as exc:
                log.warning("LLM request failed (attempt %d): %s", attempt + 1, exc)
                self._sleep(attempt)
                continue

            if response.status_code == 429 or response.status_code >= 500:
                log.warning("LLM HTTP %s (attempt %d)", response.status_code, attempt + 1)
                self._sleep(attempt)
                continue
            if response.status_code != 200:
                log.error("LLM HTTP %s: %s", response.status_code, response.text[:300])
                return None

            try:
                body = response.json()
            except ValueError:
                log.error("LLM returned non-JSON: %s", response.text[:300])
                return None

            # MiniMax signals application errors with HTTP 200 and an error
            # object in the body, so the status code above proves nothing. An
            # invalid key returns 200 + {"base_resp":{"status_code":2049}} and
            # without this check it looked like a malformed response and
            # degraded silently to "vader_llm_failed" on every single post.
            base = body.get("base_resp") or {}
            status = base.get("status_code", 0)
            if status:
                message = base.get("status_msg", "")
                if status in FATAL_API_STATUSES:
                    raise LLMConfigError(f"MiniMax rejected the request ({status}): {message}")
                log.warning("LLM API error %s: %s (attempt %d)",
                            status, message, attempt + 1)
                self._sleep(attempt)
                continue

            try:
                return body["choices"][0]["message"]["content"]
            except (KeyError, IndexError, TypeError) as exc:
                log.warning("unexpected LLM response shape: %s (body=%.200s)", exc, body)
                return None

        return None

    def _sleep(self, attempt: int) -> None:
        """Exponential backoff with jitter, so retries do not synchronise."""
        time.sleep(min(2**attempt + random.uniform(0, 0.5), 20.0))
