// SERVER-AUTHORITATIVE dice roll. The browser no longer decides anything about the
// score: it asks to roll, and the server checks the cooldown, generates the dice with
// a cryptographic RNG, applies the scoring rules, writes the new total, and returns the
// result for the page to animate. A forged score is structurally impossible because the
// client never supplies one (see save-score.js, which no longer accepts a score).
//
// Rules (identical to what the page used to do locally):
//   - one roll SEQUENCE per hour, per player, enforced here against last_roll
//   - each roll scores d1 + d2
//   - snake eyes (1,1) on the FIRST roll grants 2 bonus rolls; any other double grants 1
//   - bonus rolls never grant further bonus rolls
//   - perfect-attendance bonus (7+ day games only): rolling every day of the competition
//     pays days * 5 on the first roll of the final day
//
// Concurrency: the write is a compare-and-swap against the last_roll we read, so two
// simultaneous requests can never both bank a roll.
//
// POST { email, username? } -> { ok, rolls[], gained, weekScore, streakBonus, nextRollAt }

const crypto = require('crypto');

const ROLL_COOLDOWN_MS = 3600000;   // 1 hour
const MAX_ROLLS = 3;                // first roll + at most 2 bonus rolls (snake eyes)

function todayCT() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); }

// Same stable per-email id the game shows players (#12345).
function tagFromEmail(email) {
  let h = 5381; const e = (email || '').toLowerCase();
  for (let i = 0; i < e.length; i++) h = ((h << 5) + h + e.charCodeAt(i)) >>> 0;
  return 10000 + (h % 90000);
}

// Inclusive list of YYYY-MM-DD between two dates. Anchored at UTC noon so a DST
// boundary can never skip or duplicate a day.
function daysBetween(startStr, endStr) {
  const out = [];
  const d = new Date(startStr + 'T12:00:00Z');
  const end = new Date(endStr + 'T12:00:00Z');
  while (d <= end) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

function die() { return crypto.randomInt(1, 7); }   // 1..6, uniform, unpredictable

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

  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Config error' }) };
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  // 1) There must be a live competition. The client cannot talk us out of this.
  let settings = {};
  try {
    const r = await fetch(`${sbUrl}/rest/v1/settings?select=key,value`, { headers: H });
    const rows = await r.json();
    if (Array.isArray(rows)) rows.forEach(function (x) { settings[x.key] = x.value; });
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'settings read failed' }) };
  }
  const start = settings.game_period_start || '';
  const end = settings.game_period_end || '';
  const forceEnded = String(settings.game_ended || '0') === '1';
  const today = todayCT();
  if (!start || !end || forceEnded || today < start || today > end) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'no-game' }) };
  }

  // 2) Current row for this player + competition.
  let row = null;
  try {
    const r = await fetch(
      `${sbUrl}/rest/v1/game_scores?email=eq.${encodeURIComponent(email)}&week_start=eq.${encodeURIComponent(start)}&select=id,week_score,last_roll,roll_days,streak`,
      { headers: H }
    );
    const rows = await r.json();
    if (Array.isArray(rows) && rows[0]) row = rows[0];
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'score read failed' }) };
  }

  // 3) Cooldown, enforced here rather than in the browser.
  const now = Date.now();
  if (row && row.last_roll) {
    const lastMs = Date.parse(row.last_roll);
    if (!isNaN(lastMs) && now < lastMs + ROLL_COOLDOWN_MS) {
      const nextAt = new Date(lastMs + ROLL_COOLDOWN_MS).toISOString();
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: false, reason: 'cooldown', nextRollAt: nextAt,
          secondsLeft: Math.ceil((lastMs + ROLL_COOLDOWN_MS - now) / 1000),
        }),
      };
    }
  }

  // 4) Roll. Snake eyes on the first roll => 2 bonus rolls; any other double => 1.
  const rolls = [];
  let bonusRemaining = 0;
  for (let i = 0; i < MAX_ROLLS; i++) {
    if (i > 0 && bonusRemaining <= 0) break;
    const d1 = die(), d2 = die();
    const isDouble = d1 === d2;
    const isSnake = d1 === 1 && d2 === 1;
    if (i === 0) bonusRemaining = isSnake ? 2 : (isDouble ? 1 : 0);
    else bonusRemaining--;                       // bonus rolls never grant more
    rolls.push({
      d1, d2, pts: d1 + d2,
      bonus: i > 0,
      kind: isSnake ? 'snake' : (isDouble ? 'doubles' : 'normal'),
    });
  }
  const rollPoints = rolls.reduce(function (s, r) { return s + r.pts; }, 0);

  // 5) Attendance / perfect-week bonus.
  const prevDays = Array.isArray(row && row.roll_days) ? row.roll_days.filter(function (d) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(d));
  }) : [];
  const firstRollToday = prevDays.indexOf(today) === -1;
  const rollDays = firstRollToday ? prevDays.concat([today]) : prevDays;

  const periodDays = daysBetween(start, end);
  const isFullWeek = periodDays.length >= 7;
  const elapsedDays = daysBetween(start, today);
  const rolledEveryDay = elapsedDays.every(function (d) { return rollDays.indexOf(d) !== -1; });
  const isLastDay = today === end;

  const streakBonus = (firstRollToday && isFullWeek && rolledEveryDay && isLastDay)
    ? elapsedDays.length * 5 : 0;
  const streak = rolledEveryDay ? elapsedDays.length : 0;

  const gained = rollPoints + streakBonus;
  const newScore = ((row && row.week_score) || 0) + gained;
  const nowIso = new Date().toISOString();
  const periodEnd = /^\d{4}-\d{2}-\d{2}$/.test(end) ? end : null;

  // 6) Persist. Compare-and-swap on last_roll so two concurrent rolls can't both land.
  try {
    if (row) {
      const guard = row.last_roll
        ? `last_roll=eq.${encodeURIComponent(row.last_roll)}`
        : 'last_roll=is.null';
      const r = await fetch(`${sbUrl}/rest/v1/game_scores?id=eq.${encodeURIComponent(row.id)}&${guard}`, {
        method: 'PATCH',
        headers: { ...H, Prefer: 'return=representation' },
        body: JSON.stringify({
          username, player_tag: String(tagFromEmail(email)),
          week_score: newScore, last_roll: nowIso, roll_days: rollDays,
          streak, period_end: periodEnd, updated_at: nowIso,
        }),
      });
      const out = await r.json().catch(function () { return []; });
      if (!r.ok || !Array.isArray(out) || !out.length) {
        // Someone else banked a roll between our read and our write.
        return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'cooldown', secondsLeft: ROLL_COOLDOWN_MS / 1000 }) };
      }
    } else {
      const r = await fetch(`${sbUrl}/rest/v1/game_scores?on_conflict=email,week_start`, {
        method: 'POST',
        headers: { ...H, Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify({
          email, username, player_tag: String(tagFromEmail(email)),
          week_score: newScore, last_roll: nowIso, roll_days: rollDays,
          streak, week_start: start, period_end: periodEnd, updated_at: nowIso,
        }),
      });
      const out = await r.json().catch(function () { return []; });
      if (!r.ok || !Array.isArray(out) || !out.length) {
        return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'retry' }) };
      }
    }
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'save failed' }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      rolls, gained, streakBonus,
      weekScore: newScore,
      streak,
      rolledEveryDay, isLastDay, isFullWeek,
      weekStart: start, periodEnd: end,
      nextRollAt: new Date(now + ROLL_COOLDOWN_MS).toISOString(),
    }),
  };
};
