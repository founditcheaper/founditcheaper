// Admin-only: clear Hungry Banana scores so a competition can be ended / restarted.
// Uses the service-role key (bypasses RLS). POST { password, scope, periodStart? }
//   scope 'current' + periodStart 'YYYY-MM-DD' → wipe only that period's scores
//   scope 'all'                                → wipe every score (full restart)

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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.periodStart || ''))) {
      return { statusCode: 400, body: JSON.stringify({ error: 'periodStart required for current scope' }) };
    }
    filter = `period_start=eq.${body.periodStart}`;
  } else {
    filter = `period_start=not.is.null`;   // period_start is NOT NULL, so this matches every row
  }

  try {
    const r = await fetch(`${sbUrl}/rest/v1/snake_scores?${filter}`, {
      method: 'DELETE',
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, Prefer: 'return=representation' },
    });
    const data = await r.json();
    if (!r.ok) return { statusCode: 502, body: JSON.stringify({ error: 'delete failed', detail: JSON.stringify(data).slice(0, 160) }) };
    return { statusCode: 200, body: JSON.stringify({ ok: true, scope, deleted: Array.isArray(data) ? data.length : 0 }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'reset-snake failed', detail: String(e).slice(0, 160) }) };
  }
};
