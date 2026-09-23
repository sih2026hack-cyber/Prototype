-- Run in the ARGUS project's SQL editor. Safe for a new project or an existing setup.
-- Creates missing tables without deleting data or changing the NLP row contract.
-- ARGUS Module 5 output table.
-- Run once in the Supabase SQL editor. Modules 2, 3, 4 and 6 read from here.
--
-- Columns the dashboard filters and sorts on are real columns so they can be
-- indexed; the heavy per-post detail stays in JSONB.

create table if not exists public.posts_nlp (
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
    sentiment_source       text,                 -- transformer|minimax|unavailable|skipped_empty
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
revoke all on public.posts_nlp from anon, authenticated;
grant all on public.posts_nlp to service_role;

create extension if not exists vector with schema extensions;

create table if not exists argus_post_details (
  post_id text primary key,
  source text not null,
  source_url text,
  created_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  topic text,
  topic_source text,
  analysis jsonb not null default '{}'::jsonb,
  embedding_model text,
  embedding extensions.vector(384),
  updated_at timestamptz not null default now()
);

create index if not exists argus_post_details_topic_idx on argus_post_details(topic);
create index if not exists argus_post_details_created_idx on argus_post_details(created_at desc);

create table if not exists chat_evidence (
  id uuid primary key,
  created_at timestamptz not null default now(),
  question text not null,
  post_ids text[] not null default '{}',
  scope text not null
);

create table if not exists moderation_logs (
  id uuid primary key,
  created_at timestamptz not null default now(),
  payload jsonb not null
);

-- The prototype's embedding model produces 384 dimensions.
create index if not exists argus_embedding_idx on argus_post_details
  using ivfflat (embedding extensions.vector_cosine_ops) with (lists = 10);

-- Server-only prototype tables: no anonymous or browser role access.
alter table public.argus_post_details enable row level security;
alter table public.chat_evidence enable row level security;
alter table public.moderation_logs enable row level security;
revoke all on public.argus_post_details, public.chat_evidence, public.moderation_logs from anon, authenticated;
grant all on public.argus_post_details, public.chat_evidence, public.moderation_logs to service_role;
notify pgrst, 'reload schema';

-- Historical source-scoped analyses. Browser roles have no access.
create table if not exists public.analysis_runs (
  id text primary key, source_key text not null, created_at timestamptz not null, payload jsonb not null
);
create table if not exists public.analysis_records (
  run_id text not null references public.analysis_runs(id), post_id text not null, payload jsonb not null,
  primary key (run_id,post_id)
);
create table if not exists public.interaction_edges (
  run_id text not null references public.analysis_runs(id), edge_id text not null, payload jsonb not null,
  primary key (run_id,edge_id)
);
create table if not exists public.audience_reports (id text primary key, payload jsonb not null);
create table if not exists public.channels (id text primary key, name text not null, payload jsonb not null, updated_at timestamptz not null);
create table if not exists public.discovery_runs (id text primary key, day date not null, payload jsonb not null);
create table if not exists public.video_metric_snapshots (
  video_id text not null, channel_id text not null, observed_at timestamptz not null,
  view_count bigint, like_count bigint, comment_count bigint, primary key(video_id,observed_at)
);
create index if not exists analysis_runs_source_idx on public.analysis_runs(source_key,created_at desc);
alter table public.analysis_runs enable row level security;
alter table public.analysis_records enable row level security;
alter table public.interaction_edges enable row level security;
alter table public.audience_reports enable row level security;
alter table public.channels enable row level security;
alter table public.discovery_runs enable row level security;
alter table public.video_metric_snapshots enable row level security;
revoke all on public.analysis_runs,public.analysis_records,public.interaction_edges,public.audience_reports,public.channels,public.discovery_runs,public.video_metric_snapshots from anon,authenticated;
grant all on public.analysis_runs,public.analysis_records,public.interaction_edges,public.audience_reports,public.channels,public.discovery_runs,public.video_metric_snapshots to service_role;
notify pgrst, 'reload schema';
