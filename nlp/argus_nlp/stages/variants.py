"""
TEXT VARIANT BUILDER.

The single biggest correctness fix over the original flowchart: one
`clean_text` cannot serve both sentiment and spaCy, because they need opposite
things.

  analysis_text  for VADER / the LLM
                 emoji, punctuation and CAPS are PRESERVED - they are VADER's
                 intensity signal. URLs and mentions are stripped as noise.

  nlp_text       for spaCy
                 case is PRESERVED (NER depends on capitalisation), URLs,
                 mentions and emoji are removed, hashtags are expanded into
                 real words so the entities inside them become visible.

Both are built by masking the character spans the lexical layer already found,
so we never re-run regexes over half-modified text.

Two rules here were derived by measuring VADER rather than by assuming:

  * Raw emoji are KEPT, not demojized. VADER has its own emoji lexicon and
    scores the raw codepoint more strongly than the ":name:" form
    ("so sad U+1F622" = -0.776 vs "so sad :crying_face:" = -0.526).

  * Repeated punctuation gets a SPACE in front of it instead of being deleted
    or left attached. Attached, it breaks VADER's token match on short words
    ("ok!!!" scores 0.0, "ok" scores 0.296); detached, both the lexicon match
    and the intensity boost survive ("ok !!!" scores 0.472).
"""

from __future__ import annotations

import functools
import re

from argus_nlp.schema import LexicalFeatures, Span

ELONGATION_RUN_RE = re.compile(r"([A-Za-z])\1{2,}")
REPEATED_PUNCT_RE = re.compile(r"([!?])\1{1,}")
MULTISPACE_RE = re.compile(r"[ \t ]+")
MULTINEWLINE_RE = re.compile(r"\n{3,}")

CAMEL_SPLIT_RE = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")


@functools.lru_cache(maxsize=1)
def _vader_lexicon() -> dict:
    from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

    return SentimentIntensityAnalyzer().lexicon


def normalise_elongation(text: str) -> str:
    """"loveeee" -> "love", "gooooood" -> "good", keeping the word real.

    Collapsing a run to a single letter breaks "gooooood" into "god", and
    collapsing to two breaks "loveeee" into "lovee". So try both and prefer
    whichever the VADER lexicon actually recognises.
    """
    lexicon = _vader_lexicon()

    def fix(match: re.Match) -> str:
        char = match.group(1)
        start, end = match.span()
        # the whole word this run sits in, so we can test candidate spellings
        left = start
        while left > 0 and text[left - 1].isalpha():
            left -= 1
        right = end
        while right < len(text) and text[right].isalpha():
            right += 1
        word = text[left:right]

        two = ELONGATION_RUN_RE.sub(lambda m: m.group(1) * 2, word).lower()
        one = ELONGATION_RUN_RE.sub(lambda m: m.group(1), word).lower()

        if two in lexicon:
            return char * 2
        if one in lexicon:
            return char
        return char * 2

    return ELONGATION_RUN_RE.sub(fix, text)


def _apply_edits(text: str, edits: list[tuple[Span, str]]) -> str:
    """Apply every replacement in ONE right-to-left pass.

    All span offsets refer to the original string, so the moment one edit
    changes the length of the text, every offset to its right is stale. Doing
    this in two passes - blanking URLs and mentions first, then rewriting
    hashtags with offsets measured before that blanking - silently corrupted
    posts where a mention preceded a hashtag:

        "RT @citizen: OMG!!! #SaveTirunelveli This is amazing!!"
          -> "RT : OMG !!! #SaveTi SaveTirunelveli s amazing !!"

    Note "This is" eaten down to "s" and a phantom "#SaveTi" spliced in. It
    only showed up on some posts, which is what made it dangerous.

    Overlapping spans are dropped rather than applied on top of each other.
    """
    applied_start = len(text)
    for span, replacement in sorted(edits, key=lambda e: (-e[0].start, e[0].end)):
        if span.end > applied_start:
            continue  # overlaps a span already replaced to our right
        text = text[: span.start] + replacement + text[span.end :]
        applied_start = span.start
    return text


def _tidy(text: str) -> str:
    text = MULTISPACE_RE.sub(" ", text)
    text = MULTINEWLINE_RE.sub("\n\n", text)
    return text.strip()


def expand_hashtag_inline(tag: str) -> str:
    """"#SaveTirunelveli" -> "Save Tirunelveli", preserving case for NER.

    Case matters: lowercased, spaCy will not tag Tirunelveli as a place.
    """
    from argus_nlp.stages.lexical import segment_hashtag

    body = tag.lstrip("#")
    camel = [p for p in CAMEL_SPLIT_RE.split(body) if p]
    if len(camel) > 1:
        return " ".join(camel)
    words = segment_hashtag(tag)
    if len(words) > 1 and body.islower():
        return " ".join(words)
    return body


def build_analysis_text(original: str, feats: LexicalFeatures) -> str:
    """For VADER and the LLM. Keeps emoji, caps and punctuation intensity."""
    edits: list[tuple[Span, str]] = [(s, " ") for s in feats.urls + feats.mentions]
    # keep the hashtag's words - "#terrible" carries sentiment - but drop the '#'
    edits += [(s, " " + s.text.lstrip("#") + " ") for s in feats.hashtags]

    text = _apply_edits(original, edits)
    text = normalise_elongation(text)
    # detach repeated punctuation so VADER still matches the preceding word
    text = REPEATED_PUNCT_RE.sub(lambda m: " " + m.group(0), text)
    return _tidy(text)


def build_nlp_text(original: str, feats: LexicalFeatures) -> str:
    """For spaCy. Case preserved; URLs, mentions and emoji removed."""
    edits: list[tuple[Span, str]] = [
        (s, " ") for s in feats.urls + feats.mentions + feats.emojis
    ]
    edits += [(s, " " + expand_hashtag_inline(s.text) + " ") for s in feats.hashtags]

    text = _apply_edits(original, edits)
    text = normalise_elongation(text)
    # spaCy gains nothing from "!!!" and it only pollutes the parse
    text = REPEATED_PUNCT_RE.sub(lambda m: m.group(1), text)
    return _tidy(text)


def build(original: str, feats: LexicalFeatures) -> tuple[str, str]:
    return build_analysis_text(original, feats), build_nlp_text(original, feats)
