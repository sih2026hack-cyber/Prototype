"""RoBERTa-first analysis layer with transparent fallbacks."""
from __future__ import annotations
import hashlib, re
from typing import Any

MODEL_NAME = "cardiffnlp/twitter-roberta-base-sentiment-latest"

class AnalysisPipeline:
    def __init__(self, model_name: str = MODEL_NAME) -> None:
        self.model_name = model_name
        self._sentiment = None
        self._vader = None
        self._embedder = None
        self.load_errors: list[str] = []

    def _load_sentiment(self) -> None:
        if self._sentiment is not None or self._vader is not None:
            return
        try:
            from transformers import pipeline
            self._sentiment = pipeline("text-classification", model=self.model_name)
        except Exception as exc:
            self.load_errors.append(f"roberta:{exc.__class__.__name__}")
            try:
                from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
                self._vader = SentimentIntensityAnalyzer()
            except Exception as vader_exc:
                self.load_errors.append(f"vader:{vader_exc.__class__.__name__}")

    def sentiment(self, text: str) -> dict[str, Any]:
        self._load_sentiment()
        if self._sentiment:
            result = self._sentiment(text[:512], truncation=True)[0]
            label = str(result["label"]).lower()
            label = {"label_0":"negative","label_1":"neutral","label_2":"positive"}.get(label, label)
            confidence = float(result["score"])
            score = confidence if label == "positive" else -confidence if label == "negative" else 0.0
            return {"label": label, "score": score, "confidence": confidence, "source": "roberta"}
        if self._vader:
            compound = float(self._vader.polarity_scores(text)["compound"])
            label = "positive" if compound >= .05 else "negative" if compound <= -.05 else "neutral"
            return {"label": label, "score": compound, "confidence": abs(compound), "source": "vader_fallback"}
        return heuristic_sentiment(text)

    def entities(self, text: str) -> list[dict[str, str]]:
        try:
            import spacy
            nlp = spacy.load("en_core_web_sm")
            return [{"text": e.text, "label": e.label_, "source": "spacy"} for e in nlp(text).ents]
        except Exception:
            known = {"Chennai":"GPE","Tamil Nadu":"GPE","Velachery":"GPE","NDRF":"ORG"}
            return [{"text": name, "label": label, "source":"gazetteer"} for name, label in known.items() if name.lower() in text.lower()]

    def embedding_and_topic(self, text: str) -> tuple[list[float] | None, str, str]:
        try:
            from sentence_transformers import SentenceTransformer
            if self._embedder is None:
                self._embedder = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
            return self._embedder.encode(text, normalize_embeddings=True).tolist(), topic_from_text(text), "sentence-transformers"
        except Exception as exc:
            self.load_errors.append(f"embeddings:{exc.__class__.__name__}")
            return None, topic_from_text(text), "keyword_fallback"

    def process(self, posts: list[dict[str, Any]]) -> list[dict[str, Any]]:
        output = []
        for post in posts:
            vector, topic, embedding_source = self.embedding_and_topic(post["text"])
            output.append({**post, "sentiment": self.sentiment(post["text"]), "event_polarity": event_polarity(post["text"]), "entities": self.entities(post["text"]), "topic": topic, "embedding": vector, "embedding_source": embedding_source, "content_hash": hashlib.sha256(post["text"].encode()).hexdigest()})
        return output

def heuristic_sentiment(text: str) -> dict[str, Any]:
    tokens = set(re.findall(r"[a-z]+", text.lower()))
    positive = {"helping","useful","better","good","finally","opened","clear"}
    negative = {"flooded","flooding","severe","closed","frustrating","delayed","waterlogging"}
    score = (len(tokens & positive) - len(tokens & negative)) / max(1, len(tokens & (positive | negative)))
    label = "positive" if score > .15 else "negative" if score < -.15 else "neutral"
    return {"label": label, "score": round(score, 3), "confidence": .35, "source": "heuristic_preview"}

def event_polarity(text: str) -> dict[str, Any]:
    terms = {"flood":.9,"flooding":.9,"waterlogging":.85,"closed":.65,"delayed":.55,"help desk":-.15,"deployed":-.2}
    hits = [term for term in terms if term in text.lower()]
    severity = max([terms[term] for term in hits] or [0.0])
    return {"label":"negative" if severity >= .5 else "neutral","severity":severity,"matches":hits}

def topic_from_text(text: str) -> str:
    lower = text.lower()
    if any(w in lower for w in ("flood","waterlog","rain","drainage")): return "Flooding and drainage"
    if any(w in lower for w in ("bus","traffic","route","transport")): return "Transport response"
    if any(w in lower for w in ("official","administration","ndrf","help desk")): return "Public response"
    return "Other civic discussion"
