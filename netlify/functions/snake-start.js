// Start a Hungry Banana run. The SERVER picks the board.
//
// The browser cannot choose its own seed, because the seed decides where every banana
// spawns. We hand out a seed with an HMAC signature binding it to this email at this
// moment, so the run submitted later has to be the run we actually issued.
// save-snake-score then replays that board against the player's turns.
//
// POST { email } -> { ok, runId, seed, issuedAt, sig, periodStart, periodEnd }

const { issueRun } = require('./lib/run-token');

function todayCT() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); }

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) }; }

  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Valid email required' }) };
  }

  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Config error' }) };
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}` };

  // A run may only start while a competition is live. The client does not get to tell us
  // which competition it is playing in, or whether one exists.
  let settings = {};
  try {
    const r = await fetch(`${sbUrl}/rest/v1/settings?select=key,value`, { headers: H });
    const rows = await r.json();
    if (Array.isArray(rows)) rows.forEach(function (x) { settings[x.key] = x.value; });
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'settings read failed' }) };
  }
  const start = settings.snake_period_start || '';
  const end = settings.snake_period_end || '';
  const forceEnded = String(settings.snake_ended || '0') === '1';
  const today = todayCT();
  if (!start || !end || forceEnded || today < start || today > end) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'no-game' }) };
  }

  const run = issueRun('snake', email);
  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, ...run, periodStart: start, periodEnd: end }),
  };
};
