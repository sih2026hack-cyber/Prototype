"""
ARGUS Module 5 — output contract.

This file IS the interface between Module 5 (lexical + NLP) and the rest of
the ARGUS system. Modules 2 (dashboard), 3 (chatbot), 4 (moderator plugin)
and 6 (embeddings/BERTopic) all read `NLPResult`.

Treat it as frozen. If a field must change, bump SCHEMA_VERSION and tell the
team, because their code is keyed to this shape.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field

SCHEMA_VERSION = "1.0.0"

SentimentLabel = Literal["positive", "negative", "neutral", "unavailable"]

SentimentSource = Literal[
    "transformer",        # fine-tuned transformer answered (tier 1, preferred)
    "transformer_llm_failed",  # escalated, LLM failed, transformer result kept
    "vader",              # VADER answered (tier 1 fallback), no escalation needed
    "minimax",            # escalated to the LLM and it answered
    "vader_llm_failed",   # escalated, LLM failed, VADER result kept
    "unavailable",        # non-English with no LLM available - deliberately no score
    "skipped_empty",      # nothing left to score after cleaning
]


# --------------------------------------------------------------------------
# input
# --------------------------------------------------------------------------

class PostInput(BaseModel):
    """What Module 1 (scraping) hands us."""

    post_id: str
    source: str                       # "youtube" | "reddit" | "telegram" | "dataset:sentiment140"
    original_text: str
    author_ref: str | None = None     # raw handle; we never store it unhashed
    timestamp: datetime | None = None
    parent_id: str | None = None      # set when this is a comment/reply
    lang_hint: str | None = None      # platform-declared language, if any


# --------------------------------------------------------------------------
# lexical layer - surface features, no models, microseconds
# --------------------------------------------------------------------------

class Span(BaseModel):
    """A extracted substring plus where it sat in original_text.

    Offsets are what let the variant builder mask exactly these spans instead
    of re-running regexes over already-modified text.
    """

    text: str
    start: int
    end: int


class LexicalFeatures(BaseModel):
    # extracted spans (offsets into original_text)
    hashtags: list[Span] = Field(default_factory=list)
    mentions: list[Span] = Field(default_factory=list)
    urls: list[Span] = Field(default_factory=list)
    emojis: list[Span] = Field(default_factory=list)
    numbers: list[Span] = Field(default_factory=list)
    repeated_punctuation: list[Span] = Field(default_factory=list)

    # derived word-level material
    hashtag_words: list[str] = Field(default_factory=list)   # "#SaveTirunelveli" -> ["save","tirunelveli"]
    emoji_names: list[str] = Field(default_factory=list)     # ":fire:", ":smiling_face:"

    # surface statistics
    char_count: int = 0
    word_count: int = 0
    caps_ratio: float = 0.0          # share of alphabetic chars that are uppercase
    exclamation_count: int = 0
    question_count: int = 0
    elongation_count: int = 0        # "sooo good!!" -> 1
    slang_hits: list[str] = Field(default_factory=list)

    is_empty_after_clean: bool = False   # media-only post: nothing to analyse


class RiskSignals(BaseModel):
    """Lexical harm indicators. Module 4 (AI moderator) consumes this.

    Deliberately lexicon-based and explainable - we report which terms matched,
    never a bare unexplained score.
    """

    profanity: list[str] = Field(default_factory=list)
    threat: list[str] = Field(default_factory=list)
    identity_attack: list[str] = Field(default_factory=list)
    aggression_score: float = 0.0    # 0..1, from caps ratio + punctuation density + lexicon hits
    has_risk: bool = False


class PIIFlags(BaseModel):
    """What we redacted before anything left this module."""

    emails_redacted: int = 0
    phones_redacted: int = 0
    id_numbers_redacted: int = 0


# --------------------------------------------------------------------------
# nlp layer - model-backed
# --------------------------------------------------------------------------

class LanguageInfo(BaseModel):
    primary_lang: str = "und"        # ISO 639-1, or "und" when undetermined
    lang_confidence: float = 0.0
    is_code_mixed: bool = False
    candidates: list[tuple[str, float]] = Field(default_factory=list)


class Token(BaseModel):
    text: str
    lemma: str
    pos: str
    tag: str
    dep: str
    is_stop: bool


class Entity(BaseModel):
    text: str
    label: str
    start: int
    end: int
    source: Literal["model", "gazetteer"] = "model"


class NLPFeatures(BaseModel):
    tokens: list[Token] = Field(default_factory=list)
    lemmas: list[str] = Field(default_factory=list)
    entities: list[Entity] = Field(default_factory=list)
    noun_chunks: list[str] = Field(default_factory=list)
    spacy_model: str = ""
    processed: bool = False          # False when no model covers this language


class VaderScores(BaseModel):
    compound: float
    pos: float
    neu: float
    neg: float


class EventSignal(BaseModel):
    """Is this post ABOUT something happening? Distinct from sentiment.

    "Heavy flooding in Thoothukudi, NDRF deployed" is neutral in sentiment -
    the writer reports and offers no opinion - but it is precisely what the
    dashboard must surface. Trend and alerting views filter on this; mood
    charts use `sentiment`.
    """

    polarity: Literal["negative", "positive", "none"] = "none"
    severity: float = 0.0                                  # 0..1
    categories: list[str] = Field(default_factory=list)    # disaster, violence, ...
    matched_terms: list[str] = Field(default_factory=list)  # auditable evidence
    source: Literal["lexical", "llm", "none"] = "none"

    @property
    def is_event(self) -> bool:
        return self.polarity != "none"


class SentimentResult(BaseModel):
    label: SentimentLabel = "unavailable"
    score: float = 0.0               # -1..1
    confidence: float = 0.0
    source: SentimentSource = "unavailable"

    vader: VaderScores | None = None
    emotions: list[str] = Field(default_factory=list)   # sarcasm, anxiety, excitement, ...

    escalated: bool = False
    escalation_reasons: list[str] = Field(default_factory=list)
    llm_rationale: str | None = None


# --------------------------------------------------------------------------
# the contract
# --------------------------------------------------------------------------

class NLPResult(BaseModel):
    schema_version: str = SCHEMA_VERSION

    # passthrough metadata - trends-over-time and network analysis need these
    post_id: str
    source: str
    author_ref_hash: str | None = None
    timestamp: datetime | None = None
    parent_id: str | None = None

    # the three text variants (see plan C1)
    original_text: str               # untouched evidence
    analysis_text: str = ""          # for sentiment: emoji/punct/caps preserved
    nlp_text: str = ""               # for spaCy: placeholders, case preserved

    content_hash: str = ""           # sha256 of normalised text, for dedup
    is_duplicate: bool = False

    language: LanguageInfo = Field(default_factory=LanguageInfo)
    lexical: LexicalFeatures = Field(default_factory=LexicalFeatures)
    risk: RiskSignals = Field(default_factory=RiskSignals)
    event: EventSignal = Field(default_factory=EventSignal)
    pii: PIIFlags = Field(default_factory=PIIFlags)
    nlp: NLPFeatures = Field(default_factory=NLPFeatures)
    sentiment: SentimentResult = Field(default_factory=SentimentResult)

    model_versions: dict[str, str] = Field(default_factory=dict)
    timings_ms: dict[str, float] = Field(default_factory=dict)
    processed_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )
    errors: list[str] = Field(default_factory=list)
