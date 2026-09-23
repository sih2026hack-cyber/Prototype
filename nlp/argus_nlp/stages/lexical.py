"""
LEXICAL LAYER - surface and statistical features. No models, no network.

This runs on `original_text` and records character offsets for everything it
extracts, so the variant builder can mask exactly these spans rather than
re-running regexes over already-modified text.

Everything here is a pure function and runs in microseconds, which is why
Module 4 (the moderator plugin) can call it synchronously for instant
feedback while the heavier NLP layer runs asynchronously.
"""

from __future__ import annotations

import functools
import json
import re

import emoji as emoji_lib

from argus_nlp.config import RESOURCES
from argus_nlp.schema import LexicalFeatures, RiskSignals, Span

# --------------------------------------------------------------------------
# patterns
# --------------------------------------------------------------------------

# URLs first - they contain '#' and '@' and would otherwise be shredded by the
# hashtag/mention patterns. Extraction order in extract() depends on this.
URL_RE = re.compile(r"https?://\S+|www\.\S+", re.IGNORECASE)
MENTION_RE = re.compile(r"@[A-Za-z0-9_]{2,30}\b")
HASHTAG_RE = re.compile(r"#[A-Za-z0-9_]+")
NUMBER_RE = re.compile(r"\b\d[\d,\.]*\b")
REPEATED_PUNCT_RE = re.compile(r"([!?.])\1{1,}")
ELONGATION_RE = re.compile(r"([A-Za-z])\1{2,}")

# hashtag segmentation helpers
CAMEL_SPLIT_RE = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")
NON_ALNUM_RE = re.compile(r"[^A-Za-z0-9]+")

# eye-roll / upside-down / angry / unamused faces - classic sarcasm carriers
NEGATIVE_FACE_RE = re.compile("[\U0001f644\U0001f643\U0001f621\U0001f620\U0001f612]")
POSITIVE_WORD_RE = re.compile(
    r"\b(great|nice|wonderful|perfect|love|brilliant|amazing|fantastic)\b"
)


@functools.lru_cache(maxsize=1)
def _slang() -> dict[str, str]:
    return json.loads((RESOURCES / "slang.json").read_text(encoding="utf-8"))


@functools.lru_cache(maxsize=1)
def _harm() -> dict[str, list[str]]:
    data = json.loads((RESOURCES / "harm_lexicon.json").read_text(encoding="utf-8"))
    return {k: v for k, v in data.items() if not k.startswith("_")}


@functools.lru_cache(maxsize=1)
def _wordsegment_load():
    """wordsegment's corpus load is ~1s, so do it once and only if needed."""
    import wordsegment

    wordsegment.load()
    return wordsegment


# --------------------------------------------------------------------------
# span extraction
# --------------------------------------------------------------------------

def _spans(pattern: re.Pattern, text: str, taken: list[tuple[int, int]]) -> list[Span]:
    """Matches of `pattern` that do not overlap an already-claimed region."""
    out: list[Span] = []
    for m in pattern.finditer(text):
        if any(m.start() < end and m.end() > start for start, end in taken):
            continue
        out.append(Span(text=m.group(), start=m.start(), end=m.end()))
        taken.append((m.start(), m.end()))
    return out


def extract_emoji_spans(text: str) -> list[Span]:
    return [
        Span(text=item["emoji"], start=item["match_start"], end=item["match_end"])
        for item in emoji_lib.emoji_list(text)
    ]


def segment_hashtag(tag: str) -> list[str]:
    """Split a hashtag into words: SaveTirunelveli -> [save, tirunelveli].

    camelCase first because it is exact and free; falls back to the wordsegment
    unigram model for all-lowercase tags. Unsegmented, a hashtag is one opaque
    token and both NER and the lexical features miss the topic it carries.
    """
    body = tag.lstrip("#")
    if not body:
        return []

    parts = [p for p in CAMEL_SPLIT_RE.split(body) if p]
    parts = [p for chunk in parts for p in NON_ALNUM_RE.split(chunk) if p]

    if len(parts) > 1:
        return [p.lower() for p in parts]

    single = parts[0] if parts else body
    if len(single) <= 3 or single.isdigit():
        return [single.lower()]

    try:
        segmented = _wordsegment_load().segment(single)
    except Exception:
        return [single.lower()]
    return segmented or [single.lower()]


