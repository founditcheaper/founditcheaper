// Flappy Banana score save. Like the dice game, flappy_scores holds player emails
// and is fully locked from the public anon key — every write comes through here on
// the service-role key (which bypasses RLS). The public reads the email-free
// flappy_leaderboard view instead.
//
// Fair play: this is a skill game whose score is computed in the browser, so it can
// never be 100% cheat-proof. What we DO enforce server-side:
//   1) keep-max — we only ever raise a player's best, never lower it. Replaying a
//      worse run can't hurt you, and a stale/duplicate submit can't overwrite a
//      higher score.
//   2) a hard ceiling — scores above SCORE_CAP are rejected as bogus.
//   3) a plausibility floor — a run must have lasted at least roughly the time it
//      physically takes to clear that many pillars. Blocks the trivial "POST 9999
//      with no game" cheat. (game_ms is client-sent too, so this is a deterrent,
//      not a wall — the admin can always toss an absurd score and force a winner.)
//
// POST { email, username, player_tag, best_score, game_ms, period_start, period_end }
// Upserts on (email, period_start) so each player has one row per competition.

const SCORE_CAP = 5000;              // no legit flappy run gets close to this
const MIN_MS_PER_POINT = 550;        // lenient floor: ~0.55s of play per pillar cleared

function clampInt(v, lo, hi) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return null;
  return Math.max(lo, Math.min(hi, n));
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const email = String(body.email || '').trim().toLowerCase();
  const periodStart = String(body.period_start || '');
  if (!email.includes('@') || !/^\d{4}-\d{2}-\d{2}$/.test(periodStart)) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid input' }) };
  }

  const bestScore = clampInt(body.best_score, 0, SCORE_CAP);
  if (bestScore === null) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Bad score' }) };
  if (parseInt(body.best_score, 10) > SCORE_CAP) {
    return { statusCode: 422, body: JSON.stringify({ ok: false, error: 'Score out of range' }) };
  }

  // Plausibility: the run has to have lasted long enough for that many pillars.
  const gameMs = clampInt(body.game_ms, 0, 100000000);
  if (bestScore > 0 && gameMs !== null && gameMs > 0 && gameMs < bestScore * MIN_MS_PER_POINT) {
    return { statusCode: 422, body: JSON.stringify({ ok: false, error: 'Run too short for that score' }) };
  }

  const username = String(body.username || 'Player').slice(0, 60);
  const playerTag = body.player_tag != null ? String(body.player_tag).slice(0, 40) : null;
  const periodEnd = /^\d{4}-\d{2}-\d{2}$/.test(String(body.period_end || '')) ? String(body.period_end) : null;

  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, body: JSON.stringify({ error: 'Config error' }) };
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  try {
    // keep-max: read the existing best for this player+period first.
    const gr = await fetch(
      `${sbUrl}/rest/v1/flappy_scores?email=eq.${encodeURIComponent(email)}&period_start=eq.${encodeURIComponent(periodStart)}&select=best_score`,
      { headers: H }
    );
    const existing = await gr.json().catch(function () { return []; });
    const prevBest = Array.isArray(existing) && existing[0] ? (existing[0].best_score || 0) : 0;

    if (Array.isArray(existing) && existing[0] && bestScore <= prevBest) {
      // Nothing to raise. Still report ok so the client doesn't retry.
      return { statusCode: 200, body: JSON.stringify({ ok: true, best: prevBest, kept: true }) };
    }

    const row = {
      email, username, player_tag: playerTag,
      best_score: bestScore,
      last_play: new Date().toISOString(),
      period_start: periodStart,
      period_end: periodEnd,
      updated_at: new Date().toISOString(),
    };
    const r = await fetch(`${sbUrl}/rest/v1/flappy_scores?on_conflict=email,period_start`, {
      method: 'POST',
      headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(row),
    });
    if (!r.ok) {
      const detail = await r.text();
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'save failed', detail: detail.slice(0, 200) }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, best: bestScore }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'save-flappy-score failed', detail: String(e).slice(0, 160) }) };
  }
};
