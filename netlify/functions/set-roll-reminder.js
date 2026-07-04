// Dice-game roll reminder: opt in/out.
//   GET  ?email=<email>            -> { ok, active }   (read state for the toggle)
//   POST { email, on: true|false } -> upsert,  { ok, active }
// The scheduled roll-reminder-notify function emails opted-in players when their hourly
// roll cooldown is up. The table is RLS-locked; the game reaches it only through here
// (service-role key), so emails are never exposed to the public key.

const crypto = require('crypto');
function isEmail(s) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s); }

exports.handler = async function (event) {
  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'config error' }) };
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  // READ current state (for the toggle button).
  if (event.httpMethod === 'GET') {
    const email = String((event.queryStringParameters && event.queryStringParameters.email) || '').toLowerCase().trim();
    if (!isEmail(email)) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'bad email' }) };
    try {
      const r = await fetch(`${sbUrl}/rest/v1/roll_reminders?email=eq.${encodeURIComponent(email)}&select=active`, { headers: H });
      const rows = await r.json();
      const active = Array.isArray(rows) && rows[0] ? !!rows[0].active : false;
      return { statusCode: 200, body: JSON.stringify({ ok: true, active }) };
    } catch (e) { return { statusCode: 200, body: JSON.stringify({ ok: true, active: false }) }; }
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body; try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'bad json' }) }; }
  const email = String(body.email || '').toLowerCase().trim();
  const on = body.on === true || body.on === 'true' || body.on === 1;
  if (!isEmail(email)) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'bad email' }) };

  // Upsert. Turning ON mints a fresh opt-out token; turning OFF leaves the existing row's
  // token/created_at intact (merge-duplicates only overwrites the fields we send).
  const row = { email, active: on };
  if (on) row.token = crypto.randomBytes(16).toString('hex');

  try {
    const r = await fetch(`${sbUrl}/rest/v1/roll_reminders?on_conflict=email`, {
      method: 'POST',
      headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(row),
    });
    if (!r.ok) { const t = await r.text(); return { statusCode: 502, body: JSON.stringify({ ok: false, error: t.slice(0, 160) }) }; }
    return { statusCode: 200, body: JSON.stringify({ ok: true, active: on }) };
  } catch (e) { return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(e).slice(0, 160) }) }; }
};
