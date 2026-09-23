from __future__ import annotations
import os
from typing import Any
import httpx

async def upsert_rows(table: str, rows: list[dict[str, Any]], conflict: str = "id") -> dict[str, Any]:
    base = os.getenv("SUPABASE_URL", "").rstrip("/")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base or not key or not rows:
        return {"mode": "local", "written": 0, "reason": "Supabase credentials are not configured"}
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal"}
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(f"{base}/rest/v1/{table}?on_conflict={conflict}", headers=headers, json=rows)
        response.raise_for_status()
    return {"mode": "supabase", "written": len(rows), "table": table}
