// Admin-only: returns full Flappy Banana results (including player emails) for the
// admin winners view. Uses the service-role key so it works even though public read
// access to flappy_scores is locked (emails are hidden from the public).
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
    const r = await fetch(`${sbUrl}/rest/v1/flappy_scores?select=email,username,player_tag,best_score,period_start,period_end,claimed_at&order=period_start.desc,best_score.desc`, {
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
    });
    const rows = await r.json();
    if (!r.ok) return { statusCode: 502, body: JSON.stringify({ error: 'read failed', detail: JSON.stringify(rows).slice(0, 160) }) };
    return { statusCode: 200, body: JSON.stringify({ ok: true, rows: Array.isArray(rows) ? rows : [] }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'flappy-results failed', detail: String(e).slice(0, 160) }) };
  }
};
