// DISABLED 2026-07-10. The dice-game referral bonus has been removed.
//
// Why: an audit found the bonus was being farmed. 81 referrals came from 12 accounts,
// 75 of them from just 6 repeat referrers, with "friends" signing up as little as 11
// seconds apart, scoring a single dice roll (avg 9.2 pts) and never returning. Only
// ~7 of 81 looked genuine. At +25 each (capped +125) against a ~17-point average dice
// score, referrals decided the winner in 3 of 6 rounds.
//
// The bonus is now zero at the source: the `game_leaderboard` view returns
// referral_bonus = 0, so the score is purely the dice score everywhere (game page,
// admin standings, and the winner pick). The `game_referrals` table is retained as a
// record but is never written to again.
//
// This endpoint stays (rather than 404ing) so any stale cached game page gets a clean,
// harmless response instead of an error. It records nothing.

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  return {
    statusCode: 200,
    body: JSON.stringify({ ok: false, reason: 'referrals-disabled' }),
  };
};
