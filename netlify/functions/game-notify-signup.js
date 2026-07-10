// "Notify me when the next game is live" signup. Stores the email in the game_notify
// table (service-role only; the table is locked from the public anon key).
//
// The opt-in is SCOPED TO THE GAME the person signed up on. Somebody who saw a dice
// card and typed their email consented to hear about the dice game, not about whatever
// game we launch next. So `game` decides which flag gets set, and game-live-notify only
// emails people whose flag for that game is true. The 33 people who signed up before
// Flappy existed are dice-only, and stay that way unless they ask for Flappy.
//
// Signing up again from the other game's page adds that game (it never removes one).
// The frontend also pings /subscribe so they join the newsletter list too.
//
// POST { email, game }   game: 'dice' | 'flappy'  (defaults to 'dice')

const crypto = require('crypto');

const GAME_COL = { dice: 'notify_dice', flappy: 'notify_flappy', snake: 'notify_snake' };

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Valid email required' }) };
  }
  const game = GAME_COL[String(body.game || 'dice')] ? String(body.game) : 'dice';
  const col = GAME_COL[game];

  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, body: JSON.stringify({ error: 'Config error' }) };
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  try {
    // Already on the list? Reactivate and add this game (keeps their opt-out token and
    // never clears the other game's flag). Else insert with only this game enabled.
    const gr = await fetch(`${sbUrl}/rest/v1/game_notify?email=eq.${encodeURIComponent(email)}&select=id`, { headers: H });
    const rows = await gr.json().catch(function () { return []; });
    if (Array.isArray(rows) && rows[0]) {
      const patch = { active: true };
      patch[col] = true;
      await fetch(`${sbUrl}/rest/v1/game_notify?id=eq.${encodeURIComponent(rows[0].id)}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true, already: true, game }) };
    }
    const token = crypto.randomBytes(16).toString('hex');
    const row = { email, token, active: true, notify_dice: false, notify_flappy: false, notify_snake: false };
    row[col] = true;
    const r = await fetch(`${sbUrl}/rest/v1/game_notify`, {
      method: 'POST', headers: { ...H, Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(row),
    });
    if (!r.ok && r.status !== 409) {
      const detail = await r.text();
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'signup failed (run the game_notify SQL?)', detail: detail.slice(0, 160) }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, game }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'game-notify-signup failed', detail: String(e).slice(0, 160) }) };
  }
};
