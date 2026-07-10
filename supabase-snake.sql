-- Hungry Banana (snake) — run this once in the Supabase SQL Editor.
-- Project: founditcheaper (kvscvenwhdfwiswcfmxq)
--
-- Mirrors the flappy model. snake_scores holds player emails and is LOCKED from the
-- public anon key (RLS on, no public policy). All writes go through the service-role
-- Netlify functions; the public reads the email-free snake_leaderboard view.
--
-- run_seed / run_turns / run_steps store the winning run so it can be replayed and its
-- input timing inspected before anyone is paid.

create table if not exists snake_scores (
  id           uuid        default gen_random_uuid() primary key,
  email        text        not null,
  username     text        not null,
  player_tag   text,
  best_score   int         not null default 0,
  last_play    timestamptz,
  period_start date        not null,
  period_end   date,
  run_seed     bigint,
  run_turns    jsonb,
  run_steps    int,
  claim_token  text,
  claimed_at   timestamptz,
  win_place    int,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (email, period_start)
);

create index if not exists snake_scores_period_idx on snake_scores (period_start, best_score desc);
create index if not exists snake_scores_claim_idx  on snake_scores (claim_token);

alter table snake_scores enable row level security;

-- Public, email-free leaderboard. Owned by postgres, so it bypasses the table's RLS and
-- the anon key can read it (same pattern as game_leaderboard / flappy_leaderboard).
create or replace view snake_leaderboard as
  select username, player_tag, best_score, period_start, last_play
  from snake_scores;

grant select on snake_leaderboard to anon, authenticated;

-- The "notify me when it's live" list is scoped per game. Existing subscribers signed up
-- for other games, so snake defaults to false: nobody is opted into Hungry Banana until
-- they ask for it.
alter table game_notify
  add column if not exists notify_snake      boolean not null default false,
  add column if not exists last_snake_period text;
