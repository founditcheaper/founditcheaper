// Keeps Amazon deal prices inside Amazon's 24-hour freshness window.
//
// The site shows a stored Amazon price for up to 24h, then hides it ("See price on Amazon")
// until we re-pull it. With thousands of promo-code deals live, a one-at-a-time refresh can't
// keep up, so this job re-pulls the STALEST Amazon deals in BATCHES — the Creators API accepts
// up to 10 ASINs per getItems call, so one call refreshes 10 deals (~10x throughput). It re-stamps
// price_checked_at on each so the front end keeps showing a live price.
//
// Time-capped, stalest-first. Triggered on a schedule (netlify.toml) and on demand via
// ?key=ADMIN_PASSWORD. Only Amazon deals (Amazon's rule); Walmart / Home Depot use their own feeds.

const TOKEN_ENDPOINT = 'https://api.amazon.com/auth/o2/token';
const ITEMS_ENDPOINT = 'https://creatorsapi.amazon/catalog/v1/getItems';
const MARKETPLACE    = 'www.amazon.com';
const AFFILIATE_TAG  = 'founditchea09-20';

const STALE_AFTER_MS = 12 * 3600 * 1000;  // re-pull once a price is >12h old — keeps everything under 24h with margin
const CHUNK          = 10;                 // ASINs per getItems call (the API max)
const QUERY_LIMIT    = 500;                // stalest N pulled from the DB per run
const TIME_CAP_MS    = 23000;              // stay inside the 26s function limit
const API_SPACING    = 1000;               // pause between getItems calls — respect the rate limit

const RESOURCES = [
  'images.primary.large',
  'offersV2.listings.price',
  'customerReviews.starRating',
  'customerReviews.count',
];

function extractAsin(url) {
  if (!url) return null;
  const u = String(url);
  const m = u.match(/(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/product\/|[?&]asin=)([A-Z0-9]{10})/i);
  if (m) return m[1].toUpperCase();
  const b = u.match(/\b(B0[A-Z0-9]{8})\b/i);
  return b ? b[1].toUpperCase() : null;
}

let _token = null, _tokenExp = 0;
async function getToken() {
  if (_token && Date.now() < _tokenExp - 60000) return _token;
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.AMAZON_CREATORS_CLIENT_ID,
      client_secret: process.env.AMAZON_CREATORS_CLIENT_SECRET,
      scope: 'creatorsapi::default',
    }).toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('token fetch failed: ' + JSON.stringify(data).slice(0, 200));
  _token = data.access_token;
  _tokenExp = Date.now() + (data.expires_in || 3600) * 1000;
  return _token;
}

// Fetch up to 10 ASINs in one call. Returns { ok, prices: { ASIN: { price, img, rating, reviews } } }.
// ok=false means the call itself failed (don't trust "missing" as "no price"); ok=true means the
// API answered, so any requested ASIN NOT in `prices` genuinely has no current price/offer.
async function fetchPrices(asins, token) {
  let res;
  try {
    res = await fetch(ITEMS_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-marketplace': MARKETPLACE },
      body: JSON.stringify({
        itemIds: asins, itemIdType: 'ASIN', resources: RESOURCES,
        partnerTag: AFFILIATE_TAG, partnerType: 'Associates', marketplace: MARKETPLACE,
      }),
    });
  } catch (e) { return { ok: false, prices: {} }; }
  if (!res.ok) return { ok: false, prices: {} };
  let data;
  try { data = await res.json(); } catch (e) { return { ok: false, prices: {} }; }
  if (!data.itemsResult) return { ok: false, prices: {} };   // couldn't reach the catalog — treat as a miss, not "no price"
  const items = data.itemsResult.items || [];
  const out = {};
  for (const item of items) {
    const asin = String(item.asin || '').toUpperCase();
    if (!asin) continue;
    const listing = item.offersV2?.listings?.[0];
    const price = Number(listing?.price?.money?.amount ?? listing?.price?.amount) || 0;
    if (!price) continue;
    out[asin] = {
      price,
      img:     item.images?.primary?.large?.url || '',
      rating:  item.customerReviews?.starRating?.value || 0,
      reviews: item.customerReviews?.count || 0,
    };
  }
  return { ok: true, prices: out };
}

