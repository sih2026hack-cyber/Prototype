# ARGUS — Module 5: Lexical + NLP Layer

Turns a raw social-media post into structured features the rest of ARGUS reads.

**Problem statement:** SIH26152 — Social Media Analytics.
**This module:** preprocessing, regex/lexical extraction, language ID, tokenisation,
lemmatisation, POS, NER, sentiment (VADER → MiniMax), and a versioned output contract.

**Not this module:** embeddings, BERTopic, topic modelling — that's Module 6.
The only thing owed to it is clean text and tokens in an agreed shape.

---

## Setup

Requires **Python 3.12**. Not 3.13 or 3.14 — spaCy's `thinc` dependency has no
build for them, so `pip install spacy` fails outright.

```bash
py -3.12 -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt
.venv/Scripts/python.exe -m spacy download en_core_web_sm
.venv/Scripts/python.exe -m spacy download xx_ent_wiki_sm
```

Then copy `.env.example` to `.env` and set `ARGUS_HASH_SALT`. `MINIMAX_API_KEY`
is optional — see [Degraded mode](#degraded-mode).

### Which MiniMax endpoint

MiniMax runs two separate platforms and a key issued for one is rejected by
the other — with **HTTP 200** and `{"base_resp":{"status_code":2049}}`, not a
401, so it looks like a malformed response rather than an auth failure.

| account | `MINIMAX_BASE_URL` host |
|---|---|
| international (default) | `api.minimax.io` — also `api.minimaxi.chat` |
| China | `api.minimax.chat` |

If you see `LLMConfigError: MiniMax rejected the request (2049)`, you are on
the wrong host. Switch it in `config.yaml` or `.env`.

```bash
.venv/Scripts/python.exe -m pytest
```

---

## Use it

```python
from argus_nlp.pipeline import Pipeline
from argus_nlp.schema import PostInput

pipeline = Pipeline()
results = pipeline.process_batch([
    PostInput(post_id="1", source="youtube",
              original_text="Heavy flooding in Thoothukudi. NDRF deployed."),
])

r = results[0]
r.sentiment.label            # "negative"
r.sentiment.source           # "vader" - which tier answered
r.nlp.entities               # [Entity(text="Thoothukudi", label="GPE", source="gazetteer"), ...]
r.risk.has_risk              # False
r.language.primary_lang      # "en"
```

Always prefer `process_batch` over `process` — it groups the spaCy work and the
API calls. Per-post calls on a large corpus are the difference between minutes
and hours.

### Command line

```bash
# process a file, write JSONL, print the cost report
.venv/Scripts/python.exe scripts/run_batch.py --input posts.jsonl --output out.jsonl --report

# write to Supabase instead
.venv/Scripts/python.exe scripts/run_batch.py --input posts.jsonl --sink supabase

# measure accuracy
.venv/Scripts/python.exe scripts/evaluate.py --dataset tests/fixtures/gold_posts.jsonl
.venv/Scripts/python.exe scripts/evaluate.py --dataset data/testdata.manual.2009.06.14.csv --n 500
.venv/Scripts/python.exe scripts/evaluate.py --dataset data/training.1600000.processed.noemoticon.csv --n 20000
```

The Sentiment140 files live in `data/` (gitignored, ~320 MB). To fetch them:

```bash
curl -L -o data/trainingandtestdata.zip https://cs.stanford.edu/people/alecmgo/trainingandtestdata.zip
cd data && unzip trainingandtestdata.zip
```

---

## The pipeline

```
0  INGEST     post_id, source, author_ref, timestamp carried through everything
1  GUARD      PII redaction · content hash · duplicate + media-only checks
2  LEXICAL    regex extraction WITH OFFSETS, over the original text
3  VARIANTS   mask those offsets -> analysis_text + nlp_text
4  LANGUAGE   script check + lingua -> gates VADER and spaCy
5  NLP        spaCy routed by language, batched, gazetteer NER
6  SENTIMENT  VADER -> escalation rules -> MiniMax
7  ASSEMBLE   versioned NLPResult -> Supabase
```

Note that **extraction (2) runs before cleaning (3)**. Cleaning first means
extracting from already-mangled text and losing the offsets that make precise
masking possible.

### Three text variants, not one

A single `clean_text` cannot serve both consumers, because they need opposite
things:

| | keeps | strips | read by |
|---|---|---|---|
| `original_text` | everything (PII redacted) | — | evidence, audit |
| `analysis_text` | **emoji, punctuation, CAPS** | URLs, mentions | VADER, MiniMax |
| `nlp_text` | **case**, expanded hashtags | URLs, mentions, emoji | spaCy, Module 6 |

Two of those rules were derived by measuring VADER rather than assuming, and
are locked down by tests in `tests/test_variants.py`:

- **Raw emoji are kept, not demojized.** VADER has its own emoji lexicon and
  scores the codepoint more strongly than the `:name:` form
  (`so sad 😢` = −0.776 vs `so sad :crying_face:` = −0.526).
- **Repeated punctuation gets a space before it.** Attached, it breaks VADER's
  token match on short words (`ok!!!` → 0.000, `ok` → 0.296); detached, both
  the match and the intensity boost survive (`ok !!!` → 0.472).

---

## Sentiment: two tiers and an explicit rule

VADER is English-only and does not tell you when it is out of its depth — it
returns `compound = 0.0` for a furious Hindi post, which looks exactly like a
genuine neutral on a dashboard. So language detection **gates** it.

Escalate to MiniMax when any of:

| reason | meaning |
|---|---|
| `non_english` | VADER cannot score it at all |
| `code_mixed` | romanised or mixed-script; the lexicon misses it |
| `low_language_conf` | not sure enough what language this is |
| `no_lexicon_match` | VADER matched no sentiment word — **the main cost dial** |
| `weak_signal` | it matched words, but they nearly cancel |
| `mixed_polarity` | strong positive and strong negative in one post |
| `sarcasm_marker` | phrasing suggests the literal reading is wrong |
| `risk_signals` | the moderator plugin needs an explanation anyway |

Never escalate: fewer than 2 tokens, empty/media-only, cache hit, daily cap hit.

Every decision records which rule fired, and `pipeline.escalation_report()`
aggregates them. That measured rate with reasons is the answer to "how do you
keep the cost down?" — it is not an assertion.

### The cost dial

`no_lexicon_match` covers two very different posts that look identical to
VADER: a factual announcement that really is neutral, and *"Heavy flooding in
Thoothukudi, NDRF deployed"* — plainly negative, but using no word VADER knows.
Nothing available to VADER separates them.

```bash
# measure it both ways on your own data before deciding
scripts/run_batch.py --input posts.jsonl --report
scripts/run_batch.py --input posts.jsonl --report --no-lexicon-escalation
```

On the bundled fixture that dial moves the escalation rate from **62.5% → 41.7%**.
On 20k real Sentiment140 tweets `no_lexicon_match` accounts for 4,960 of 9,540
escalations, so turning it off roughly halves the API spend.

Default is on, because for this problem statement missing a rising harmful
narrative is worse than an avoidable API call.

### Measured accuracy

Real numbers from `scripts/evaluate.py`, **LLM tier off** — so this is the
floor, what the module scores with no API key and no spend.

**Sentiment140 human-annotated test set** (498 tweets, 3-class, the fairer
benchmark since it actually contains neutral):

```bash
scripts/evaluate.py --dataset data/testdata.manual.2009.06.14.csv --n 500
```

| | accuracy | macro-F1 |
|---|---|---|
| **overall, 3-class** | **72.2%** | 0.719 |
| positive | P 0.676 · R 0.811 | 0.737 |
| negative | P 0.852 · R 0.650 | 0.737 |
| neutral | P 0.669 · R 0.699 | 0.683 |

**Sentiment140 training split** (20,000 tweets, sampled evenly from both
polarity halves — the file is sorted by label, so taking the first N gives a
100% negative corpus and a meaningless score):

| | value |
|---|---|
| coverage | 97.8% scored (2.0% unavailable, 0.2% media-only) |
| polarity-only accuracy | **71.9%** on the 73% where we committed to pos/neg |
| escalation rate | 47.7% |

The training split has **no neutral label**, so every neutral prediction counts
as wrong in a strict 3-class score (52.8%). That figure says more about the
dataset than the model, which is why `evaluate.py` prints the polarity-only
number and its coverage alongside it. Quote both or neither.

### Measured on the full human-annotated set

498 tweets, 3-class, hand-labelled. This is the headline number:

| | accuracy | macro-F1 |
|---|---|---|
| **overall** | **88.5%** | 0.884 |
| positive | P 0.888 · R 0.912 | 0.900 |
| negative | P 0.932 · R 0.859 | 0.894 |
| neutral | P 0.831 · R 0.885 | 0.857 |

95% CI is roughly ±2.8%, so call it "high 80s". Human annotators agree with
each other about 80% of the time on 3-class sentiment, so this is at the
label noise floor.

| tier | n | accuracy |
|---|---|---|
| transformer (tier 1) | 386 | 89.9% |
| escalated to MiniMax | 112 | 83.9% |

### Tier 1 is a transformer, not VADER

VADER is a hand-built lexicon from 2014. `twitter-roberta-base-sentiment-latest`
is RoBERTa fine-tuned on ~124M tweets for this exact task. Benchmarked head to
head on the same 498 posts:

| tier 1 | tier 1 alone | escalation needed | overall |
|---|---|---|---|
| VADER | 72.1% | 60% | 86.1% |
| **roberta** | **86.6%** | **22%** | **88.5%** |

It wins on both axes at once. roberta is not merely more accurate - it is
right far more often, so the paid tier is needed on a fifth of posts rather
than two thirds. Running the LLM on *everything* scores 85.5%, worse than
either hybrid, so routing is still the correct architecture.

VADER remains as an automatic fallback. If torch or the weights are missing
the pipeline logs a warning and keeps working, and `sentiment.source` records
which tier actually answered every row.

**Both models are English-only.** Neither reads Tanglish. Non-English and
code-mixed posts still route to the LLM - that gate is unchanged and is why
the LLM tier exists at all.

### Escalation is driven by the model's own confidence

roberta is well calibrated, which is what makes a cheap escalation rule work:

| confidence | n | correct |
|---|---|---|
| 0.50 – 0.70 | 74 | 59% |
| 0.70 – 0.85 | 107 | 85% |
| 0.85 – 0.95 | 180 | 93% |
| 0.95+ | 121 | 98% |

Below 0.60 it is guessing, so that is the floor (`model_confidence_floor`).
Split-half validated: one half peaks at 0.60 and the other at 0.80, so the
exact value is noise, but everything in that band beat both "never escalate"
and "always escalate".

The lexicon-era rules (`no_lexicon_match`, `weak_signal`, `mixed_polarity`)
do not apply to a transformer - there is no lexicon to miss - and are used
only on the VADER fallback path.

### Sentiment is not the same question as "is something bad happening"

Tuning the prompt to score factual reporting as neutral was worth ~6 points on
the benchmark, and it is *correct* - but it broke the thing ARGUS is for:

```
"Heavy flooding in Thoothukudi. NDRF teams deployed to the area."
    sentiment: neutral      <- right; the writer states a fact, offers no view
```

A dashboard filtering on negative sentiment would never show that post. Two
different questions had been crammed into one field:

| field | question | this post |
|---|---|---|
| `sentiment` | how does the writer feel? | neutral |
| `event.polarity` | is something bad happening? | **negative, severity 0.85** |

So they are separate. Mood charts read `sentiment`; trend and alerting views
read `event`. Every match is reported by name (`flooding`, `ndrf`) because a
bare severity score is not auditable evidence.

`event` is computed **lexically on every post**, not through the LLM. Only ~22%
of posts escalate, so an LLM-only signal would leave four fifths of the corpus
blank. Asking the LLM for it as well was measured and rejected: it cost 3
points on the escalated tier (83.9% → 80.9%) to refine a signal the keyword
pass already had, on a fifth of the data.

### Every escalation rule pays for itself

How often an escalated post ends up correct, against a ~14% overall error rate:

| rule | fired | correct |
|---|---|---|
| `code_mixed` / `non_english` | 10 | 100% |
| `risk_signals` | 34 | 91% |
| `no_lexicon_match` | 140 | 90% |
| `low_language_conf` | 27 | 89% |
| `weak_signal` | 55 | 85% |
| `question` | 61 | 84% |

### Why route at all, rather than send everything to the LLM

| configuration | accuracy | cost |
|---|---|---|
| VADER only | 72.1% | free, instant |
| **hybrid** | **86.1%** | ~60% escalated, 8s |
| all-LLM | 85.5% | 498 calls, 306s |

Hybrid and all-LLM are **statistically indistinguishable** - the gap is a
handful of posts, well inside the confidence interval. The honest argument for
routing is therefore cost, not accuracy: the same result for half the API
calls and 38x less wall-clock.

The large, robust finding is the first row. Going from VADER alone to any LLM
configuration is worth ~14 points. Choosing between LLM configurations is
worth almost nothing.

### Setting the threshold: VADER knows when it is guessing

VADER turns out to be well calibrated - accuracy rises monotonically with
`|compound|`:

| VADER `compound` (abs) | n | VADER correct |
|---|---|---|
| 0.30 – 0.45 | 38 | 66% |
| 0.45 – 0.60 | 59 | 80% |
| 0.60 – 0.75 | 61 | 82% |
| 0.75 – 0.90 | 58 | 91% |
| 0.90+ | 15 | 100% |

MiniMax averages ~87%, so anything VADER scores below ~0.75 is a post the LLM
handles better. `weak_compound` is set to **0.45** on that basis, up from an
initial guess of 0.35.

Split-half validation matters here: one half of the data peaks at 0.70, the
other at 0.45, so the exact optimum is noise - but *every* value in 0.45-0.75
beat 0.35 on **both** halves, which is the finding worth acting on. Sweep it
on your own data with `scripts/tune_escalation.py`, which replays cached LLM
answers against any policy for free.

### What moved the number

Nothing here is a model change - MiniMax is used as-is, untrained.

| change | accuracy |
|---|---|
| VADER alone | 72.1% |
| + MiniMax on escalated posts (prompt `v1`) | ~76% |
| + prompt `v2`: reporting something is neutral | ~82% |
| + escalate questions | ~85% |
| + prompt `v3`: describing an activity is not sentiment | ~86% |
| + `weak_compound` 0.35 → 0.45 | **86.1%** |

The intermediate figures were measured on a 200-post subset and each carries
±5%; only the final row is measured on all 498. Two conclusions drawn from
that smaller sample - that all-LLM was *worse*, and that `weak_signal` earned
nothing - did **not** replicate on the full set and have been corrected above.
Small samples flatter whichever configuration you tuned on them.

### Does the routing work?

This is the number worth putting on a slide. Same run, split by which tier
answered:

| tier | n | accuracy |
|---|---|---|
| answered by VADER, not escalated | 10,307 | **74.9%** (75.1% polarity-only) |
| escalated, LLM unavailable | 9,254 | 28.2% (64.0% polarity-only) |

The gap is the whole argument: the posts VADER is allowed to keep are the ones
it gets right, and the ones it routes away are the ones it gets wrong. The
escalation rules are selecting correctly — and that second row is the headroom
a MiniMax key buys you.

### Degraded mode

With no `MINIMAX_API_KEY` the pipeline still runs end to end. English posts keep
their VADER scores; escalated ones are marked `vader_llm_failed`; non-English
posts are reported as `unavailable` — **not** given a fabricated neutral. A
visible gap in the dashboard beats a wrong number nobody notices.

So a network failure at the demo degrades this module rather than killing it.

---

## Output contract

`argus_nlp/schema.py` is the interface. Treat it as frozen — if a field must
change, bump `SCHEMA_VERSION` and tell the team.

```bash
.venv/Scripts/python.exe -c "import sys; sys.path.insert(0,'.'); \
from argus_nlp.schema import NLPResult; import json; \
print(json.dumps(NLPResult.model_json_schema(), indent=2))" > schema.json
```

Who reads what:

| module | reads |
|---|---|
| 2 — dashboard | `sentiment_*`, `primary_lang`, `nlp.entities`, `timestamp` |
| 3 — chatbot | same, plus `original_text` as evidence |
| 4 — moderator | `risk`, `lexical`, `sentiment.emotions`, `sentiment.llm_rationale` |
| 6 — embeddings | `nlp_text`, `nlp.tokens`, `nlp.lemmas`, `content_hash` |

The real hand-off is the `posts_nlp` table, not a Python dict — run
`argus_nlp/io/schema.sql` in the Supabase SQL editor. Writes are upserts on
`post_id`, so re-running corrects rows instead of duplicating them.

---

## Privacy

- Emails, phone numbers and Aadhaar-shaped numbers are replaced with
  placeholders **before** anything is stored or sent to MiniMax.
- Author handles are stored only as a salted SHA-256 hash. Keep
  `ARGUS_HASH_SALT` stable — the network module joins on those hashes.
- RLS is enabled on `posts_nlp` by the schema; add policies to match how the
  dashboard authenticates.

---

## Known limits

Worth saying out loud rather than being caught on:

- **lingua mislabels romanised code-mix.** Tanglish comes back as Malay at 0.66.
  The label is wrong but the confidence is honest, and low confidence is what
  triggers escalation — so the routing is right even when the label is not.
- **`xx_ent_wiki_sm` is weak on Indic scripts.** It tags common Hindi nouns as
  `MISC`. Entities from non-English posts should be treated as low-confidence.
- **The gazetteer is a starter list.** ~50 entries covering South Indian
  districts, states and central agencies. Extend `resources/gazetteer.jsonl`
  with a reviewed list; it is the cheapest quality win available.
- **The harm lexicon is deliberately small and explainable.** It reports which
  term matched. It is a signal for Module 4, not a moderation verdict.
- **MiniMax vs Claude.** The team's `SIH26152 – Technical Architecture.docx`
  argues for Claude on data-sovereignty grounds for an NTRO-sponsored problem
  statement. MiniMax is the current choice; the `LLMClient` boundary keeps the
  swap a config change. Expect the question.
