"""
GUARD STAGE - runs before anything else touches the text.

Three jobs, all cheap:

  1. PII redaction. The deck claims privacy-by-design, so email addresses,
     phone numbers and government-ID-shaped numbers are replaced with
     placeholders before the text is stored, embedded, or sent to MiniMax.
     Author handles are salted-hashed, never stored raw.

  2. Content hashing and duplicate detection. Retweets and copypasta are a
     large fraction of social data; reprocessing them wastes both spaCy time
     and paid LLM calls.

  3. Empty / media-only detection. A post that is just an image and a link has
     nothing to analyse - short-circuit it rather than feeding "" to VADER and
     recording a fake neutral.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata

from argus_nlp.schema import PIIFlags

EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b")

# Indian mobile numbers with or without +91, and generic 10-15 digit runs.
# Deliberately conservative: it must not eat ordinary numbers like "1,965".
PHONE_RE = re.compile(
    r"(?<![\w.])(?:\+91[\s-]?|0)?[6-9]\d{9}(?![\w.])"
    r"|(?<![\w.])\+\d{1,3}[\s-]?\d{6,12}(?![\w.])"
)

# Aadhaar-shaped: 12 digits, often grouped 4-4-4. Never validated, only masked.
ID_NUMBER_RE = re.compile(r"(?<![\w.])\d{4}[\s-]?\d{4}[\s-]?\d{4}(?![\w.])")

WHITESPACE_RE = re.compile(r"\s+")


def redact_pii(text: str) -> tuple[str, PIIFlags]:
    """Replace PII with typed placeholders. Order matters: the 12-digit ID
    pattern runs before the phone pattern so a grouped Aadhaar is not
    mistaken for a phone number."""
    flags = PIIFlags()

    text, n = ID_NUMBER_RE.subn("[ID]", text)
    flags.id_numbers_redacted = n

    text, n = EMAIL_RE.subn("[EMAIL]", text)
    flags.emails_redacted = n

    text, n = PHONE_RE.subn("[PHONE]", text)
    flags.phones_redacted = n

    return text, flags


def hash_author(author_ref: str | None, salt: str) -> str | None:
    """Salted hash of a handle. Stable across runs (so the network module can
    still join on it) but not reversible to the original handle."""
    if not author_ref:
        return None
    digest = hashlib.sha256(f"{salt}:{author_ref}".encode("utf-8")).hexdigest()
    return digest[:32]


def normalise_for_hash(text: str) -> str:
    """Canonical form used for duplicate detection only.

    Aggressive on purpose - casing, whitespace, URLs and the leading "RT @x:"
    of a retweet should not make two identical posts look different.
    """
    text = unicodedata.normalize("NFKC", text)
    text = re.sub(r"^\s*RT\s+@[\w]+:\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"https?://\S+|www\.\S+", "", text)
    text = WHITESPACE_RE.sub(" ", text)
    return text.strip().lower()


def content_hash(text: str) -> str:
    return hashlib.sha256(normalise_for_hash(text).encode("utf-8")).hexdigest()


class DuplicateRegistry:
    """In-memory seen-set for a batch run.

    Intentionally simple. Cross-run deduplication is the database's job - the
    `posts_nlp` upsert is keyed on post_id, and content_hash is stored as a
    column so Module 6 can group identical posts without re-embedding them.
    """

    def __init__(self) -> None:
        self._seen: set[str] = set()

    def check_and_add(self, digest: str) -> bool:
        """True if this content has already been seen in this run."""
        if digest in self._seen:
            return True
        self._seen.add(digest)
        return False

    def __len__(self) -> int:
        return len(self._seen)
