-- Run this entire file in the Supabase SQL Editor (once)
-- Project: founditcheaper

-- ── DEALS ────────────────────────────────────────────────────────────────
create table if not exists deals (
  id            uuid        default gen_random_uuid() primary key,
  rank          int         not null default 1,
  name          text        not null,
  store         text        not null default 'Amazon',
  price         numeric     not null default 0,
  was           numeric     not null default 0,
  off           int         not null default 0,
  rating        numeric     not null default 0,
  reviews       int         not null default 0,
  code          text,
  use_code_url  boolean     not null default false,
  creator       boolean     not null default false,
  img           text        not null default '',
  url           text        not null default '',
  category      text,
  brand         boolean     not null default false,
  brand_name    text,
  active_date   date        not null default current_date,
  created_at    timestamptz not null default now()
);

create index if not exists deals_active_date_idx on deals (active_date desc);

-- Public can read; only service role (via Netlify Function) can write
alter table deals enable row level security;
create policy "public read deals"  on deals for select using (true);
create policy "service write deals" on deals for all using (auth.role() = 'service_role');

-- ── EMAIL SUBSCRIBERS ─────────────────────────────────────────────────────
create table if not exists email_subscribers (
  id         uuid        default gen_random_uuid() primary key,
  email      text        not null unique,
  source     text        not null default 'unknown',
  created_at timestamptz not null default now()
);

-- Only service role can read; anyone can insert (via Netlify Function)
alter table email_subscribers enable row level security;
create policy "service read subscribers" on email_subscribers for select using (auth.role() = 'service_role');
create policy "service insert subscribers" on email_subscribers for insert with check (true);

-- ── GAME SCORES ───────────────────────────────────────────────────────────
create table if not exists game_scores (
  id          uuid        default gen_random_uuid() primary key,
  email       text        not null,
  username    text        not null,
  week_score  int         not null default 0,
  last_roll   date,
  roll_days   text[]      not null default '{}',
  streak      int         not null default 0,
  week_start  date        not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (email, week_start)
);

create index if not exists game_scores_week_idx on game_scores (week_start, week_score desc);

-- Public leaderboard readable by all; anyone can insert/update their own row
alter table game_scores enable row level security;
create policy "public read scores"   on game_scores for select using (true);
create policy "public insert scores" on game_scores for insert with check (true);
create policy "public update scores" on game_scores for update using (true);
