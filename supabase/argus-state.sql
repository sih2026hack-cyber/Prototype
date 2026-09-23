-- ARGUS runtime state for hosts without a persistent disk (e.g. Render free plan).
-- Run once in the Supabase SQL editor. Only the server's service-role key can read or write it.
create table if not exists public.argus_state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.argus_state enable row level security;
revoke all on public.argus_state from anon, authenticated;
