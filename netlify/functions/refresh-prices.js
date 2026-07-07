// Keeps promo-code Amazon deal prices inside Amazon's 24-hour freshness window.
//
// Why this exists: the auto-pulled grid (sync-deals) wipes + re-inserts every ~12h, so those
// prices are always fresh. But promo-code Amazon deals (sync-codes) persist up to 5 days, and
// their displayed regular price is the Amazon API price captured when the deal was added. Amazon's
// license only lets us show an API price for up to 24h before we re-pull it. So this job re-pulls
// the live Creators API price for the STALEST coded Amazon deals each run and re-stamps
// price_checked_at.
//
// Belt-and-suspenders: the frontend hides the price (and shows "See price on Amazon") for any
// Amazon deal whose price_checked_at is older than 24h, so even if a refresh is missed, a stale
// price is never displayed.
//
// Small + time-capped: oldest-first, a handful per run. Triggered on a schedule (netlify.toml)
// and on demand via ?key=ADMIN_PASSWORD. Only Amazon deals are touched (Amazon's rule); Walmart /
// Home Depot are governed by their own agreements.

const TOKEN_ENDPOINT = 'https://api.amazon.com/auth/o2/token';
const ITEMS_ENDPOINT = 'https://creatorsapi.amazon/catalog/v1/getItems';
const MARKETPLACE    = 'www.amazon.com';
const AFFILIATE_TAG  = 'founditchea09-20';

const STALE_AFTER_MS = 12 * 3600 * 1000;  // re-pull once a price is >12h old — keeps everything under 24h with margin
const BATCH          = 25;                 // stalest N per run
const TIME_CAP_MS    = 22000;              // stay inside the 26s function limit
const API_SPACING    = 1200;               // ~1 req/sec — respect the Creators API rate limit

const RESOURCES = [
  'images.primary.large',
  'itemInfo.title',
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

async function fetchPrice(asin, token) {
  const res = await fetch(ITEMS_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-marketplace': MARKETPLACE },
    body: JSON.stringify({
      itemIds: [asin], itemIdType: 'ASIN', resources: RESOURCES,
      partnerTag: AFFILIATE_TAG, partnerType: 'Associates', marketplace: MARKETPLACE,
    }),
  });
  const data = await res.json();
  const item = data.itemsResult?.items?.[0];
  if (!item) return null;
  const listing = item.offersV2?.listings?.[0];
  const price = Number(listing?.price?.money?.amount ?? listing?.price?.amount) || 0;
  if (!price) return null;
  return {
    price,
    img:     item.images?.primary?.large?.url || '',
    rating:  item.customerReviews?.starRating?.value || 0,
    reviews: item.customerReviews?.count || 0,
  };
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

  // Stalest coded Amazon deals first: price_checked_at null OR older than the cutoff.
  let rows = [];
  try {
    const q = `${sbUrl}/rest/v1/deals?store=eq.Amazon&code=not.is.null&is_top_pick=eq.false`
      + `&or=(price_checked_at.is.null,price_checked_at.lt.${encodeURIComponent(cutoff)})`
      + `&order=price_checked_at.asc.nullsfirst&limit=${BATCH}&select=id,url,price,was,code`;
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
  let refreshed = 0, skipped = 0, capped = false;

  for (const d of rows) {
    if (Date.now() - start > TIME_CAP_MS) { capped = true; break; }
    const asin = extractAsin(d.url);
    if (!asin) { skipped++; continue; }
    let prod = null;
    try { prod = await fetchPrice(asin, token); } catch (e) { prod = null; }
    await sleep(API_SPACING);
    // On a miss, leave price_checked_at stale -> the frontend hides the price and the 5-day
    // expiry eventually removes the deal. Never stamp a price we couldn't verify.
    if (!prod) { skipped++; continue; }

    // Coded deal: `was` is Amazon's regular price (refreshed from the API); `price` is the
    // after-code promo claim, which the API can't know, so we keep it (unless the shelf price
    // has fallen to/below it, in which case the code no longer beats the price).
    const was   = prod.price;
    const price = (d.price > 0 && d.price < was) ? d.price : was;
    const off   = was > price ? Math.round((1 - price / was) * 100) : 0;

    const patch = { price, was, off, rating: prod.rating || 0, reviews: prod.reviews || 0, price_checked_at: nowIso };
    if (prod.img) patch.img = prod.img;
    try {
      const up = await fetch(`${sbUrl}/rest/v1/deals?id=eq.${encodeURIComponent(d.id)}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(patch),
      });
      if (up.ok) refreshed++; else { skipped++; console.error('[refresh-prices] patch failed:', await up.text()); }
    } catch (e) { skipped++; console.error('[refresh-prices] patch error:', e.message); }
  }

  const result = { ok: true, refreshed, skipped, capped, batch: rows.length };
  console.log('[refresh-prices]', JSON.stringify(result));
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
};
