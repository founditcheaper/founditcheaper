// Daily Top Deal Picks refresh (scheduled — see netlify.toml).
//
// Every morning this replaces the Top Deal Picks carousel with a FRESH,
// randomized set of 10 quality deals pulled from the current grid — a ~50/50
// Amazon/Walmart mix, with a boost for promo-code deals and recognized brands,
// plus a random jitter so the lineup feels new each day. Erik can still hand-edit
// the picks afterward; his changes hold until the next morning's run.
//
// It DEMOTES the prior picks back to the grid (is_top_pick=false) rather than
// deleting them, so nothing is lost — yesterday's picks just rejoin the pool.

const PICKS = 10;
const PROMO_TARGET = 5;   // include up to this many promo-code deals (if available)
const MIN_OFF = 15;       // quality floor

function score(d) {
  const off     = Number(d.off) || 0;
  const rating  = Number(d.rating) || 0;
  const reviews = Number(d.reviews) || 0;
  return off
       + rating * 5
       + Math.min(reviews, 5000) / 300
       + (d.brand ? 20 : 0)
       + (d.code ? 25 : 0)            // feature promo-code deals (Erik's focus)
       + Math.random() * 40;          // freshness — different lineup each day
}

function baseNameKey(name) {
  return (name || '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').slice(0, 8).join(' ');
}

exports.handler = async function () {
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) { console.error('[promote-top-picks] missing env'); return { statusCode: 500, body: 'Configuration error' }; }
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };
  const today = new Date().toISOString().split('T')[0];

  // Candidates come from the GRID only (is_top_pick=false), so each day's set
  // rotates instead of re-picking the same deals. Variant-dedup, keep best score.
  const cres = await fetch(`${sbUrl}/rest/v1/deals?select=id,name,off,rating,reviews,brand,code,store&is_top_pick=eq.false&limit=5000`, { headers: H });
  const rows = await cres.json();
  const best = {};
  for (const r of (rows || [])) {
    if ((Number(r.off) || 0) < MIN_OFF) continue;
    const k = baseNameKey(r.name);
    r._s = score(r);
    if (!best[k] || r._s > best[k]._s) best[k] = r;
  }
  const all = Object.values(best);

  // Promo codes get priority: take up to PROMO_TARGET coded deals (if available),
  // then fill the remaining slots with a store-mixed set of regular deals.
  const promo   = all.filter(d => d.code).sort((a, b) => b._s - a._s);
  const regular = all.filter(d => !d.code).sort((a, b) => b._s - a._s);
  const regAmz  = regular.filter(d => d.store === 'Amazon');
  const regWmt  = regular.filter(d => d.store !== 'Amazon');

  const ordered = promo.slice(0, PROMO_TARGET);
  let ai = 0, wi = 0;
  while (ordered.length < PICKS && (ai < regAmz.length || wi < regWmt.length)) {
    if (ai < regAmz.length && ordered.length < PICKS) ordered.push(regAmz[ai++]);
    if (wi < regWmt.length && ordered.length < PICKS) ordered.push(regWmt[wi++]);
  }
  // Thin catalog? Top up from any leftover promo deals.
  for (let i = PROMO_TARGET; i < promo.length && ordered.length < PICKS; i++) ordered.push(promo[i]);

  // Safety: if the grid is empty (a sync failed), leave the existing picks alone
  // rather than blanking the carousel.
  if (ordered.length === 0) {
    console.log('[promote-top-picks] no candidates — leaving existing picks unchanged');
    return { statusCode: 200, body: JSON.stringify({ ok: true, picked: 0 }) };
  }

  // Demote the prior picks back to the grid (don't delete — they rejoin the pool).
  await fetch(`${sbUrl}/rest/v1/deals?is_top_pick=eq.true`, {
    method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ is_top_pick: false }),
  });

  // Promote the fresh set.
  let promoted = 0;
  for (let i = 0; i < ordered.length; i++) {
    const r = await fetch(`${sbUrl}/rest/v1/deals?id=eq.${ordered[i].id}`, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({ is_top_pick: true, active_date: today, rank: i + 1 }),
    });
    if (r.ok) promoted++; else console.error(`[promote-top-picks] patch ${ordered[i].id} -> ${r.status}`);
  }

  console.log(`[promote-top-picks] ✓ refreshed Top Picks: ${promoted} deals`);
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, picked: promoted }),
  };
};
