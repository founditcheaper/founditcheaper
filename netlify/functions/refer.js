// Dice-game referral. When someone who followed a share link (?ref=<tag>) rolls
// the dice for the first time, the game calls this to record the referral. The
// referrer then earns +25 points — capped at 5 referrals (125 pts) per competition,
// which is enforced in the game_leaderboard view (LEAST(count,5)*25).
//
// Writes go through the service-role key (game_referrals has RLS on with no public
// policy) so referrals can't be faked by hitting Supabase directly. Self-referrals
// are rejected and each email can only ever count once (unique referred_email).
//
// FIRST-TIME PLAYERS ONLY: a referral is credited only if the invited email has never
// scored in an earlier competition. A returning player (email already in game_scores
// from a prior week_start) earns nobody the bonus — that's what stops referral farming
// by "inviting" people who already play.
//
// POST { refTag, email, weekStart }

// Same stable per-email ID the game uses — lets us reject self-referrals.
function tagFromEmail(email) {
  let h = 5381; const e = (email || '').toLowerCase();
  for (let i = 0; i < e.length; i++) h = ((h << 5) + h + e.charCodeAt(i)) >>> 0;
  return 10000 + (h % 90000);
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const refTag    = parseInt(body.refTag, 10);
  const email     = String(body.email || '').trim().toLowerCase();
  const weekStart = String(body.weekStart || '');

  if (!refTag || !email.includes('@') || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid input' }) };
  }
  // No crediting yourself.
  if (tagFromEmail(email) === refTag) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'self-referral' }) };
  }

  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, body: JSON.stringify({ error: 'Config error' }) };
  const authH = { apikey: sbKey, Authorization: `Bearer ${sbKey}` };

  // First-time players only. If this email already scored in an EARLIER competition
  // (any week_start other than this one), they've played before, so no referral is
  // credited. That cancels both the referrer's +25 and the friend's welcome +25, since
  // both are derived from the single game_referrals row we would otherwise insert.
  // (The current round's own row shares this week_start, so it's correctly excluded —
  // a genuine first-timer only has the current row, or none yet.)
  try {
    const pr = await fetch(`${sbUrl}/rest/v1/game_scores?email=eq.${encodeURIComponent(email)}&week_start=neq.${encodeURIComponent(weekStart)}&select=id&limit=1`, { headers: authH });
    const prev = await pr.json().catch(function () { return []; });
    if (Array.isArray(prev) && prev.length) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'not-first-time' }) };
    }
  } catch (e) {
    // Don't deny a possibly-legit new player over a transient lookup error. Fall through;
    // the self-referral block and the unique-email guard below still apply.
    console.warn('[refer] first-time-player check failed:', e.message);
  }

  try {
    const r = await fetch(`${sbUrl}/rest/v1/game_referrals`, {
      method: 'POST',
      headers: {
        apikey: sbKey, Authorization: `Bearer ${sbKey}`,
        'Content-Type': 'application/json',
        // Ignore if this email was already referred (unique referred_email).
        Prefer: 'resolution=ignore-duplicates,return=minimal',
      },
      body: JSON.stringify({ referrer_tag: refTag, referred_email: email, week_start: weekStart }),
    });
    if (!r.ok && r.status !== 409) {
      const detail = await r.text();
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'insert failed (run the game_referrals SQL?)', detail: detail.slice(0, 160) }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'refer failed', detail: String(e).slice(0, 160) }) };
  }
};
