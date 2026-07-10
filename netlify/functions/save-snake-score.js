// Hungry Banana score submission — REPLAY VERIFIED, with a real-time sanity check.
//
// The browser does NOT send a score. It sends the run it was issued (runId, seed, sig)
// and the turns it made. This function replays that exact board against those turns and
// works out the score itself. You cannot claim 40 bananas unless your turns genuinely
// eat 40 bananas.
//
// Everything the Flappy audit taught us, applied from day one:
//   * no score field                     -> nothing to forge
//   * period comes from `settings`       -> can't score into a round that isn't running
//   * player_tag derived from the email  -> can't spoof an identity
//   * HMAC signature bound to the email  -> can't replay a run issued to someone else
//   * runs expire                        -> can't stockpile seeds
//   * keep-max                           -> a worse run never lowers your best
//   * rate limit                         -> can't hammer submissions
//
// And one thing Flappy does NOT have. A pure replay check is happy to accept a perfect
// run, however it was produced. So we also compare the run's NOMINAL duration (how long
// it should take at the game's own step speed) against the REAL elapsed time, measured
// on our clock from the moment we issued the run. That closes:
//   * slow motion   - throttle the step rate to get more thinking time per move
//   * offline solve - compute an optimal run and submit it instantly
// Neither survives: a solved run arrives far too fast, a slow-mo run far too slow.
//
// Residual risk, stated plainly: a bot that plays well in real time. True of any skill
// game with a prize. We store the replay so the winning run can be watched and its turn
// timing inspected before anyone is paid.
//
// POST { email, username, runId, seed, issuedAt, sig, turns: [[step,dir],...] }

const { verifyRun } = require('./lib/run-token');
const { snSimulate } = require('./lib/snake-sim');

const SCORE_CAP = 400;              // a 20x20 grid cannot hold more than this
const MAX_STEPS = 50000;
const MAX_TURNS = 5000;
const MIN_SUBMIT_GAP_MS = 1500;     // light anti-spam between submissions

// Real elapsed time must land in a sane band around the run's nominal duration.
// Generous on the slow side, because a real player might briefly tab away or lag, and a
// false rejection of an honest run is far worse than letting a mild pause through. Even
// so, a 10x slow-motion run lands nowhere near the ceiling.
const TIMING_MIN_RATIO = 0.5;       // faster than this and it wasn't played in real time
const TIMING_MAX_RATIO = 3.0;       // slower than this and it was played in slow motion
const TIMING_SLACK_MS = 30000;      // page load, network, a moment of lag, a short tab-away

function todayCT() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); }

function tagFromEmail(email) {
  let h = 5381; const e = (email || '').toLowerCase();
  for (let i = 0; i < e.length; i++) h = ((h << 5) + h + e.charCodeAt(i)) >>> 0;
  return 10000 + (h % 90000);
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

  // 1. The run must be one we issued, to this email, recently.
  const run = verifyRun('snake', email, body);
  if (!run.ok) return { statusCode: run.status, body: JSON.stringify({ ok: false, error: run.error }) };

  // 2. Turns must be a sane, strictly increasing list of [step, direction].
  const raw = body.turns;
  if (!Array.isArray(raw) || raw.length > MAX_TURNS) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid input' }) };
  }
  const turns = [];
  let prev = -1;
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (!Array.isArray(t) || t.length !== 2) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid input' }) };
    const step = t[0], dir = t[1];
    if (!Number.isInteger(step) || step < 0 || step >= MAX_STEPS || step <= prev ||
        !Number.isInteger(dir) || dir < 0 || dir > 3) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid input' }) };
    }
    turns.push([step, dir]); prev = step;
  }

  // 3. There must be a live competition, and WE decide which one.
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
  const periodStart = settings.snake_period_start || '';
  const periodEnd = settings.snake_period_end || '';
  const forceEnded = String(settings.snake_ended || '0') === '1';
  const today = todayCT();
  if (!periodStart || !periodEnd || forceEnded || today < periodStart || today > periodEnd) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'no-game' }) };
  }

  // 4. Replay the run. This is the score. Nothing the client said about it matters.
  const sim = snSimulate(run.seed, turns, MAX_STEPS);
  const trueScore = Math.max(0, Math.min(sim.score, SCORE_CAP));

  // 5. Was it actually played, in real time, by a person at a keyboard?
  const lo = sim.nominalMs * TIMING_MIN_RATIO;
  const hi = sim.nominalMs * TIMING_MAX_RATIO + TIMING_SLACK_MS;
  if (trueScore > 0 && (run.elapsedMs < lo || run.elapsedMs > hi)) {
    return {
      statusCode: 422,
      body: JSON.stringify({
        ok: false,
        error: run.elapsedMs < lo ? 'Run submitted too fast to have been played' : 'Run took too long to have been played',
      }),
    };
  }

  const playerTag = String(tagFromEmail(email));
  const nowIso = new Date().toISOString();
  const now = Date.now();

  try {
    const gr = await fetch(
      `${sbUrl}/rest/v1/snake_scores?email=eq.${encodeURIComponent(email)}&period_start=eq.${encodeURIComponent(periodStart)}&select=id,best_score,last_play`,
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
      // keep-max. Still refresh the display name (so a rename lands) and last-played.
      await fetch(`${sbUrl}/rest/v1/snake_scores?id=eq.${encodeURIComponent(row.id)}`, {
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
      // Keep the winning run so it can be replayed and its turn timing inspected.
      run_seed: run.seed, run_turns: turns, run_steps: sim.steps,
      updated_at: nowIso,
    };
    const r = await fetch(`${sbUrl}/rest/v1/snake_scores?on_conflict=email,period_start`, {
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
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'save-snake-score failed', detail: String(e).slice(0, 160) }) };
  }
};
