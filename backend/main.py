from __future__ import annotations
import json, os
from pathlib import Path
from typing import Any
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from .analysis import AnalysisPipeline
from .supabase_store import upsert_rows
from .x_ingest import DEFAULT_QUERY, fetch_recent_posts

ROOT = Path(__file__).resolve().parents[1]
SEED = json.loads((ROOT / "data" / "seed.json").read_text(encoding="utf-8"))
pipeline = AnalysisPipeline(os.getenv("SENTIMENT_MODEL", "cardiffnlp/twitter-roberta-base-sentiment-latest"))
posts = pipeline.process(SEED)
app = FastAPI(title="ARGUS Live Intelligence API", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

class ChatRequest(BaseModel):
    question: str

def summarize() -> dict[str, Any]:
    sentiment = {"positive": 0, "neutral": 0, "negative": 0}
    topics: dict[str, dict[str, Any]] = {}
    for post in posts:
        sentiment[post["sentiment"]["label"]] += 1
        topic = topics.setdefault(post["topic"], {"topic":post["topic"],"posts":0,"sentiment":0.0,"evidence":[]})
        topic["posts"] += 1; topic["sentiment"] += post["sentiment"]["score"]; topic["evidence"].append(post["source_url"])
    for topic in topics.values():
        topic["sentiment"] = round(topic["sentiment"] / topic["posts"], 3); topic["evidence"] = topic["evidence"][:3]
    return {"total_posts":len(posts),"sentiment":sentiment,"topics":sorted(topics.values(),key=lambda x:x["posts"],reverse=True)}

@app.get("/api/overview")
def overview():
    return {**summarize(),"source":"seed","model":posts[0]["sentiment"]["source"] if posts else "none","moderator_enabled":False}

@app.get("/api/sentiment")
def sentiment():
    return {"points":[{"date":p["created_at"],"score":p["sentiment"]["score"],"label":p["sentiment"]["label"],"source":p["sentiment"]["source"]} for p in posts]}

@app.get("/api/topics")
def topics(): return {"topics":summarize()["topics"]}

@app.get("/api/entities")
def entities():
    counts: dict[str, dict[str, Any]] = {}
    for post in posts:
        for entity in post["entities"]:
            item = counts.setdefault(entity["text"], {"text":entity["text"],"label":entity["label"],"count":0}); item["count"] += 1
    return {"entities":sorted(counts.values(),key=lambda x:x["count"],reverse=True)}

@app.get("/api/audience")
def audience():
    locations: dict[str,int] = {}; languages: dict[str,int] = {}
    for post in posts:
        locations[post.get("location") or "Unknown"] = locations.get(post.get("location") or "Unknown",0) + 1
        languages[post.get("lang","unknown")] = languages.get(post.get("lang","unknown"),0) + 1
    return {"segments":[{"name":n,"count":c,"basis":"public self-declared location"} for n,c in sorted(locations.items(),key=lambda x:x[1],reverse=True)],"languages":languages,"disclaimer":"Aggregate public signals only; protected traits are not inferred."}

@app.post("/api/ingest/run")
async def ingest():
    global posts
    fetched, status = await fetch_recent_posts(DEFAULT_QUERY)
    if fetched:
        posts = pipeline.process(fetched)
        raw_rows = [{"id":p["id"],"source":"x","text":p["text"],"created_at":p["created_at"],"source_url":p["source_url"],"lang":p.get("lang"),"location":p.get("location"),"metrics":p.get("metrics",{}),"pii_redacted":True} for p in fetched]
        nlp_rows = [{"id":p["id"],"content_hash":p["content_hash"],"sentiment_label":p["sentiment"]["label"],"sentiment_score":p["sentiment"]["score"],"sentiment_confidence":p["sentiment"]["confidence"],"sentiment_source":p["sentiment"]["source"],"event_polarity":p["event_polarity"],"entities":p["entities"],"language":p.get("lang"),"topic":p["topic"]} for p in posts]
        raw_result = await upsert_rows("raw_posts", raw_rows)
        nlp_result = await upsert_rows("posts_nlp", nlp_rows)
        return {"status":status,"raw":raw_result,"nlp":nlp_result,"count":len(posts)}
    return {"status":status,"count":len(posts),"message":"Using clearly labelled seeded fallback data."}

@app.post("/api/chat")
def chat(payload: ChatRequest):
    question = payload.question.lower(); data = summarize()
    if "sentiment" in question: answer = f"The current corpus contains {data['sentiment']['positive']} positive, {data['sentiment']['neutral']} neutral, and {data['sentiment']['negative']} negative posts."
    elif "topic" in question or "trend" in question: answer = "The leading topics are " + ", ".join(t["topic"] for t in data["topics"][:3]) + "."
    elif "demographic" in question or "audience" in question or "location" in question: answer = "ARGUS reports aggregate public language and self-declared location signals only. It does not infer protected demographics."
    elif "influencer" in question or "influence" in question: answer = "Influence is approximated from public engagement metrics in this prototype. Full propagation graphs require interaction-edge access."
    else: answer = "Ask about sentiment, topics, entities, audience segments, or influence."
    return {"answer":answer,"evidence":[p["source_url"] for p in posts[:3]],"model":"rule-based retrieval preview","moderator_enabled":False}

@app.get("/api/health")
def health(): return {"ok":True,"model":pipeline.model_name,"moderator_enabled":False,"posts":len(posts),"load_errors":pipeline.load_errors}
