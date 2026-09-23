"""Print model-load diagnostics locally, without collecting posts or credentials."""
import os
import time
import traceback
import faulthandler
faulthandler.dump_traceback_later(120, repeat=True)
os.environ['HF_HUB_DISABLE_XET'] = '1'
os.environ['HF_HUB_DOWNLOAD_TIMEOUT'] = '45'
print('Importing Sentence Transformers', flush=True)
try:
    from sentence_transformers import SentenceTransformer
    print('Loading multilingual model', flush=True)
    model = SentenceTransformer('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2', cache_folder=os.environ['ARGUS_MODEL_CACHE'])
    print('Loaded; vector dimensions:', model.encode(['Flooding in Chennai']).shape, flush=True)
except Exception:
    traceback.print_exc()
