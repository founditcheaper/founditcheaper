-- Flappy Banana game — run this once in the Supabase SQL Editor.
-- Project: founditcheaper (kvscvenwhdfwiswcfmxq)
--
-- Mirrors the dice game's data model. flappy_scores holds player emails and is
-- LOCKED from the public anon key (RLS on, no public policy). All writes go through
-- the service-role Netlify functions (save-flappy-score / flappy-end-notify /
-- flappy-claim / reset-flappy), which bypass RLS. The public reads the email-free
-- flappy_leaderboard view instead.

create table if not exists flappy_scores (
  id           uuid        default gen_random_uuid() primary key,
  email        text        not null,
  username     text        not null,
  player_tag   text,
  best_score   int         not null default 0,
  last_play    timestamptz,
  period_start date        not null,
  period_end   date,
  claim_token  text,
  claimed_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (email, period_start)
);

create index if not exists flappy_scores_period_idx on flappy_scores (period_start, best_score desc);
create index if not exists flappy_scores_claim_idx  on flappy_scores (claim_token);

-- Lock the table: RLS on, no public policy. Only the service_role key (used by the
-- Netlify Functions) can read/write, and it bypasses RLS.
alter table flappy_scores enable row level security;

-- Public, email-free leaderboard. Owned by postgres, so it bypasses the table's RLS
-- and the anon key can read it (same pattern as the dice game's game_leaderboard).
create or replace view flappy_leaderboard as
  select username, player_tag, best_score, period_start, last_play
  from flappy_scores;

grant select on flappy_leaderboard to anon, authenticated;
