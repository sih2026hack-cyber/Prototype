# Running ARGUS

Run `npm start` in this folder and open http://localhost:8787. The active backend is `live-server.mjs`; the older FastAPI scaffold is not the running application.

The local .env points to the existing NLP project's credentials and Python package paths. Keys are used only on the server. Do not publish the .env or data/runtime folder.

The collector uses YouTube's official public-comment API. Collection time differs from comment publication time: freshly collected comments can be older. The source query is configured in .env.

Each ingestion passes comments through Module 5 in E:/NLP and NER processing, then creates multilingual Sentence Transformer embeddings and BERTopic clusters in backend/live_worker.py. The existing NLP result contract is stored in Supabase posts_nlp. model_versions records whether RoBERTa actually ran; sentiment.source records the final decision source, including MiniMax escalation or a fallback.

The dashboard refreshes every four seconds while visible. Sample comments are excluded whenever live comments exist. Four or fewer usable comments may not provide reliable topic clusters; outliers are retained as unclustered.

ARGUS_MODEL_CACHE uses a short workspace path because Windows model-download paths can exceed the path limit. The topic environment needs cloudpickle as well as Sentence Transformers, BERTopic and their dependencies. Initial model loading/downloads take longer than subsequent runs.

Supabase posts_nlp is already available in the configured project. A project owner must run supabase/live-extension.sql to create source metadata, vector, chat-evidence and moderator-history storage. Until then, these extra results remain in the local runtime cache; the dashboard reports metadata as pending. The service-role key provides API access but does not grant your account access to the Supabase dashboard.

The moderator is an optional composer plugin at the bottom of the dashboard. It reuses scoring prompts from E:/AI Moderator and never posts a message externally.
