from __future__ import annotations
import hashlib
import os
from typing import Any
import httpx

DEFAULT_QUERY = '(flooding OR waterlogging OR "heavy rain") (Chennai OR Tamil Nadu) lang:en -is:retweet'

async def fetch_recent_posts(query: str | None = None, max_results: int = 100) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    token = os.getenv("X_BEARER_TOKEN", "").strip()
    if not token:
        return [], {"mode": "seed", "reason": "X_BEARER_TOKEN is not configured"}
    params = {"query": query or os.getenv("X_QUERY", DEFAULT_QUERY), "max_results": min(max(10, max_results), 100), "tweet.fields": "created_at,lang,public_metrics,author_id", "expansions": "author_id", "user.fields": "location,username"}
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get("https://api.x.com/2/tweets/search/recent", params=params, headers={"Authorization": f"Bearer {token}"})
        response.raise_for_status()
        payload = response.json()
    users = {user["id"]: user for user in payload.get("includes", {}).get("users", [])}
    posts = []
    salt = os.getenv("ARGUS_HASH_SALT", "development-only-salt")
    for item in payload.get("data", []):
        author_id = item.get("author_id", "unknown")
        author_ref = hashlib.sha256(f"{salt}:{author_id}".encode()).hexdigest()
        posts.append({"id": item["id"], "text": item.get("text", ""), "created_at": item.get("created_at"), "lang": item.get("lang", "unknown"), "location": users.get(author_id, {}).get("location") or "Unknown", "author_ref": author_ref, "source_url": f"https://x.com/i/web/status/{item['id']}", "metrics": item.get("public_metrics", {})})
    return posts, {"mode": "live", "result_count": len(posts), "next_token": payload.get("meta", {}).get("next_token")}
