// Start a Flappy Banana run. The SERVER picks the course.
//
// The browser cannot choose its own seed, because the seed decides where every pillar
// gap sits. We hand out a seed together with an HMAC signature over it, so the run the
// player submits later has to be the run we actually issued. save-flappy-score then
// replays that exact course against the player's taps and works out the true score.
//
// The signing key is derived from the service-role key rather than a new env var, since
// Netlify caps total env vars at ~4KB and the project is already close to the limit.
//
// POST { email } -> { ok, runId, seed, issuedAt, sig, periodStart, periodEnd }

const crypto = require('crypto');

function todayCT() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); }

function signRun(runId, seed, issuedAt, email) {
  const key = 'flappy-run-v1:' + (process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  return crypto.createHmac('sha256', key)
    .update(`${runId}|${seed}|${issuedAt}|${email}`)
    .digest('hex');
}

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

  // A run may only start while a competition is actually live. The client does not get
  // to tell us which competition it is playing in.
  let settings = {};
  try {
    const r = await fetch(`${sbUrl}/rest/v1/settings?select=key,value`, { headers: H });
    const rows = await r.json();
    if (Array.isArray(rows)) rows.forEach(function (x) { settings[x.key] = x.value; });
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'settings read failed' }) };
  }
  const start = settings.flappy_period_start || '';
  const end = settings.flappy_period_end || '';
  const forceEnded = String(settings.flappy_ended || '0') === '1';
  const today = todayCT();
  if (!start || !end || forceEnded || today < start || today > end) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'no-game' }) };
  }

  const runId = crypto.randomBytes(12).toString('hex');
  const seed = crypto.randomBytes(4).readUInt32BE(0);   // the course
  const issuedAt = Date.now();
  const sig = signRun(runId, seed, issuedAt, email);

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true, runId, seed, issuedAt, sig,
      periodStart: start, periodEnd: end,
    }),
  };
};
