// Admin-only: clear dice-game scores so a competition can be ended / restarted.
// Uses the service-role key (bypasses RLS). POST { password, scope, weekStart? }
//   scope 'current' + weekStart 'YYYY-MM-DD' → wipe only that period's scores
//   scope 'all'                              → wipe every score (full restart)
// Deleting is intentional: pre-launch this clears test rolls; post-launch the
// non-destructive way to start fresh is to set new competition dates in admin.

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

  const scope = body.scope === 'current' ? 'current' : 'all';
  let filter;
  if (scope === 'current') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.weekStart || ''))) {
      return { statusCode: 400, body: JSON.stringify({ error: 'weekStart required for current scope' }) };
    }
    filter = `week_start=eq.${body.weekStart}`;
  } else {
    // week_start is NOT NULL in the schema, so this matches EVERY row — including
    // old rows whose player_tag is null (player_tag=gte.0 would skip those).
    filter = `week_start=not.is.null`;
  }

  try {
    const r = await fetch(`${sbUrl}/rest/v1/game_scores?${filter}`, {
      method: 'DELETE',
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, Prefer: 'return=representation' },
    });
    const data = await r.json();
    if (!r.ok) return { statusCode: 502, body: JSON.stringify({ error: 'delete failed', detail: JSON.stringify(data).slice(0, 160) }) };
    return { statusCode: 200, body: JSON.stringify({ ok: true, scope, deleted: Array.isArray(data) ? data.length : 0 }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'reset-game failed', detail: String(e).slice(0, 160) }) };
  }
};
