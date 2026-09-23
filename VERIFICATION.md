# ARGUS implementation notes

Start with `npm start` in this folder and open http://localhost:8787/.

## Public YouTube collection

The collector uses the official YouTube Data API. It retrieves up to three search-selected videos, their titles/descriptions/tags/public statistics, and a bounded sample of comments and replies. The comment limit is shared across the selected videos. It follows pagination within that limit; it does not claim to collect every comment. Repeated runs deduplicate source IDs and refresh public metrics. Prior records remain in a corpus capped at 500 items.

Video text is analysed like comment text. Audience sentiment and language charts only use comments and replies. Video views, likes and the platform's total comment counts are displayed separately. The source graph shows known video/comment links; it does not infer a propagation network.

## Analysis and topics

`backend/live_worker.py` calls the existing NLP project on E:. RoBERTa is the preferred sentiment tier, with MiniMax escalation where required. The result's actual sentiment source remains visible in its stored NLP contract. The civic chart displays gazetteer-grounded places and organisations; unrestricted model entities remain in the underlying NLP record. Low-confidence or mixed-language detections are grouped as uncertain in audience summaries.

Sentence Transformers uses `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` to encode text as 384-dimensional normalized vectors. The local official model is downloaded with `node backend/download-model.mjs`, which checks the model's SHA-256. BERTopic receives those vectors, uses PCA (up to five components), HDBSCAN (minimum cluster size three), and English-stopword CountVectorizer/c-TF-IDF for word-based labels. Topic -1 means unclustered/outlier; it is excluded from the discovered-topic count. This small sample does not establish population-wide opinions or demographic distributions.

## Storage and remaining setup

Existing `posts_nlp` receives the frozen NLP contract and is read back to verify record counts and sentiment. `argus_post_details` stores source/video metadata, public metrics, embeddings and topic membership. `moderation_logs` and `chat_evidence` store writing checks and answer references.

The project owner must run `supabase/live-extension.sql` in the configured Supabase project's SQL editor. A service-role REST key cannot create these missing tables. The migration enables row-level security and grants access only to the server service role. After applying it, use **Retry Supabase sync** in the pipeline panel to upload the retained corpus and local logs. The dashboard explicitly distinguishes verified NLP rows from pending metadata.

## Chat and writing plugin

The chatbot calls MiniMax with current dataset aggregates, selected source records and conversation history. Smaller corpora are supplied in full; larger corpora use embedding similarity. Answers return validated source links. The writing plugin runs a local context warning as the draft changes, then calls MiniMax after a pause. It records checked draft versions, rather than individual keystrokes. Suggestions require user acceptance. Checks remain local when the Supabase log table is unavailable; the interface states this.

Collective age/gender analytics require an authorized platform analytics export or opt-in survey. Religion and other sensitive demographics are not inferred from names or comments. Missing distributions are marked unavailable.
