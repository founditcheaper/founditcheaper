// Dice-game score save. The game used to write game_scores directly with the
// public anon key, but that can't work securely: an upsert (INSERT ... ON CONFLICT)
// needs table-level SELECT to read the conflicting row, and granting that to anon
// would expose every player's email (the anon key ships in the page source). So
// game_scores is now fully locked from the public key and all writes come through
// here, using the service-role key (which bypasses RLS). The leaderboard is still
// read publicly through the game_leaderboard view, which hides email.
//
// POST { email, username, player_tag, week_score, last_roll, roll_days, streak, week_start }
// Upserts on (email, week_start) so each player has one row per competition.

function clampInt(v, lo, hi) {
  var n = parseInt(v, 10);
  if (isNaN(n)) return null;
  return Math.max(lo, Math.min(hi, n));
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const email     = String(body.email || '').trim().toLowerCase();
  const weekStart = String(body.week_start || '');
  if (!email.includes('@') || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid input' }) };
  }

  const weekScore = clampInt(body.week_score, 0, 1000000);
  const streak    = clampInt(body.streak, 0, 100000);
  if (weekScore === null) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Bad score' }) };
  }

  // last_roll is the TIMESTAMP of the player's most recent roll — it drives the
  // one-roll-per-hour cooldown, NOT a numeric dice value. Accept an ISO timestamp
  // (what the client sends via Date.toISOString()); else null.
  let lastRoll = null;
  if (body.last_roll != null) {
    const s = String(body.last_roll);
    if (/^\d{4}-\d{2}-\d{2}T/.test(s) && !isNaN(Date.parse(s))) lastRoll = s;
  }

  // roll_days: array of YYYY-MM-DD strings, deduped and capped.
  let rollDays = [];
  if (Array.isArray(body.roll_days)) {
    rollDays = body.roll_days
      .filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(String(d)); })
      .slice(0, 400);
  }

  const username = String(body.username || 'Player').slice(0, 60);
  const playerTag = body.player_tag != null ? String(body.player_tag).slice(0, 40) : null;

  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, body: JSON.stringify({ error: 'Config error' }) };

  const row = {
    email: email,
    username: username,
    player_tag: playerTag,
    week_score: weekScore,
    last_roll: lastRoll,
    roll_days: rollDays,
    streak: streak === null ? 0 : streak,
    week_start: weekStart,
    updated_at: new Date().toISOString(),
  };

  try {
    const r = await fetch(`${sbUrl}/rest/v1/game_scores?on_conflict=email,week_start`, {
      method: 'POST',
      headers: {
        apikey: sbKey, Authorization: `Bearer ${sbKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(row),
    });
    if (!r.ok) {
      const detail = await r.text();
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'save failed', detail: detail.slice(0, 200) }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'save-score failed', detail: String(e).slice(0, 160) }) };
  }
};
