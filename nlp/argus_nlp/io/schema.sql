-- ARGUS Module 5 output table.
-- Run once in the Supabase SQL editor. Modules 2, 3, 4 and 6 read from here.
--
-- Columns the dashboard filters and sorts on are real columns so they can be
-- indexed; the heavy per-post detail stays in JSONB.

create table if not exists posts_nlp (
    post_id                text primary key,
    schema_version         text        not null,
    source                 text        not null,
    author_ref_hash        text,                 -- salted hash, never a raw handle
    timestamp              timestamptz,
    parent_id              text,
    content_hash           text        not null,
    is_duplicate           boolean     not null default false,

    original_text          text,                 -- PII already redacted
    analysis_text          text,                 -- what the sentiment tier read
    nlp_text               text,                 -- what spaCy read; Module 6 uses this

    primary_lang           text,
    lang_confidence        real,
    is_code_mixed          boolean     not null default false,

    sentiment_label        text,                 -- positive|negative|neutral|unavailable
    sentiment_score        real,
    sentiment_confidence    real,
    sentiment_source       text,                 -- vader|minimax|vader_llm_failed|unavailable|skipped_empty
    emotions               jsonb       not null default '[]'::jsonb,
    escalated              boolean     not null default false,
    escalation_reasons     jsonb       not null default '[]'::jsonb,

    has_risk               boolean     not null default false,
    aggression_score       real,

    -- event polarity: NOT the same question as sentiment. A flood report is
    -- sentiment-neutral (the writer states a fact) but event-negative, and the
    -- alerting views filter on this, not on sentiment_label.
    event_polarity         text,                 -- negative|positive|none
    event_severity         real,

    lexical                jsonb,
    risk                   jsonb,
    event                  jsonb,
    pii                    jsonb,
    nlp                    jsonb,                -- tokens, lemmas, entities
    sentiment              jsonb,

    model_versions         jsonb,
    processed_at           timestamptz not null default now(),
    errors                 jsonb       not null default '[]'::jsonb
);

-- dashboard: sentiment over time, per source
create index if not exists posts_nlp_timestamp_idx    on posts_nlp (timestamp desc);
create index if not exists posts_nlp_source_time_idx  on posts_nlp (source, timestamp desc);
create index if not exists posts_nlp_sentiment_idx    on posts_nlp (sentiment_label);
create index if not exists posts_nlp_lang_idx         on posts_nlp (primary_lang);

-- alerting: negative events, worst first. This is the query the dashboard's
-- "what is going wrong right now" view runs.
create index if not exists posts_nlp_event_idx
    on posts_nlp (event_polarity, event_severity desc, timestamp desc)
    where event_polarity = 'negative';

-- moderator plugin: pull risky posts fast
create index if not exists posts_nlp_risk_idx on posts_nlp (has_risk)
    where has_risk = true;

-- cost reporting: how often did we escalate, and why
create index if not exists posts_nlp_escalated_idx on posts_nlp (escalated)
    where escalated = true;

-- Module 6: group identical posts without re-embedding them
create index if not exists posts_nlp_content_hash_idx on posts_nlp (content_hash);

-- entity search from the chatbot
create index if not exists posts_nlp_entities_idx on posts_nlp using gin ((nlp -> 'entities'));

-- Row Level Security. Enable it, then add policies to match how the dashboard
-- authenticates - with RLS on and no policy, nothing is readable, which is the
-- correct default to start from.
alter table posts_nlp enable row level security;
