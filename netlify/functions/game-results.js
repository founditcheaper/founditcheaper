// Admin-only: returns full dice-game results (including player emails) for the
// admin winners view. Uses the service-role key so it works even after public
// read access to game_scores is locked down (emails are hidden from the public).
// POST { password }

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  if (!process.env.ADMIN_PASSWORD || body.password !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, body: JSON.stringify({ error: 'Config error' }) };

  try {
    const r = await fetch(`${sbUrl}/rest/v1/game_scores?select=email,username,player_tag,week_score,week_start,period_end,streak&order=week_start.desc,week_score.desc`, {
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
    });
    const rows = await r.json();
    if (!r.ok) return { statusCode: 502, body: JSON.stringify({ error: 'read failed', detail: JSON.stringify(rows).slice(0, 160) }) };
    return { statusCode: 200, body: JSON.stringify({ ok: true, rows: Array.isArray(rows) ? rows : [] }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'game-results failed', detail: String(e).slice(0, 160) }) };
  }
};
