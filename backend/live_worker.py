"""JSON-lines worker. Existing Module 5 remains unchanged on E:.

All stdout is protocol-only; third-party model progress goes to stderr.
"""
import contextlib
import json
import hashlib
import os
from pathlib import Path
import re
import sys

pipeline = None
embedder = None
embedding_name = 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2'

def get_pipeline():
    global pipeline
    if pipeline is None:
        from argus_nlp.config import Settings
        from argus_nlp.pipeline import Pipeline
        settings = Settings.load()
        settings.cache_path = Path(os.environ['ARGUS_RUNTIME']) / 'nlp_cache.sqlite'
        settings.use_transformer_tier1 = True
        settings.llm.max_retries = 1
        settings.llm.timeout_s = 80
        settings.llm.daily_call_cap = 200
        pipeline = Pipeline(settings)
    return pipeline

def fallback_entities(text):
    # Exact phrase gazetteer is genuine dictionary NER, not a simulated model.
    from argus_nlp.config import RESOURCES
    from argus_nlp.schema import Entity
    entities = []
    for line in (RESOURCES / 'gazetteer.jsonl').read_text(encoding='utf8').splitlines():
        if not line.strip() or line.startswith('//'):
            continue
        item = json.loads(line)
        if not isinstance(item.get('pattern'), str):
            continue
        for match in re.finditer(r'(?<!\w)' + re.escape(item['pattern']) + r'(?!\w)', text, re.I):
            entities.append(Entity(text=match.group(), label=item['label'], start=match.start(), end=match.end(), source='gazetteer'))
    return entities

def embedding_model():
    global embedder
    if embedder is None:
        from sentence_transformers import SentenceTransformer
        model_cache = os.environ.get('ARGUS_MODEL_CACHE', str(Path(os.environ['ARGUS_RUNTIME']) / 'models'))
        local_model = Path(__file__).resolve().parents[3] / 'work' / 'multilingual-model'
        model_path = os.environ.get('ARGUS_EMBEDDING_PATH') or (str(local_model) if (local_model / 'model.safetensors').exists() else embedding_name)
        embedder = SentenceTransformer(model_path, cache_folder=model_cache, local_files_only=Path(model_path).is_dir())
    return embedder

def analyze(posts):
    from argus_nlp.schema import PostInput
    from argus_nlp.io.supabase_sink import to_row
    results = get_pipeline().process_batch([PostInput(post_id=p['id'], source=p['source'], original_text=p['text'], author_ref=None, timestamp=p.get('created_at'), parent_id=p.get('parent_id'), lang_hint=p.get('lang')) for p in posts])
    for post, result in zip(posts, results):
        result.model_versions['tier1'] = getattr(get_pipeline(), '_tier1', 'unknown')
        if result.model_versions['tier1'] == 'transformer':
            result.model_versions['transformer'] = get_pipeline().settings.transformer_model
        # Collector already uses a salted HMAC; never reintroduce raw authors.
        result.author_ref_hash = post.get('author_ref')
        if not result.nlp.processed:
            result.nlp.entities = fallback_entities(result.nlp_text)
            post['entity_source'] = 'gazetteer (spaCy unavailable)'
        else:
            post['entity_source'] = 'spaCy + gazetteer'
        post.update(nlp_row=to_row(result), text=result.original_text, nlp_text=result.nlp_text,
                    lang=result.language.primary_lang, sentiment=result.sentiment.model_dump(mode='json'),
                    entities=[e.model_dump() for e in result.nlp.entities],
                    event_polarity=result.event.model_dump(mode='json'), is_seed=post.get('is_seed', False) or post.get('source') == 'seed')
    return posts

def topics(posts):
    texts = [p.get('nlp_text') or p['text'] or '[empty]' for p in posts]
    import numpy as np
    hashes = [hashlib.sha256(text.encode('utf-8')).hexdigest() for text in texts]
    missing = [i for i,p in enumerate(posts) if len(p.get('embedding') or []) != 384 or p.get('embedding_source') != embedding_name or p.get('embedding_text_hash') != hashes[i]]
    if missing:
        encoded = embedding_model().encode([texts[i] for i in missing], normalize_embeddings=True, show_progress_bar=False)
        for i, vector in zip(missing, encoded):
            posts[i]['embedding'] = vector.tolist()
            posts[i]['embedding_source'] = embedding_name
            posts[i]['embedding_text_hash'] = hashes[i]
    vectors = np.asarray([p['embedding'] for p in posts])
    for post in posts:
        for field in ['topic', 'topic_id', 'topic_source', 'topic_probability', 'topic_summary']:
            post.pop(field, None)
    if len(posts) < 5:
        return {'posts': posts, 'status': 'Need at least five posts for topic clustering.'}
    from bertopic import BERTopic
    from sklearn.decomposition import PCA
    from sklearn.cluster import HDBSCAN
    from sklearn.feature_extraction.text import CountVectorizer
    # PCA is a supported BERTopic reducer; deterministic and suitable for a tiny demo corpus.
    model = BERTopic(embedding_model=None, umap_model=PCA(n_components=min(5, len(posts)-1), random_state=42),
                    hdbscan_model=HDBSCAN(min_cluster_size=3, min_samples=2),
                    vectorizer_model=CountVectorizer(stop_words='english', token_pattern=r'(?u)\b\w+\b'), verbose=False)
    ids, probabilities = model.fit_transform(texts, vectors)
    for i, (post, topic_id) in enumerate(zip(posts, ids)):
        words = [word.strip() for word, _ in (model.get_topic(topic_id) or []) if word.strip()][:4]
        post['topic'] = 'Unclustered / outliers' if topic_id == -1 else (' · '.join(words) or f'Topic {topic_id + 1} (keywords unavailable)')
        post['topic_id'] = int(topic_id)
        post['topic_source'] = 'BERTopic'
        post['topic_probability'] = float(probabilities[i]) if probabilities is not None and getattr(probabilities, 'ndim', 1) == 1 else None
    return {'posts': posts, 'status': 'BERTopic + multilingual Sentence Transformers'}

for line in sys.stdin:
    try:
        request = json.loads(line)
        with contextlib.redirect_stdout(sys.stderr):
            if request['action'] == 'analyze':
                output = analyze(request['posts'])
            elif request['action'] == 'topics':
                output = topics(request['posts'])
            elif request['action'] == 'embed':
                output = embedding_model().encode([request['text']], normalize_embeddings=True, show_progress_bar=False)[0].tolist()
            else:
                raise ValueError('Unknown action')
        print(json.dumps({'id': request['id'], 'result': output}, ensure_ascii=True), flush=True)
    except Exception as exc:
        print(json.dumps({'id': request.get('id'), 'error': type(exc).__name__ + ': ' + str(exc)[:350]}, ensure_ascii=True), flush=True)
