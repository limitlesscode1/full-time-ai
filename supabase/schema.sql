-- Full Time AI: run this ONCE in Supabase > SQL Editor > New query > Run.
-- It creates two small helper tables used by the Edge Functions.
-- (User accounts and predictions are still stored in the browser by the current app, so no user table is needed yet.)

-- 1) Cache for football API answers, so you do not burn your daily API-Football quota.
create table if not exists public.api_cache (
  key        text primary key,            -- e.g. "teams?search=Everton"
  body       jsonb       not null,        -- the answer from API-Football
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists api_cache_expires_idx on public.api_cache (expires_at);

-- 2) Log of emailed codes, used to stop someone spamming a mailbox (max 5 per hour per address).
create table if not exists public.mail_log (
  id         bigserial primary key,
  to_email   text        not null,
  created_at timestamptz not null default now()
);
create index if not exists mail_log_to_time_idx on public.mail_log (to_email, created_at desc);

-- Lock both tables: only the Edge Functions (service role) can touch them, never the public anon key.
alter table public.api_cache enable row level security;
alter table public.mail_log  enable row level security;
-- (No policies on purpose: with RLS on and no policy, the anon key gets no access.)

-- Optional housekeeping: delete expired cache rows and old mail logs (run now and then, or schedule with pg_cron).
-- delete from public.api_cache where expires_at < now();
-- delete from public.mail_log  where created_at < now() - interval '1 day';
