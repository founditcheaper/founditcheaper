// Promotes the best current deals to "Top Daily Deal Picks", balanced ~50/50
// Walmart/Amazon (per Erik). Picks the highest-scoring deals from each store,
// marks them is_top_pick=true with active_date=today (so they group as TODAY's
// picks in the carousel), and clears today's prior auto-picks so re-runs are clean.
//
// NOTE: this auto-curates today's picks. It is NOT yet on a daily schedule — it
// coexists with the admin manual-pick workflow until Erik confirms he wants it
// to run automatically every day.
const PICKS_PER_STORE = 8;

function score(d) {
  const off     = Number(d.off) || 0;
  const rating  = Number(d.rating) || 0;
  const reviews = Number(d.reviews) || 0;
  return off
       + rating * 8
       + Math.min(reviews, 5000) / 250
       + (d.brand ? 20 : 0);
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

  async function topFor(store) {
    const res  = await fetch(`${sbUrl}/rest/v1/deals?select=id,name,off,rating,reviews,brand&store=eq.${store}&limit=5000`, { headers: H });
    const rows = await res.json();
    const best = {};                                   // variant dedup, keep best-scoring
    for (const r of (rows || [])) {
      const k = baseNameKey(r.name);
      if (!best[k] || score(r) > score(best[k])) best[k] = r;
    }
    return Object.values(best).sort((a, b) => score(b) - score(a)).slice(0, PICKS_PER_STORE);
  }

  const [amz, wmt] = await Promise.all([topFor('Amazon'), topFor('Walmart')]);
  console.log(`[promote-top-picks] selected ${amz.length} Amazon + ${wmt.length} Walmart`);

  // Clear ALL existing top picks first, so the carousel shows exactly today's clean
  // 50/50 set (no stale Amazon-only picks or duplicate ranks carrying over).
  await fetch(`${sbUrl}/rest/v1/deals?is_top_pick=eq.true`, {
    method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ is_top_pick: false }),
  });

  // Interleave A,W,A,W… so the carousel reads as a 50/50 mix.
  const ordered = [];
  for (let i = 0; i < Math.max(amz.length, wmt.length); i++) {
    if (amz[i]) ordered.push(amz[i]);
    if (wmt[i]) ordered.push(wmt[i]);
  }
  if (ordered.length === 0) return { statusCode: 200, body: JSON.stringify({ ok: true, picked: 0 }) };

  let promoted = 0;
  for (let i = 0; i < ordered.length; i++) {
    const r = await fetch(`${sbUrl}/rest/v1/deals?id=eq.${ordered[i].id}`, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({ is_top_pick: true, active_date: today, rank: i + 1 }),
    });
    if (r.ok) promoted++; else console.error(`[promote-top-picks] patch ${ordered[i].id} -> ${r.status}`);
  }

  console.log(`[promote-top-picks] promoted ${promoted} (${amz.length} Amazon / ${wmt.length} Walmart)`);
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, picked: promoted, amazon: amz.length, walmart: wmt.length }),
  };
};
