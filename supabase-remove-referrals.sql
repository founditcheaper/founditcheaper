-- Dice game: referrals REMOVED (2026-07-10). Run once in the Supabase SQL Editor.
--
-- Why: an audit found the referral bonus was being farmed with throwaway emails.
-- 81 referrals came from 12 accounts, 75 of them from just 6 repeat referrers.
-- "Friends" signed up as little as 11 seconds apart, scored a single dice roll
-- (avg 9.2 pts vs 16.6 for normal players), and never came back. Only ~7 of 81
-- looked genuine. At +25 each (capped at +125) against a ~17-point average dice
-- score, referrals decided the winner in 3 of 6 rounds.
--
-- Fix: zero the bonus at the source. The column is KEPT (so every consumer keeps
-- working: the game page, admin standings, game-results.js and game-end-notify.js
-- all read referral_bonus) but it is always 0. Totals now equal the real dice score
-- everywhere, including the winner pick.
--
-- game_referrals is intentionally NOT dropped: it is the evidence trail and the
-- source for identifying the junk emails to purge from the newsletter. Nothing
-- writes to it anymore (netlify/functions/refer.js is disabled).

create or replace view game_leaderboard as
select
  gs.username,
  gs.player_tag,
  gs.week_score,
  gs.last_roll,
  gs.roll_days,
  gs.streak,
  gs.week_start,
  0::bigint as referral_bonus
from game_scores gs;


-- ── Reference: the query that identifies the farmed (junk) emails ──────────────
-- High-confidence junk = referred by one of the six ring accounts, never came back
-- for a second competition, and never scored 25+ (i.e. never played beyond a roll
-- or two). Conservative on purpose: it spares anyone who actually engaged.
--
-- select distinct lower(gr.referred_email) as email
-- from game_referrals gr
-- where gr.referrer_tag in (54196,28103,81085,66358,53754,47918)
--   and not exists (
--     select 1 from game_scores gs
--     where lower(gs.email)=lower(gr.referred_email) and gs.week_score >= 25)
--   and (select count(distinct gs.week_start) from game_scores gs
--        where lower(gs.email)=lower(gr.referred_email)) <= 1
-- order by 1;
