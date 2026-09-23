"""
NLP LAYER - tokens, lemmas, POS, dependencies and named entities.

Two things the original flowchart got wrong are fixed here.

  1. Model routing. `en_core_web_sm` is English-only. Feeding it Hindi or
     French produces confident garbage, so posts are routed by detected
     language: English to the full English pipeline, everything else to the
     multilingual NER model, and anything with no model at all is marked
     `processed = False` rather than given fake annotations.

  2. Batching. spaCy is called through `nlp.pipe()` grouped by model, not once
     per post. On a Sentiment140-sized slice that is the difference between
     minutes and hours.

The gazetteer is layered in as an EntityRuler placed BEFORE the statistical
NER, so Indian districts, ministries and agencies win over whatever
`en_core_web_sm` would have guessed - out of the box it misses most of them.
Ruler matches carry an ent_id so we can honestly report which entities came
from the list and which from the model.
"""

from __future__ import annotations

import functools
import json

from argus_nlp.config import RESOURCES, get_settings
from argus_nlp.schema import Entity, NLPFeatures, Token

GAZETTEER_ID = "argus_gaz"

# Languages en_core_web_sm must never see. Anything not English goes to the
# multilingual model; anything the multilingual model cannot tokenise sensibly
# is reported as unprocessed rather than guessed at.
ENGLISH = "en"


@functools.lru_cache(maxsize=8)
def _load(model_name: str):
    import spacy

    return spacy.load(model_name)


@functools.lru_cache(maxsize=1)
def _gazetteer_patterns() -> list[dict]:
    path = RESOURCES / "gazetteer.jsonl"
    if not path.exists():
        return []
    patterns = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        entry = json.loads(line)
        entry["id"] = GAZETTEER_ID
        patterns.append(entry)
    return patterns


@functools.lru_cache(maxsize=8)
def get_pipeline(model_name: str):
    """Load a spaCy model and attach the gazetteer once."""
    nlp = _load(model_name)
    if "entity_ruler" not in nlp.pipe_names:
        patterns = _gazetteer_patterns()
        if patterns:
            # before the statistical NER so list matches take precedence
            where = {"before": "ner"} if "ner" in nlp.pipe_names else {}
            ruler = nlp.add_pipe("entity_ruler", **where)
            ruler.add_patterns(patterns)
    return nlp


def model_for_language(lang: str) -> str:
    settings = get_settings()
    if lang == ENGLISH:
        return settings.spacy_english_model
    return settings.spacy_multilingual_model


def _to_features(doc, model_name: str) -> NLPFeatures:
    feats = NLPFeatures(spacy_model=model_name, processed=True)

    has_tagger = bool(doc.has_annotation("TAG"))
    has_parser = bool(doc.has_annotation("DEP"))

    for token in doc:
        if token.is_space:
            continue
        feats.tokens.append(
            Token(
                text=token.text,
                # the multilingual model has no lemmatiser; fall back honestly
                lemma=token.lemma_ if token.lemma_ else token.text.lower(),
                pos=token.pos_ if has_tagger else "",
                tag=token.tag_ if has_tagger else "",
                dep=token.dep_ if has_parser else "",
                is_stop=bool(token.is_stop),
            )
        )

    feats.lemmas = [t.lemma for t in feats.tokens if not t.is_stop and t.lemma.strip()]
    feats.entities = [
        Entity(
            text=ent.text,
            label=ent.label_,
            start=ent.start_char,
            end=ent.end_char,
            source="gazetteer" if ent.ent_id_ == GAZETTEER_ID else "model",
        )
        for ent in doc.ents
    ]
    if has_parser:
        feats.noun_chunks = [chunk.text for chunk in doc.noun_chunks]
    return feats


def process_one(text: str, lang: str) -> NLPFeatures:
    """Convenience wrapper. Prefer process_many for anything above a few posts."""
    return process_many([text], [lang])[0]


def process_many(texts: list[str], langs: list[str]) -> list[NLPFeatures]:
    """Annotate a batch, grouping by model so each pipeline runs once.

    Results come back in the same order as `texts`.
    """
    settings = get_settings()
    results: list[NLPFeatures | None] = [None] * len(texts)

    groups: dict[str, list[int]] = {}
    for idx, (text, lang) in enumerate(zip(texts, langs)):
        if not text.strip():
            results[idx] = NLPFeatures(processed=False, spacy_model="")
            continue
        groups.setdefault(model_for_language(lang), []).append(idx)

    for model_name, indices in groups.items():
        try:
            nlp = get_pipeline(model_name)
        except OSError:
            # model not downloaded - say so instead of emitting empty features
            for idx in indices:
                results[idx] = NLPFeatures(processed=False, spacy_model=model_name)
            continue

        batch = [texts[i] for i in indices]
        docs = nlp.pipe(
            batch,
            batch_size=settings.spacy_batch_size,
            n_process=settings.spacy_n_process,
        )
        for idx, doc in zip(indices, docs):
            results[idx] = _to_features(doc, model_name)

    return [r if r is not None else NLPFeatures(processed=False) for r in results]