exports.handler = async function (event) {
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, body: 'Configuration error (Supabase)' };

  // Manual trigger (admin) requires the admin password.
  const manual = !!(event && (event.httpMethod === 'POST' || (event.queryStringParameters && event.queryStringParameters.key)));
  if (manual) {
    const key = (event.queryStringParameters && event.queryStringParameters.key) ||
                (() => { try { return JSON.parse(event.body || '{}').key; } catch { return ''; } })();
    if (!process.env.ADMIN_PASSWORD || key !== process.env.ADMIN_PASSWORD) {
      return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized' }) };
    }
  }

  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };
  const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();

  // Stalest Amazon deals first: price_checked_at null OR older than the cutoff.
  let rows = [];
  try {
    const q = `${sbUrl}/rest/v1/deals?store=eq.Amazon`
      + `&or=(price_checked_at.is.null,price_checked_at.lt.${encodeURIComponent(cutoff)})`
      + `&order=price_checked_at.asc.nullsfirst&limit=${QUERY_LIMIT}&select=id,url,price,was,code`;
    const r = await fetch(q, { headers: H });
    rows = await r.json();
    if (!Array.isArray(rows)) rows = [];
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'load failed: ' + e.message }) };
  }
  if (!rows.length) return { statusCode: 200, body: JSON.stringify({ ok: true, refreshed: 0, note: 'all fresh' }) };

  let token;
  try { token = await getToken(); }
  catch (e) { return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'amazon token: ' + e.message }) }; }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const start = Date.now();
  const nowIso = new Date().toISOString();
  let refreshed = 0, unavailable = 0, skipped = 0, capped = false, chunks = 0;

  // Group deals into chunks of up to 10 ASINs (skip rows with no ASIN).
  const withAsin = rows.map(d => ({ d, asin: extractAsin(d.url) })).filter(x => x.asin);
  skipped += rows.length - withAsin.length;

  const patchDeal = (id, obj) => fetch(`${sbUrl}/rest/v1/deals?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(obj),
  });

  for (let i = 0; i < withAsin.length; i += CHUNK) {
    if (Date.now() - start > TIME_CAP_MS) { capped = true; break; }
    const group = withAsin.slice(i, i + CHUNK);
    const res = await fetchPrices(group.map(g => g.asin), token);
    chunks++;
    await sleep(API_SPACING);
    if (!res.ok) { skipped += group.length; continue; }   // call failed -> retry next run, don't flag anything

    for (const { d, asin } of group) {
      const prod = res.prices[asin];
      if (!prod) {
        // The API answered but this item has no current price (offer gone / not accessible). Stamp
        // it so it leaves the front of the retry queue (otherwise dead deals get retried every run
        // and starve the good ones), and flag it so the page shows a clean link-out, not a stale
        // price. It's re-checked ~every 12h in case the offer comes back.
        try { if ((await patchDeal(d.id, { price_checked_at: nowIso, price_unavailable: true })).ok) unavailable++; else skipped++; }
        catch (e) { skipped++; }
        continue;
      }
      // Coded deal: `was` is Amazon's regular price (refreshed); `price` is the after-code promo
      // claim (kept unless the shelf price fell to/below it). Plain deal: `price` is the current
      // Amazon price; keep the existing `was` unless the markdown is gone.
      let price, was, off;
      if (d.code) {
        was   = prod.price;
        price = (d.price > 0 && d.price < was) ? d.price : was;
      } else {
        price = prod.price;
        was   = (d.was > price) ? d.was : price;
      }
      off = was > price ? Math.round((1 - price / was) * 100) : 0;

      const patch = { price, was, off, rating: prod.rating || 0, reviews: prod.reviews || 0, price_checked_at: nowIso, price_unavailable: false };
      if (prod.img) patch.img = prod.img;
      try {
        const up = await patchDeal(d.id, patch);
        if (up.ok) refreshed++; else { skipped++; console.error('[refresh-prices] patch failed:', await up.text()); }
      } catch (e) { skipped++; console.error('[refresh-prices] patch error:', e.message); }
    }
  }

  const result = { ok: true, refreshed, unavailable, skipped, capped, chunks, pulled: rows.length };
  console.log('[refresh-prices]', JSON.stringify(result));
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
};
