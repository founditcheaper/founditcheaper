// Primary search terms — run all in parallel on first pass
const MALE_PRIMARY = [
  'power tools',
  'cordless drill',
  'outdoor camping gear',
  'bluetooth headphones',
  'gaming accessories',
  'sports equipment',
  'automotive tools',
  'home improvement',
  'lawn garden tools',
  'electronics gadgets',
];

const FEMALE_PRIMARY = [
  'kitchen appliances',
  'air fryer',
  'coffee maker',
  'home decor',
  'yoga fitness',
  'skincare beauty',
  'home organization storage',
  'small kitchen appliances',
];

// Fallback terms — used if first pass doesn't find enough
const FALLBACK = [
  'home goods',
  'tech gadgets',
  'fitness equipment',
  'cooking accessories',
  'portable speaker',
  'smart home devices',
  'garden tools',
  'office accessories',
  'vacuum cleaner',
  'instant pot cooker',
];

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const {
    needed        = 1,
    minRating     = 3.8,
    minDiscount   = 30,
    minReviews    = 15,
    malePercent   = 80,
    bigBrandMin   = 2,
    ccBrands      = [],
    existingAsins = [],
  } = p;

  // Auto-picker is dormant: its deal search ran on Rainforest, which was removed
  // for Amazon Associates compliance. Rebuild searchTerm() on the Amazon API to revive it.
  console.log('[auto-pick] Dormant — no Amazon deal-search source wired up yet (Rainforest removed).');

  const seen = new Set(existingAsins);

  function isBigBrand(name) {
    const low = (name || '').toLowerCase();
    return ccBrands.some(b => b && low.includes(b.toLowerCase()));
  }

  // eslint-disable-next-line no-unused-vars
  async function searchTerm(term) {
    // TODO: rebuild on the Amazon Creators / PA-API SearchItems endpoint, filtering
    // by minDiscount / minRating / minReviews and tagging URLs with founditchea09-20.
    // Returns [] until the Amazon search piece is built (Rainforest was removed).
    return [];
  }

  const maleTarget   = Math.round(needed * malePercent / 100);
  const femaleTarget = needed - maleTarget;

  // ── PASS 1: run all primary searches in parallel ──────────────────────
  const [maleResults, femaleResults] = await Promise.all([
    Promise.all(MALE_PRIMARY.map(t => searchTerm(t))),
    Promise.all(FEMALE_PRIMARY.map(t => searchTerm(t))),
  ]);

  const malePool   = maleResults.flat();
  const femalePool = femaleResults.flat().filter(d => !malePool.some(m => m.asin === d.asin));

  // ── PASS 2: fallback if either pool is too thin ───────────────────────
  const needFallback = malePool.length < maleTarget * 2 || femalePool.length < femaleTarget * 2;
  if (needFallback) {
    const fallbackResults = await Promise.all(FALLBACK.map(t => searchTerm(t)));
    const extra = fallbackResults.flat();
    for (const d of extra) {
      if (!malePool.some(m => m.asin === d.asin) && !femalePool.some(f => f.asin === d.asin)) {
        // Assign to whichever pool needs more
        if (malePool.length < maleTarget * 2) malePool.push(d);
        else femalePool.push(d);
      }
    }
  }

  // ── SELECT & RANK ─────────────────────────────────────────────────────
  const score = d => (isBigBrand(d.name) ? 1000 : 0) + d.rating * 10 + (d.off || 20) * 0.5;
  malePool.sort((a, b)   => score(b) - score(a));
  femalePool.sort((a, b) => score(b) - score(a));

  let picks = [...malePool.slice(0, maleTarget), ...femalePool.slice(0, femaleTarget)];

  // Top up if one pool ran short
  if (picks.length < needed) {
    const extras = [...malePool, ...femalePool].filter(d => !picks.some(p => p.asin === d.asin));
    extras.sort((a, b) => score(b) - score(a));
    picks.push(...extras.slice(0, needed - picks.length));
  }

  // Enforce big brand minimum — swap weakest non-brand picks for big brand items
  const bigCount = picks.filter(d => isBigBrand(d.name)).length;
  if (bigCount < bigBrandMin) {
    const allBig = [...malePool, ...femalePool]
      .filter(d => isBigBrand(d.name) && !picks.some(p => p.asin === d.asin));
    const swap = Math.min(bigBrandMin - bigCount, allBig.length, picks.length);
    if (swap > 0) {
      // Remove lowest-score non-brand picks
      const nonBrand = picks.filter(d => !isBigBrand(d.name)).sort((a, b) => score(a) - score(b));
      for (let i = 0; i < swap; i++) {
        const idx = picks.indexOf(nonBrand[i]);
        if (idx !== -1) picks.splice(idx, 1);
      }
      picks.push(...allBig.slice(0, swap));
    }
  }

  picks = picks.slice(0, needed);
  picks.forEach((d, i) => { d.rank = i + 1; });

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deals: picks, found: picks.length }),
  };
};
