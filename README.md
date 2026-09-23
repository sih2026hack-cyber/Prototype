# ARGUS — audience intelligence prototype

ARGUS turns public YouTube comments into a privacy-aware dashboard and an evidence-backed chatbot. Paste a YouTube video or channel link and ARGUS collects a bounded sample of public comments and replies, analyses them, and shows:

- **Sentiment and emotions**: RoBERTa sentiment with MiniMax escalation, plus estimated emotions.
- **Audience profile**: participation (unique and repeat commenters, replies, time of day in IST), comment languages, and optional age, gender and country data imported from YouTube Studio or a voluntary survey.
- **Trends and topics**: multilingual Sentence Transformer embeddings and BERTopic clusters, summarised by MiniMax.
- **Network**: observed reply and participation links.
- **Ask ARGUS**: a chatbot that answers from the collected evidence and links its sources.
- **PDF report** and an optional **writing plugin** that checks grammar and safety.

## Run it

Requires Node.js 20+.

```powershell
npm start
```

Open http://localhost:8787. `live-server.mjs` is the active backend. The files in `backend/` are the Python NLP worker, the PDF report and an older FastAPI scaffold.

```powershell
npm test
```

See [RUNNING.md](RUNNING.md) for environment setup and [VERIFICATION.md](VERIFICATION.md) for implementation notes.

## Configuration

Copy `.env.example` to `.env`. Keys stay on the server and are never sent to the browser. Never commit `.env`, `data/runtime/` or `data/moderation_decisions.jsonl`; they are already listed in `.gitignore`.

## Abusive language

Public comments can contain profanity and slurs. ARGUS keeps the original text in storage for analysis, but everything it shows (topic titles and summaries, comments, chatbot answers and the PDF) passes through `lib/profanity.mjs`. That module masks abusive words in English, Hindi (romanised) and Tamil (romanised and Tamil script), for example `k****`. Topics and comments containing masked words carry a "Contains abusive language · masked" tag. The topic-summary prompt also tells MiniMax to describe insults rather than quote or translate them.

To add words, edit `STEMS` (these also match inflected forms) or `EXACT` (whole words only) in `lib/profanity.mjs`, then run `npm test`.

## Demographics and privacy

ARGUS **does not infer** age, gender, religion, caste, ethnicity or location from comments or usernames. Commenters are stored as salted hashes.

- **From comments (automatic):** unique and repeat commenters, top-level vs reply share, time of day in IST, and detected language.
- **Age, gender and country (import):** open *Audience → Add age, gender & country data* and upload either:
  - YouTube Studio CSV exports (Analytics → Advanced mode → Audience → *Viewer age*, *Viewer gender*, *Geography*). You must own or manage the channel.
  - Voluntary survey totals, using the downloadable `dimension,label,count` template.

Only aggregate totals are stored, and groups smaller than 10 people are hidden. The imported population is shown separately from the commenter sample.
