// "Notify me when the next dice game is live" signup. Stores the email in the
// game_notify table (service-role only; the table is locked from the public anon key).
// When a game next goes live, game-live-notify.js emails everyone on this list once,
// with a one-tap opt-out. The frontend also pings /subscribe so they join the
// newsletter list too (same pattern the dice game uses).
// POST { email }

const crypto = require('crypto');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Valid email required' }) };
  }

  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, body: JSON.stringify({ error: 'Config error' }) };
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  try {
    // Already on the list? Reactivate (keeps their opt-out token). Else insert fresh.
    const gr = await fetch(`${sbUrl}/rest/v1/game_notify?email=eq.${encodeURIComponent(email)}&select=id`, { headers: H });
    const rows = await gr.json().catch(function () { return []; });
    if (Array.isArray(rows) && rows[0]) {
      await fetch(`${sbUrl}/rest/v1/game_notify?id=eq.${encodeURIComponent(rows[0].id)}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ active: true }),
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true, already: true }) };
    }
    const token = crypto.randomBytes(16).toString('hex');
    const r = await fetch(`${sbUrl}/rest/v1/game_notify`, {
      method: 'POST', headers: { ...H, Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({ email, token, active: true }),
    });
    if (!r.ok && r.status !== 409) {
      const detail = await r.text();
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'signup failed (run the game_notify SQL?)', detail: detail.slice(0, 160) }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'game-notify-signup failed', detail: String(e).slice(0, 160) }) };
  }
};
