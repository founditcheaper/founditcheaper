// Admin-only: save Auto-Fill/Randomizer + Schedule settings into the `settings`
// table (key/value). Read publicly (RLS allows select); written here with the
// service key. POST { password, runTime?, promoTarget? }.

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  if (!process.env.ADMIN_PASSWORD || body.password !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, body: JSON.stringify({ error: 'Config error' }) };
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  const updates = [];
  if (body.runTime != null && /^\d{2}:\d{2}$/.test(String(body.runTime))) updates.push(['pick_run_time', String(body.runTime)]);
  if (body.promoTarget != null) {
    let n = parseInt(body.promoTarget, 10);
    if (!isNaN(n)) updates.push(['promo_target', String(Math.max(0, Math.min(10, n)))]);
  }
  // Site display: hide the Top Deal Picks carousel on the front page ('1' = hidden).
  if (body.hideTopPicks != null) updates.push(['hide_top_picks', body.hideTopPicks ? '1' : '0']);
  // Site display: hide the "We found X deals" bar so the page opens straight to All Deals.
  if (body.hideDealsBanner != null) updates.push(['hide_deals_banner', body.hideDealsBanner ? '1' : '0']);
  // Paid placements: ordered deal ids pinned to the top of All Deals (max 6, deduped).
  if (body.pinnedDeals != null) {
    const arr = Array.isArray(body.pinnedDeals) ? body.pinnedDeals : [];
    const seen = {};
    const clean = arr.map(x => String(x).replace(/[^0-9]/g, ''))
      .filter(id => id && !seen[id] && (seen[id] = true)).slice(0, 6);
    updates.push(['pinned_deals', JSON.stringify(clean)]);
  }
  if (body.gamePrize != null) updates.push(['game_prize', String(body.gamePrize).slice(0, 120)]);
  if (body.gamePrizeSub != null) updates.push(['game_prize_sub', String(body.gamePrizeSub).slice(0, 160)]);
  if (body.gamePeriodStart != null && /^\d{4}-\d{2}-\d{2}$/.test(String(body.gamePeriodStart))) updates.push(['game_period_start', String(body.gamePeriodStart)]);
  if (body.gamePeriodEnd != null && /^\d{4}-\d{2}-\d{2}$/.test(String(body.gamePeriodEnd))) updates.push(['game_period_end', String(body.gamePeriodEnd)]);
  // Force-end override. Explicit gameEnded wins; otherwise saving the competition dates
  // resumes a game that was force-ended (clears the flag).
  if (body.gameEnded != null) updates.push(['game_ended', body.gameEnded ? '1' : '0']);
  else if (body.gamePeriodStart != null || body.gamePeriodEnd != null) updates.push(['game_ended', '0']);

  // ── Flappy Banana game (independent settings, same pattern as the dice game) ──
  if (body.flappyPrize != null) updates.push(['flappy_prize', String(body.flappyPrize).slice(0, 120)]);
  if (body.flappyPrizeSub != null) updates.push(['flappy_prize_sub', String(body.flappyPrizeSub).slice(0, 160)]);
  if (body.flappyPeriodStart != null && /^\d{4}-\d{2}-\d{2}$/.test(String(body.flappyPeriodStart))) updates.push(['flappy_period_start', String(body.flappyPeriodStart)]);
  if (body.flappyPeriodEnd != null && /^\d{4}-\d{2}-\d{2}$/.test(String(body.flappyPeriodEnd))) updates.push(['flappy_period_end', String(body.flappyPeriodEnd)]);
  if (body.flappyEnded != null) updates.push(['flappy_ended', body.flappyEnded ? '1' : '0']);
  else if (body.flappyPeriodStart != null || body.flappyPeriodEnd != null) updates.push(['flappy_ended', '0']);

  if (!updates.length) return { statusCode: 400, body: JSON.stringify({ error: 'Nothing to save' }) };

  try {
    for (const [key, value] of updates) {
      const r = await fetch(`${sbUrl}/rest/v1/settings`, {
        method: 'POST',
        headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ key, value }),
      });
      if (!r.ok) {
        const detail = await r.text();
        return { statusCode: 502, body: JSON.stringify({ error: 'save failed (run the settings-table SQL?)', detail: detail.slice(0, 160) }) };
      }
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, saved: updates.map(u => u[0]) }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'save-settings failed', detail: String(e).slice(0, 160) }) };
  }
};
