"""
Persistence.

The flowchart stopped at "structured JSON / dict". Five teammates consuming an
in-memory Python dict means five different integration bugs, so the real
hand-off is a database row: Modules 2, 3, 4 and 6 read `posts_nlp`, they do not
import this package.

Writes are upserts keyed on `post_id`, so a re-run corrects rows instead of
duplicating them.

Talks to Supabase over PostgREST with `requests` rather than pulling in the
supabase client - one less dependency for one endpoint. `JsonlSink` is the
default so the pipeline is fully usable before anyone has provisioned a
database.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Iterable, Protocol

import requests

from argus_nlp.schema import NLPResult

log = logging.getLogger(__name__)

TABLE = "posts_nlp"


class Sink(Protocol):
    def write(self, results: Iterable[NLPResult]) -> int: ...


def to_row(result: NLPResult) -> dict:
    """Flatten an NLPResult into one database row.

    The heavy nested blocks stay as JSONB - Postgres can index into them and
    Module 6 wants the token list whole. The fields the dashboard filters and
    sorts on are lifted into real columns so they can be indexed.
    """
    s = result.sentiment
    return {
        "post_id": result.post_id,
        "schema_version": result.schema_version,
        "source": result.source,
        "author_ref_hash": result.author_ref_hash,
        "timestamp": result.timestamp.isoformat() if result.timestamp else None,
        "parent_id": result.parent_id,
        "content_hash": result.content_hash,
        "is_duplicate": result.is_duplicate,
        # texts
        "original_text": result.original_text,
        "analysis_text": result.analysis_text,
        "nlp_text": result.nlp_text,
        # promoted for indexing / dashboard filters
        "primary_lang": result.language.primary_lang,
        "lang_confidence": result.language.lang_confidence,
        "is_code_mixed": result.language.is_code_mixed,
        "sentiment_label": s.label,
        "sentiment_score": s.score,
        "sentiment_confidence": s.confidence,
        "sentiment_source": s.source,
        "emotions": s.emotions,
        "escalated": s.escalated,
        "escalation_reasons": s.escalation_reasons,
        "has_risk": result.risk.has_risk,
        "aggression_score": result.risk.aggression_score,
        "event_polarity": result.event.polarity,
        "event_severity": result.event.severity,
        # nested detail
        "lexical": result.lexical.model_dump(mode="json"),
        "risk": result.risk.model_dump(mode="json"),
        "event": result.event.model_dump(mode="json"),
        "pii": result.pii.model_dump(mode="json"),
        "nlp": result.nlp.model_dump(mode="json"),
        "sentiment": s.model_dump(mode="json"),
        "model_versions": result.model_versions,
        "processed_at": result.processed_at.isoformat(),
        "errors": result.errors,
    }


class JsonlSink:
    """Default sink. One JSON object per line, UTF-8.

    Explicit UTF-8 matters on Windows: the default codepage is cp1252 and will
    raise on the first Tamil or Devanagari post.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def write(self, results: Iterable[NLPResult]) -> int:
        count = 0
        with self.path.open("w", encoding="utf-8") as handle:
            for result in results:
                handle.write(result.model_dump_json() + "\n")
                count += 1
        return count


class SupabaseSink:
    def __init__(self, url: str, key: str, table: str = TABLE, batch_size: int = 100):
        if not url or not key:
            raise ValueError("SUPABASE_URL and a Supabase key are both required")
        self.endpoint = f"{url.rstrip('/')}/rest/v1/{table}"
        self.headers = {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            # upsert: re-running the pipeline corrects rows, never duplicates
            "Prefer": "resolution=merge-duplicates,return=minimal",
        }
        self.batch_size = batch_size
        self._session = requests.Session()

    def write(self, results: Iterable[NLPResult]) -> int:
        rows = [to_row(r) for r in results]
        written = 0
        for start in range(0, len(rows), self.batch_size):
            chunk = rows[start : start + self.batch_size]
            response = self._session.post(
                f"{self.endpoint}?on_conflict=post_id",
                data=json.dumps(chunk, ensure_ascii=False).encode("utf-8"),
                headers=self.headers,
                timeout=60,
            )
            if response.status_code >= 300:
                log.error(
                    "Supabase upsert failed (HTTP %s): %s",
                    response.status_code,
                    response.text[:500],
                )
                response.raise_for_status()
            written += len(chunk)
        return written
