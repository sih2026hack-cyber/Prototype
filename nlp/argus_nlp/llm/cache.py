"""
SQLite cache + daily call counter for the LLM tier.

Every non-English post escalates, so without a cache a demo run over a few
thousand posts makes a few thousand paid calls - and social data is heavily
repetitive, so most of them would be asking the same question twice.

The cache key includes the prompt version, so changing the prompt correctly
invalidates old answers instead of silently serving results generated under
different instructions.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from datetime import date
from pathlib import Path
from typing import Any

_SCHEMA = """
CREATE TABLE IF NOT EXISTS llm_cache (
    key         TEXT PRIMARY KEY,
    model       TEXT NOT NULL,
    response    TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS llm_usage (
    day    TEXT PRIMARY KEY,
    calls  INTEGER NOT NULL DEFAULT 0
);
"""


def make_key(text: str, model: str, prompt_version: str) -> str:
    payload = f"{model}|{prompt_version}|{text}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


class LLMCache:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    def get(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT response FROM llm_cache WHERE key = ?", (key,)
            ).fetchone()
        if not row:
            return None
        try:
            return json.loads(row[0])
        except json.JSONDecodeError:
            return None

    def set(self, key: str, model: str, response: dict[str, Any]) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO llm_cache (key, model, response) VALUES (?, ?, ?)",
                (key, model, json.dumps(response, ensure_ascii=False)),
            )
            self._conn.commit()

    # ---- daily cap -------------------------------------------------------

    def calls_today(self) -> int:
        with self._lock:
            row = self._conn.execute(
                "SELECT calls FROM llm_usage WHERE day = ?", (date.today().isoformat(),)
            ).fetchone()
        return row[0] if row else 0

    def record_calls(self, count: int = 1) -> int:
        today = date.today().isoformat()
        with self._lock:
            self._conn.execute(
                "INSERT INTO llm_usage (day, calls) VALUES (?, ?) "
                "ON CONFLICT(day) DO UPDATE SET calls = calls + excluded.calls",
                (today, count),
            )
            self._conn.commit()
            row = self._conn.execute(
                "SELECT calls FROM llm_usage WHERE day = ?", (today,)
            ).fetchone()
        return row[0] if row else count

    def close(self) -> None:
        with self._lock:
            self._conn.close()
