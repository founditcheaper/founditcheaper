-- Dice-game "notify me when it's live" list. Run once in the Supabase SQL Editor.
-- Locked from the public anon key (RLS on, no public policy). All reads/writes go
-- through the service-role Netlify functions: game-notify-signup (add), game-live-notify
-- (email opt-ins once when a game goes live), stop-game-notify (one-tap opt-out).

create table if not exists game_notify (
  id                   uuid        default gen_random_uuid() primary key,
  email                text        not null unique,
  token                text        not null,
  active               boolean     not null default true,
  last_notified_period text,       -- the game_period_start we last emailed them for (per-subscriber dedup)
  created_at           timestamptz not null default now()
);

create index if not exists game_notify_active_idx on game_notify (active);
create index if not exists game_notify_token_idx  on game_notify (token);

alter table game_notify enable row level security;
