// Auto-start the daily DICE game. When the admin toggle `game_auto_daily` is on, this
// rolls the dice competition forward to a fresh single-day game each night, so Erik never
// has to hand-start one. Driven by GitHub Actions (.github/workflows/game-auto-roll.yml)
// just after midnight Central, because Netlify's own scheduler fires unreliably.
//
// Ordering matters: the day that just ended must have its winner NOTIFIED before we reset
// the board, because game-end-notify reads game_period_start to find the standings. So we
// trigger game-end-notify first and confirm it marked the round done, THEN advance the
// period. If the notify can't be confirmed we do NOT advance (the game pauses safely for
// the day rather than silently dropping a winner).
//
// Fresh board = the new day's rolls write rows under a new week_start; yesterday's rows are
// kept as history. The prize (game_prize/_2/_3/_sub) is left untouched, so it carries
// forward; change it in admin any time and the next day picks up the new value.
//
// Idempotent: safe to call more than once a day (it no-ops once game_period_start == today)
// and safe to call while a round is still live (it no-ops until today is past the end date).

function todayCT() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); }

exports.handler = async function () {
  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) { console.error('[game-auto-roll] missing supabase env'); return { statusCode: 500, body: 'config error' }; }
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };
  const site = process.env.URL || 'https://founditcheaper.net';

  // 1) Read the current game settings.
  const settings = {};
  try {
    const r = await fetch(`${sbUrl}/rest/v1/settings?select=key,value`, { headers: H });
    const rows = await r.json();
    if (Array.isArray(rows)) rows.forEach(function (x) { settings[x.key] = x.value; });
  } catch (e) { console.error('[game-auto-roll] settings read failed:', e.message); return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'settings read failed' }) }; }

  // 2) Only act when the admin toggle is on.
  if (String(settings.game_auto_daily || '0') !== '1') {
    return { statusCode: 200, body: JSON.stringify({ ok: true, skip: 'auto-daily off' }) };
  }

  const oldStart = settings.game_period_start || '';
  const oldEnd = settings.game_period_end || '';
  const today = todayCT();

  // 3) Need an existing game to roll forward. Erik starts the very first one by hand; after
  //    that this keeps it going. (Nothing to advance from if none is configured.)
  if (!oldStart || !oldEnd) return { statusCode: 200, body: JSON.stringify({ ok: true, skip: 'no game configured' }) };

  // 4) Already rolled today.
  if (oldStart === today) return { statusCode: 200, body: JSON.stringify({ ok: true, skip: 'already rolled today', start: today }) };

  // 5) Current round still live (today is not past its end date). Wait until it ends.
  if (today <= oldEnd) return { statusCode: 200, body: JSON.stringify({ ok: true, skip: 'current round still live', end: oldEnd }) };

  // 6) The round has ended. Make sure its winner is notified BEFORE we reset the board.
  //    game-end-notify is idempotent (it no-ops if it already sent for this round).
  try {
    await fetch(`${site}/.netlify/functions/game-end-notify`, { method: 'POST' });
  } catch (e) { console.error('[game-auto-roll] end-notify trigger failed:', e.message); }

  // Confirm the ended round was marked notified. If not, do NOT advance — pausing for the day
  // is safe; dropping the winner is not. It will resolve on the next trigger / hourly notify.
  let marker = '';
  try {
    const r = await fetch(`${sbUrl}/rest/v1/settings?key=eq.game_notified_period&select=value`, { headers: H });
    const rows = await r.json();
    if (Array.isArray(rows) && rows[0]) marker = rows[0].value || '';
  } catch (e) { console.error('[game-auto-roll] marker read failed:', e.message); }

  if (marker !== oldStart) {
    console.warn(`[game-auto-roll] winner for ${oldStart} not confirmed notified (marker=${marker}); not advancing yet`);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'winner not notified yet, will retry', round: oldStart }) };
  }

  // 7) Advance to a fresh single-day game for today. Prize keys are left as-is (carry forward);
  //    game_ended cleared so play is open. New week_start = fresh leaderboard.
  const writes = [
    ['game_period_start', today],
    ['game_period_end', today],
    ['game_ended', '0'],
  ];
  try {
    for (const [key, value] of writes) {
      const r = await fetch(`${sbUrl}/rest/v1/settings`, {
        method: 'POST',
        headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ key, value }),
      });
      if (!r.ok) { const d = await r.text(); throw new Error(`${key}: HTTP ${r.status} ${d.slice(0, 120)}`); }
    }
  } catch (e) {
    console.error('[game-auto-roll] advance write failed:', e.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'advance failed: ' + String(e.message).slice(0, 160) }) };
  }

  console.log(`[game-auto-roll] rolled dice game forward: ${oldStart} -> ${today}`);
  return { statusCode: 200, body: JSON.stringify({ ok: true, rolledFrom: oldStart, rolledTo: today }) };
};
