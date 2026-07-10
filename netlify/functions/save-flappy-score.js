// Flappy Banana score submission — REPLAY VERIFIED.
//
// The browser does NOT send a score. It sends the run it was issued (runId, seed, sig)
// and the ticks on which the player tapped. This function replays that exact course
// against those taps using the shared deterministic simulation and works out the score
// itself. You cannot claim 47 pillars unless your taps genuinely fly the banana through
// 47 pillars.
//
// What that closes (all of it was wide open before 2026-07-10):
//   * posting any score you like            -> there is no score field anymore
//   * inventing the competition period      -> the period comes from `settings`
//   * spoofing your player id               -> player_tag is derived from the email
//   * replaying a run someone else was sent -> the signature binds the run to the email
//   * grinding a seed offline for hours     -> runs expire
//
// What it does NOT close: a bot that genuinely plays well. That is true of every skill
// game with a prize. The bar is now "write a game-playing bot", not "open dev tools".
// We store the winning run's replay so it can be watched and its input timing checked.
//
// POST { email, username, runId, seed, issuedAt, sig, flapTicks[] }

const crypto = require('crypto');
const { fsSimulate } = require('./lib/flappy-sim');

const SCORE_CAP = 5000;            // sanity ceiling; a real run never approaches this
const MAX_TICKS = 72000;           // 20 minutes at 60 ticks/sec
const MAX_FLAPS = 20000;
const RUN_MAX_AGE_MS = 2 * 60 * 60 * 1000;   // a run must be submitted within 2 hours
const RUN_FUTURE_SKEW_MS = 2 * 60 * 1000;    // tolerate small clock skew
const MIN_SUBMIT_GAP_MS = 1500;              // light anti-spam between submissions

function todayCT() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); }

function tagFromEmail(email) {
  let h = 5381; const e = (email || '').toLowerCase();
  for (let i = 0; i < e.length; i++) h = ((h << 5) + h + e.charCodeAt(i)) >>> 0;
  return 10000 + (h % 90000);
}

function signRun(runId, seed, issuedAt, email) {
  const key = 'flappy-run-v1:' + (process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  return crypto.createHmac('sha256', key)
    .update(`${runId}|${seed}|${issuedAt}|${email}`)
    .digest('hex');
}

function safeEqualHex(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
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
  const username = String(body.username || 'Player').slice(0, 60);

  // ── 1. The run must be one we issued, to this email, recently. ──────────────
  const runId = String(body.runId || '');
  const seed = Number(body.seed);
  const issuedAt = Number(body.issuedAt);
  const sig = String(body.sig || '');
  if (!/^[a-f0-9]{24}$/.test(runId) || !Number.isInteger(seed) || seed < 0 || seed > 0xFFFFFFFF ||
      !Number.isFinite(issuedAt) || !/^[a-f0-9]{64}$/.test(sig)) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid run' }) };
  }
  if (!safeEqualHex(sig, signRun(runId, seed, issuedAt, email))) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Run signature invalid' }) };
  }
  const now = Date.now();
  if (issuedAt > now + RUN_FUTURE_SKEW_MS || now - issuedAt > RUN_MAX_AGE_MS) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Run expired' }) };
  }

  // ── 2. Taps must be a sane, strictly increasing list of tick numbers. ───────
  const raw = body.flapTicks;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_FLAPS) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid input' }) };
  }
  const flapTicks = [];
  let prev = -1;
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (!Number.isInteger(t) || t < 0 || t >= MAX_TICKS || t <= prev) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid input' }) };
    }
    flapTicks.push(t); prev = t;
  }

  // ── 3. There must be a live competition, and WE decide which one. ───────────
  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Config error' }) };
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  let settings = {};
  try {
    const r = await fetch(`${sbUrl}/rest/v1/settings?select=key,value`, { headers: H });
    const rows = await r.json();
    if (Array.isArray(rows)) rows.forEach(function (x) { settings[x.key] = x.value; });
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'settings read failed' }) };
  }
  const periodStart = settings.flappy_period_start || '';
  const periodEnd = settings.flappy_period_end || '';
  const forceEnded = String(settings.flappy_ended || '0') === '1';
  const today = todayCT();
  if (!periodStart || !periodEnd || forceEnded || today < periodStart || today > periodEnd) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'no-game' }) };
  }

  // ── 4. Replay the run. This is the score. Nothing the client said matters. ──
  const sim = fsSimulate(seed, flapTicks, MAX_TICKS);
  const trueScore = Math.max(0, Math.min(sim.score, SCORE_CAP));

  const playerTag = String(tagFromEmail(email));
  const nowIso = new Date().toISOString();

  try {
    const gr = await fetch(
      `${sbUrl}/rest/v1/flappy_scores?email=eq.${encodeURIComponent(email)}&period_start=eq.${encodeURIComponent(periodStart)}&select=id,best_score,last_play`,
      { headers: H }
    );
    const existing = await gr.json().catch(function () { return []; });
    const row = Array.isArray(existing) && existing[0] ? existing[0] : null;

    if (row && row.last_play) {
      const since = now - Date.parse(row.last_play);
      if (since >= 0 && since < MIN_SUBMIT_GAP_MS) {
        return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'Slow down' }) };
      }
    }

    const prevBest = row ? (row.best_score || 0) : 0;
    if (row && trueScore <= prevBest) {
      // keep-max: a worse run never lowers your best. Still refresh the display name
      // (so a rename reaches the leaderboard) and the last-played stamp.
      await fetch(`${sbUrl}/rest/v1/flappy_scores?id=eq.${encodeURIComponent(row.id)}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ username, player_tag: playerTag, last_play: nowIso, updated_at: nowIso }),
      }).catch(function () {});
      return { statusCode: 200, body: JSON.stringify({ ok: true, score: trueScore, best: prevBest, kept: true }) };
    }

    const record = {
      email, username, player_tag: playerTag,
      best_score: trueScore,
      last_play: nowIso,
      period_start: periodStart,
      period_end: periodEnd,
      // Keep the winning run so it can be replayed and its timing inspected.
      run_seed: seed, run_flaps: flapTicks, run_ticks: sim.ticks,
      updated_at: nowIso,
    };
    const r = await fetch(`${sbUrl}/rest/v1/flappy_scores?on_conflict=email,period_start`, {
      method: 'POST',
      headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(record),
    });
    if (!r.ok) {
      const detail = await r.text();
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'save failed', detail: detail.slice(0, 200) }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, score: trueScore, best: trueScore }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'save-flappy-score failed', detail: String(e).slice(0, 160) }) };
  }
};
