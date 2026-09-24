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
        settings.llm.batch_size = 25   # fewer, larger MiniMax escalation calls = faster runs
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

class TransformersEmbedder:
    """Same model and pooling as sentence-transformers (mean pooling + L2 norm), using transformers only.
    Used when sentence-transformers cannot import (e.g. Windows Application Control blocks scipy/sklearn DLLs)."""
    def __init__(self, model_path, cache_dir, local_only):
        from transformers import AutoModel, AutoTokenizer
        self.tokenizer = AutoTokenizer.from_pretrained(model_path, cache_dir=cache_dir, local_files_only=local_only)
        self.model = AutoModel.from_pretrained(model_path, cache_dir=cache_dir, local_files_only=local_only).eval()
    def encode(self, texts, normalize_embeddings=True, show_progress_bar=False):
        import numpy as np
        import torch
        out = []
        with torch.no_grad():
            for i in range(0, len(texts), 32):
                batch = self.tokenizer(list(texts[i:i+32]), padding=True, truncation=True, max_length=128, return_tensors='pt')
                hidden = self.model(**batch).last_hidden_state
                mask = batch['attention_mask'].unsqueeze(-1).float()
                vectors = (hidden * mask).sum(1) / mask.sum(1).clamp(min=1e-9)
                if normalize_embeddings:
                    vectors = torch.nn.functional.normalize(vectors, p=2, dim=1)
                out.append(vectors.numpy())
        return np.concatenate(out) if out else np.zeros((0, 384))

class HostedEmbedder:
    """Same multilingual MiniLM model via the Hugging Face Inference API (no torch in memory)."""
    def __init__(self, token):
        self.token = token
        self.url = os.environ.get('HF_INFERENCE_URL', 'https://router.huggingface.co/hf-inference/models/') + embedding_name + '/pipeline/feature-extraction'
    def encode(self, texts, normalize_embeddings=True, show_progress_bar=False):
        import numpy as np
        import requests
        out = []
        for i in range(0, len(texts), 32):
            response = requests.post(self.url, timeout=90, headers={'Authorization': f'Bearer {self.token}'},
                                     json={'inputs': [t[:1000] for t in texts[i:i+32]], 'options': {'wait_for_model': True}})
            response.raise_for_status()
            for item in response.json():
                vector = np.asarray(item, dtype='float32')
                if vector.ndim == 2:            # token vectors: mean-pool like sentence-transformers
                    vector = vector.mean(0)
                if normalize_embeddings:
                    vector = vector / (np.linalg.norm(vector) or 1)
                out.append(vector)
        return np.asarray(out) if out else np.zeros((0, 384), dtype='float32')

def embedding_model():
    global embedder
    if embedder is None:
        model_cache = os.environ.get('ARGUS_MODEL_CACHE', str(Path(os.environ['ARGUS_RUNTIME']) / 'models'))
        local_model = Path(__file__).resolve().parents[3] / 'work' / 'multilingual-model'
        model_path = os.environ.get('ARGUS_EMBEDDING_PATH') or (str(local_model) if (local_model / 'model.safetensors').exists() else embedding_name)
        local_only = Path(model_path).is_dir()
        try:
            from sentence_transformers import SentenceTransformer
            embedder = SentenceTransformer(model_path, cache_folder=model_cache, local_files_only=local_only)
        except ImportError as exc:
            try:
                embedder = TransformersEmbedder(model_path, model_cache, local_only)
                print('sentence-transformers unavailable (%s); using transformers mean pooling.' % exc, file=sys.stderr)
            except ImportError:
                if not os.environ.get('HF_TOKEN'):
                    raise RuntimeError('No local embedding model and HF_TOKEN is not set.')
                print('No local torch; using the Hugging Face Inference API for embeddings.', file=sys.stderr)
                embedder = HostedEmbedder(os.environ['HF_TOKEN'])
    return embedder

STOPWORDS = set("""a about above after again against all am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its itself just me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours also get got like one really even still much many well yes oh ok bro sir""".split())

def fallback_clusters(texts, vectors, min_size=3, threshold=0.5):
    """Pure-numpy topic discovery for when BERTopic/scikit-learn cannot load:
    cosine community detection on the embeddings, outliers = -1, c-TF-IDF keywords per cluster."""
    import numpy as np
    n = len(texts)
    sims = vectors @ vectors.T
    labels = np.full(n, -1)
    for i in np.argsort(-(sims >= threshold).sum(1)):
        if labels[i] != -1:
            continue
        members = [j for j in np.where(sims[i] >= threshold)[0] if labels[j] == -1]
        if len(members) >= min_size:
            labels[members] = labels.max() + 1
    probs = np.zeros(n)
    docs = {}
    for c in set(labels.tolist()) - {-1}:
        idx = np.where(labels == c)[0]
        centroid = vectors[idx].mean(0)
        centroid /= np.linalg.norm(centroid) or 1
        probs[idx] = vectors[idx] @ centroid
        docs[c] = [w for i in idx for w in re.findall(r'\w+', texts[i].lower()) if len(w) > 2 and not w.isdigit() and w not in STOPWORDS]
    total = {}
    for words in docs.values():
        for w in words:
            total[w] = total.get(w, 0) + 1
    avg = (sum(len(w) for w in docs.values()) / len(docs)) if docs else 1
    keywords = {}
    for c, words in docs.items():
        tf = {}
        for w in words:
            tf[w] = tf.get(w, 0) + 1
        ranked = sorted(tf, key=lambda w: -tf[w] * np.log(1 + avg / total[w]))
        keywords[c] = ranked[:4]
    return labels.tolist(), probs.tolist(), keywords

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
    try:
        from bertopic import BERTopic
        from sklearn.decomposition import PCA
        from sklearn.cluster import HDBSCAN
        from sklearn.feature_extraction.text import CountVectorizer
    except ImportError as exc:
        print('BERTopic unavailable (%s); using embedding community fallback.' % exc, file=sys.stderr)
        ids, probabilities, keywords = fallback_clusters(texts, vectors)
        for post, topic_id, probability in zip(posts, ids, probabilities):
            post['topic'] = 'Unclustered / outliers' if topic_id == -1 else (' · '.join(keywords.get(topic_id) or []) or f'Topic {topic_id + 1} (keywords unavailable)')
            post['topic_id'] = int(topic_id)
            post['topic_source'] = 'Embedding clusters'
            post['topic_probability'] = float(probability) if topic_id != -1 else None
        return {'posts': posts, 'status': 'Topics used embedding community clustering because BERTopic/scikit-learn is blocked on this PC (Windows Application Control).'}
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