# --------------------------------------------------------------------------
# main entry points
# --------------------------------------------------------------------------

def extract(text: str) -> LexicalFeatures:
    """Full lexical pass over the ORIGINAL text."""
    feats = LexicalFeatures()
    taken: list[tuple[int, int]] = []

    # order matters: URLs claim their region before the hashtag/mention
    # patterns get a chance to shred them
    feats.urls = _spans(URL_RE, text, taken)
    feats.mentions = _spans(MENTION_RE, text, taken)
    feats.hashtags = _spans(HASHTAG_RE, text, taken)
    feats.emojis = extract_emoji_spans(text)
    feats.numbers = _spans(NUMBER_RE, text, taken)
    feats.repeated_punctuation = [
        Span(text=m.group(), start=m.start(), end=m.end())
        for m in REPEATED_PUNCT_RE.finditer(text)
    ]

    feats.hashtag_words = [
        w for tag in feats.hashtags for w in segment_hashtag(tag.text)
    ]
    feats.emoji_names = [emoji_lib.demojize(s.text).strip(":") for s in feats.emojis]

    alpha = [c for c in text if c.isalpha()]

    feats.char_count = len(text)
    feats.word_count = len(text.split())
    feats.caps_ratio = (
        sum(1 for c in alpha if c.isupper()) / len(alpha) if alpha else 0.0
    )
    feats.exclamation_count = text.count("!")
    feats.question_count = text.count("?")
    feats.elongation_count = len(ELONGATION_RE.findall(text))

    slang_map = _slang()
    feats.slang_hits = sorted(
        {w for w in re.findall(r"\b[a-z]+\b", text.lower()) if w in slang_map}
    )

    # a post that is only a URL / mention / emoji has nothing to analyse
    stripped = text
    for span in sorted(
        feats.urls + feats.mentions + feats.emojis,
        key=lambda s: s.start,
        reverse=True,
    ):
        stripped = stripped[: span.start] + " " + stripped[span.end :]
    feats.is_empty_after_clean = not stripped.strip(" \t\n#@:;,.!?-_")

    return feats


def assess_risk(text: str, feats: LexicalFeatures) -> RiskSignals:
    """Lexical harm indicators for Module 4.

    Word-boundary matched so "classic" does not trip on "ass", and every hit is
    reported by name - the moderator plugin has to be able to explain itself.
    """
    lowered = " " + text.lower() + " "
    harm = _harm()
    risk = RiskSignals()

    def hits(terms: list[str]) -> list[str]:
        found = []
        for term in terms:
            if re.search(r"(?<![a-z])" + re.escape(term) + r"(?![a-z])", lowered):
                found.append(term)
        return found

    risk.profanity = hits(harm.get("profanity", []))
    risk.threat = hits(harm.get("threat", []))
    risk.identity_attack = hits(harm.get("identity_attack", []))

    # aggression: shouting + punctuation hammering + lexicon density
    words = max(feats.word_count, 1)
    lexicon_density = (
        len(risk.profanity) + 2 * len(risk.threat) + 2 * len(risk.identity_attack)
    ) / words
    shouting = feats.caps_ratio if feats.char_count > 8 else 0.0
    punct = min(feats.exclamation_count / 5.0, 1.0)

    risk.aggression_score = round(
        min(1.0, 0.5 * min(lexicon_density * 4, 1.0) + 0.3 * shouting + 0.2 * punct), 4
    )
    risk.has_risk = (
        bool(risk.profanity or risk.threat or risk.identity_attack)
        or risk.aggression_score >= 0.6
    )
    return risk


def find_sarcasm_markers(text: str) -> list[str]:
    """Phrases suggesting the literal reading is wrong. Feeds the escalation rules."""
    lowered = text.lower()
    markers = [m for m in _harm().get("sarcasm_markers", []) if m in lowered]
    if NEGATIVE_FACE_RE.search(text) and POSITIVE_WORD_RE.search(lowered):
        markers.append("positive_words_with_negative_emoji")
    return markers
