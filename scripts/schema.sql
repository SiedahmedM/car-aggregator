-- Minimal schema for saved searches and jobs

-- Saved searches scoped by date (UTC). If no searches exist for today, reuse last_date entries.
create table if not exists public.offerup_searches (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  date_key date not null,
  name text not null,
  params jsonb not null default '{}',
  user_id uuid null,
  active boolean not null default true
);
create index if not exists offerup_searches_date_active on public.offerup_searches(date_key, active);

-- Job queue to run searches via worker
create table if not exists public.offerup_jobs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  started_at timestamptz null,
  finished_at timestamptz null,
  status text not null default 'pending', -- pending|running|success|error
  search_id uuid not null references public.offerup_searches(id) on delete cascade,
  params jsonb not null default '{}',
  result jsonb null,
  error text null
);
create index if not exists offerup_jobs_status_created on public.offerup_jobs(status, created_at);

