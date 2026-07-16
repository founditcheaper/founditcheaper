// Feature (pin) a deal to the top of a given day's All Deals grid, or unfeature it.
// Purpose-built, least-privilege endpoint so trusted agents (e.g. the content
// automation agent) can pin a promoted deal WITHOUT the owner-only save-settings
// function. It only ever reads and writes the `featured_by_day` setting; it cannot
// touch game prizes, schedules, or any other setting.
//
// Auth: ADMIN_PASSWORD (owner) or AGENT_PASSWORD (agents). VA_PASSWORD is NOT
// accepted here on purpose — featuring is an agent/owner action.
//
// POST { password, dealId, date?, action? }
//   dealId : the numeric deals.id to feature (string or number)
//   date   : optional "YYYY-MM-DD"; defaults to TODAY in America/Chicago (Central),
//            matching how the site scopes featured deals per day
//   action : "feature" (default) or "unfeature"
//
// Featured are date-scoped: featured_by_day = { "YYYY-MM-DD": [ids...] }. Each day's
// set shows only on that day's view of the grid. No per-day cap (removed 2026-07-16), deduped.

function centralToday() {
  // en-CA gives YYYY-MM-DD; America/Chicago matches the frontend's day keys.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const pass = String(body.password || '');
  const owner = process.env.ADMIN_PASSWORD;
  const agent = process.env.AGENT_PASSWORD;
  const authed = (owner && pass === owner) || (agent && pass === agent);
  if (!authed) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };

  const dealId = String(body.dealId == null ? '' : body.dealId).replace(/[^0-9]/g, '');
  if (!dealId) return { statusCode: 400, body: JSON.stringify({ error: 'Missing or invalid dealId' }) };

  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? String(body.date) : centralToday();
  const action = String(body.action || 'feature').toLowerCase();

  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, body: JSON.stringify({ error: 'Config error' }) };
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  try {
    // 1) Read the current featured_by_day map.
    let map = {};
    const gr = await fetch(`${sbUrl}/rest/v1/settings?key=eq.featured_by_day&select=value`, { headers: H });
    if (gr.ok) {
      const rows = await gr.json();
      if (Array.isArray(rows) && rows[0] && rows[0].value) {
        try { const parsed = JSON.parse(rows[0].value); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed; } catch (e) {}
      }
    }

    // 2) Apply the change for the target day.
    let ids = Array.isArray(map[date]) ? map[date].map(x => String(x).replace(/[^0-9]/g, '')).filter(Boolean) : [];
    ids = ids.filter((v, i) => ids.indexOf(v) === i); // dedupe
    if (action === 'unfeature') {
      ids = ids.filter(id => id !== dealId);
    } else {
      if (ids.indexOf(dealId) === -1) ids.push(dealId);
    }
    if (ids.length) map[date] = ids; else delete map[date];

    // 3) Write the whole map back (upsert on the settings key).
    const wr = await fetch(`${sbUrl}/rest/v1/settings`, {
      method: 'POST',
      headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key: 'featured_by_day', value: JSON.stringify(map) }),
    });
    if (!wr.ok) {
      const detail = await wr.text();
      return { statusCode: 502, body: JSON.stringify({ error: 'save failed', detail: detail.slice(0, 160) }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, action: action === 'unfeature' ? 'unfeature' : 'feature', dealId, date, featured: ids }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'feature-deal failed', detail: String(e).slice(0, 160) }) };
  }
};
