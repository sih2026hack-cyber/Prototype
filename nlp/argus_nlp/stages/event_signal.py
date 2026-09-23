"""
EVENT POLARITY - a different question from sentiment.

Sentiment asks "how does the writer feel?". After the prompt was tuned to
score factual reporting as neutral - which is correct, and worth ~6 points on
the benchmark - this happened:

    "Heavy flooding in Thoothukudi. NDRF teams deployed to the area."
        sentiment: neutral   ("factual report, no personal opinion")

The sentiment label is right. The writer really is just reporting. But ARGUS
exists to surface exactly this post, and a dashboard filtering on negative
sentiment would never show it. Two different questions had been crammed into
one field:

    sentiment       what the writer feels        -> neutral, correctly
    event_polarity  is something bad happening   -> yes, severely

So they are separated. `sentiment` stays the writer's attitude and keeps its
measured accuracy; `event_polarity` is what the trends and alerting views
filter on.

This runs LEXICALLY on every post, not through the LLM. Two reasons, both
measured. Only ~22% of posts escalate, so an LLM-only signal would leave four
fifths of the corpus blank - useless for a dashboard. And asking the sentiment
call to judge event polarity as well cost 3 points on the escalated tier
(83.9% -> 80.9%): the model does both jobs less well than either alone, and
the keyword pass had already flagged the motivating example at 0.85 against
the LLM's 0.90.

`apply_llm` below is wired up for the day that trade changes, but is dormant -
the prompt does not currently request event fields.

Every match is reported by name. "flood" and "ndrf" are auditable evidence for
why a post was flagged; a bare severity score is not.
"""

from __future__ import annotations

import functools
import json
import re

from argus_nlp.config import RESOURCES
from argus_nlp.schema import EventSignal

# Below this the signal is one weak keyword and not worth acting on.
MIN_SEVERITY = 0.25


@functools.lru_cache(maxsize=1)
def _lexicon() -> dict:
    path = RESOURCES / "event_lexicon.json"
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


@functools.lru_cache(maxsize=1)
def _compiled() -> dict:
    """{polarity: [(category, weight, compiled_pattern, terms)]}.

    Terms are compiled once into a single alternation per category. Doing it
    per post over ~200 terms was the slowest thing in the lexical stage.
    """
    out: dict[str, list] = {}
    for polarity, categories in _lexicon().items():
        if polarity.startswith("_"):
            continue
        entries = []
        for category, spec in categories.items():
            terms = sorted(spec["terms"], key=len, reverse=True)
            pattern = re.compile(
                r"(?<![a-z])(" + "|".join(re.escape(t) for t in terms) + r")(?![a-z])"
            )
            entries.append((category, float(spec["weight"]), pattern))
        out[polarity] = entries
    return out


def detect(text: str) -> EventSignal:
    """Is this post about something happening, good or bad?

    Severity is the strongest category weight present, nudged up when several
    categories co-occur - "flooding" plus "dead" is worse than either alone -
    but never allowed to exceed the strongest single signal by much, because
    keyword counting is not evidence of scale.
    """
    signal = EventSignal()
    if not text:
        return signal

    lowered = " " + text.lower() + " "
    scores: dict[str, float] = {}
    matched: dict[str, list[str]] = {}

    for polarity, entries in _compiled().items():
        best = 0.0
        for category, weight, pattern in entries:
            found = sorted({m.group(1) for m in pattern.finditer(lowered)})
            if not found:
                continue
            matched.setdefault(polarity, []).extend(found)
            signal.categories.append(category)
            best = max(best, weight)
        if best:
            # each extra category beyond the first adds a little, capped
            extra = max(0, len(set(signal.categories)) - 1) * 0.05
            scores[polarity] = min(1.0, best + extra)

    if not scores:
        return signal

    polarity = max(scores, key=lambda k: scores[k])
    severity = scores[polarity]

    # Mixed evidence: "rescued" alongside "flooding" is still a negative event
    # being reported, so negative wins ties and near-ties.
    if "negative" in scores and scores["negative"] >= severity - 0.1:
        polarity = "negative"
        severity = scores["negative"]

    if severity < MIN_SEVERITY:
        return signal

    signal.polarity = polarity
    signal.severity = round(severity, 4)
    signal.matched_terms = sorted(set(matched.get(polarity, [])))[:12]
    signal.categories = sorted(set(signal.categories))
    signal.source = "lexical"
    return signal


def apply_llm(signal: EventSignal, answer: dict | None) -> EventSignal:
    """Let the LLM's reading override the keyword pass, when there is one.

    Wired up but dormant by default: the sentiment prompt no longer ASKS for
    event fields, so `answer` never carries them and this is a no-op.

    That was a measured decision. Asking one call to judge sentiment and event
    polarity together cost 3 points on the escalated tier (83.9% -> 80.9%) and
    0.7 overall, because the model does both jobs less well than either alone.
    The keyword pass had already flagged the motivating example at 0.85 against
    the LLM's 0.90 - so the refinement bought almost nothing, on the 22% of
    posts that escalate, for a loss across all 100%.

    Kept because it is the right shape if the trade ever changes: add the
    fields back to the prompt (and bump PROMPT_VERSION) and this starts
    working, with no other edits.
    """
    if not answer:
        return signal
    polarity = str(answer.get("event_polarity", "")).strip().lower()
    if polarity not in ("negative", "positive", "none"):
        return signal
    signal.polarity = polarity
    try:
        signal.severity = round(max(0.0, min(1.0, float(answer.get("event_severity", 0)))), 4)
    except (TypeError, ValueError):
        pass
    signal.source = "llm"
    return signal
