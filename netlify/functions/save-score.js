// Player registration / rename for the dice game. This function DELIBERATELY CANNOT
// SET A SCORE.
//
// It used to take a `week_score` straight from the browser and write it, which meant
// anyone could post any score they liked. As of 2026-07-10 the score is owned entirely
// by the server: it only ever changes inside roll-dice.js, which enforces the one-roll-
// per-hour cooldown and generates the dice itself. Any week_score / last_roll /
// roll_days / streak in the request body here is ignored.
//
// game_scores holds emails, so it stays locked from the public anon key; this writes
// with the service-role key. The public reads the email-free game_leaderboard view.
//
// POST { email, username, week_start, period_end? }
//   - row missing -> create it with a zero score
//   - row exists  -> update the display name only (never the score)

function tagFromEmail(email) {
  let h = 5381; const e = (email || '').toLowerCase();
  for (let i = 0; i < e.length; i++) h = ((h << 5) + h + e.charCodeAt(i)) >>> 0;
  return 10000 + (h % 90000);
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) }; }

  const email = String(body.email || '').trim().toLowerCase();
  const weekStart = String(body.week_start || '');
  if (!email.includes('@') || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid input' }) };
  }
  const username = String(body.username || 'Player').slice(0, 60);
  const periodEnd = /^\d{4}-\d{2}-\d{2}$/.test(String(body.period_end || '')) ? String(body.period_end) : null;
  const playerTag = String(tagFromEmail(email));   // derived here; never trusted from the client

  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Config error' }) };
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  try {
    const gr = await fetch(
      `${sbUrl}/rest/v1/game_scores?email=eq.${encodeURIComponent(email)}&week_start=eq.${encodeURIComponent(weekStart)}&select=id`,
      { headers: H }
    );
    const rows = await gr.json().catch(function () { return []; });

    if (Array.isArray(rows) && rows[0]) {
      // Existing player: rename only. The score is untouchable from here.
      const r = await fetch(`${sbUrl}/rest/v1/game_scores?id=eq.${encodeURIComponent(rows[0].id)}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ username, player_tag: playerTag, updated_at: new Date().toISOString() }),
      });
      if (!r.ok) {
        const detail = await r.text();
        return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'rename failed', detail: detail.slice(0, 160) }) };
      }
      return { statusCode: 200, body: JSON.stringify({ ok: true, created: false }) };
    }

    // New player for this competition: start at zero.
    const r = await fetch(`${sbUrl}/rest/v1/game_scores?on_conflict=email,week_start`, {
      method: 'POST',
      headers: { ...H, Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({
        email, username, player_tag: playerTag,
        week_score: 0, streak: 0, roll_days: [],
        week_start: weekStart, period_end: periodEnd,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!r.ok && r.status !== 409) {
      const detail = await r.text();
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'create failed', detail: detail.slice(0, 160) }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, created: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'save-score failed', detail: String(e).slice(0, 160) }) };
  }
};
