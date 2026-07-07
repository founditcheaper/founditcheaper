// Moderation scanner for imported promo-code deals.
//
// Imported deals (from the extension via manage-code) come in as review_status='pending'
// and are HIDDEN from the site. This function runs on a schedule and, once a pending deal
// is at least DELAY_MIN old (so DealSeek's post-import "poison" has had time to surface):
//   * re-checks it against the Amazon API + a banned-deal-site keyword list, then
//   * publishes it (review_status='live') if clean, or
//   * flags it (review_status='flagged' + flag_reason) if not — kept hidden, for review.
// It also re-scans already-LIVE promo deals for banned keywords (cheap, no API) to catch
// junk that only reveals itself after publishing, plus any that predate this system.
//
// Safety: it NEVER flags on "no image" while the Amazon API is down (that would nuke the
// whole feed on an outage) — in that case it just leaves the deal pending for next run.

const TOKEN_ENDPOINT = 'https://api.amazon.com/auth/o2/token';
const ITEMS_ENDPOINT = 'https://creatorsapi.amazon/catalog/v1/getItems';
const MARKETPLACE    = 'www.amazon.com';
const AFFILIATE_TAG  = 'founditchea09-20';

const DELAY_MIN   = 10;      // hold a new deal this long before deciding
const TIME_CAP_MS = 20000;   // stay within the function's time limit
const API_SPACING = 1200;    // ~1 req/sec — respect the Creators API rate limit

// Deal-site names / placeholder phrasing that should never appear in a real Amazon
// product title. "honey"/"rakuten"-as-a-word is deliberately left out of the risky
// ones; these are all distinctive enough not to hit real products.
const BANNED = /dealseek|joylink|koupon|coupert|slickdeals|dealnews|couponbirds|capital one shopping|we'?re building|for smarter shopping/i;

function extractAsin(url) {
  const m = String(url || '').match(/(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/product\/|[?&]asin=)([A-Z0-9]{10})/i);
  if (m) return m[1].toUpperCase();
  const b = String(url || '').match(/\b(B0[A-Z0-9]{8})\b/i);
  return b ? b[1].toUpperCase() : null;
}

let _token = null, _tokenExp = 0;
async function getToken() {
  if (_token && Date.now() < _tokenExp - 60000) return _token;
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: process.env.AMAZON_CREATORS_CLIENT_ID, client_secret: process.env.AMAZON_CREATORS_CLIENT_SECRET, scope: 'creatorsapi::default' }).toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('token failed');
  _token = data.access_token; _tokenExp = Date.now() + (data.expires_in || 3600) * 1000;
  return _token;
}

// Returns { apiDown } if the API can't verify (ineligible/error), { notFound } if the
// ASIN isn't a real product, or { name, img } for a real product.
async function fetchProduct(asin, token) {
  const res = await fetch(ITEMS_ENDPOINT, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-marketplace': MARKETPLACE },
    body: JSON.stringify({ itemIds: [asin], itemIdType: 'ASIN', resources: ['images.primary.large', 'itemInfo.title'], partnerTag: AFFILIATE_TAG, partnerType: 'Associates', marketplace: MARKETPLACE }),
  });
  const data = await res.json();
  const reason = data.reason || data.errors?.[0]?.reason;
  if (reason === 'AssociateNotEligible' || res.status === 403 || res.status === 429 || res.status >= 500) return { apiDown: true };
  const item = data.itemsResult?.items?.[0];
  if (!item) return { notFound: true };
  return { name: item.itemInfo?.title?.displayValue || '', img: item.images?.primary?.large?.url || '' };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

exports.handler = async function () {
  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, body: 'Config error' };
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };
  const patch = (id, obj) => fetch(`${sbUrl}/rest/v1/deals?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(obj) }).catch(() => {});

  let published = 0, flagged = 0, heldForApi = 0, flaggedLive = 0;
  const start = Date.now();

  // A) Pending deals old enough to have "settled" — publish or flag. Two passes, so a big
  // batch of ready deals is never stuck behind the slow API checks.
  const cutoff = new Date(Date.now() - DELAY_MIN * 60000).toISOString();
  let token = null, fastDone = 0, readySeen = 0;

  // Pass 1 (fast, no Amazon API): deals that already have a title + image — the usual case
  // for Promo-Agent / seller uploads. The poison filter is the banned-keyword check on the
  // title, which needs no API call, so publish clean ones and flag junk immediately. This is
  // what lets a large batch clear in a run or two instead of ~15/run. (Already-live deals are
  // also continuously re-scanned for banned keywords in section B below, as a safety net.)
  try {
    const r = await fetch(`${sbUrl}/rest/v1/deals?review_status=eq.pending&created_at=lt.${encodeURIComponent(cutoff)}&img=not.is.null&name=not.is.null&select=id,name&order=created_at.asc&limit=400`, { headers: H });
    const ready = await r.json();
    if (Array.isArray(ready)) {
      readySeen = ready.length;
      for (const d of ready) {
        if (Date.now() - start > TIME_CAP_MS) break;
        if (BANNED.test(d.name || '')) { await patch(d.id, { review_status: 'flagged', flag_reason: 'deal-site placeholder title' }); flagged++; }
        else { await patch(d.id, { review_status: 'live' }); published++; fastDone++; }
      }
    }
  } catch (e) { /* ignore */ }

  // Pass 2 (Amazon API verify): pending deals still MISSING an image — fetch the real title
  // and image from the API to confirm they're genuine, using whatever time budget is left.
  let pending = [];
  try {
    const r = await fetch(`${sbUrl}/rest/v1/deals?review_status=eq.pending&created_at=lt.${encodeURIComponent(cutoff)}&img=is.null&select=id,name,url,img&order=created_at.asc&limit=100`, { headers: H });
    pending = await r.json(); if (!Array.isArray(pending)) pending = [];
  } catch (e) { pending = []; }

  for (const d of pending) {
    if (Date.now() - start > TIME_CAP_MS) break;   // rest next run
    const asin = extractAsin(d.url);
    let prod = { apiDown: true };
    try { if (!token) token = await getToken(); if (asin) prod = await fetchProduct(asin, token); }
    catch (e) { prod = { apiDown: true }; }
    await sleep(API_SPACING);

    const name = prod.name || d.name || '';
    const img  = prod.img  || d.img  || '';
    let reason = '';
    if (BANNED.test(name)) reason = 'deal-site placeholder title';
    else if (prod.notFound) reason = 'not a real Amazon product';
    else if (!img) { if (prod.apiDown) { heldForApi++; continue; } reason = 'no product image'; }

    if (reason) { await patch(d.id, { review_status: 'flagged', flag_reason: reason }); flagged++; }
    else {
      const up = { review_status: 'live' };
      if (prod.name) up.name = prod.name.slice(0, 250);
      if (prod.img)  up.img  = prod.img;
      await patch(d.id, up); published++;
    }
  }

  // B) Re-scan already-live promo deals for banned keywords (cheap, no API). Catches
  // poison that only surfaced after publishing, and anything from before this system.
  try {
    const r = await fetch(`${sbUrl}/rest/v1/deals?review_status=eq.live&is_top_pick=eq.false&code=not.is.null&select=id,name&limit=3000`, { headers: H });
    const live = await r.json();
    if (Array.isArray(live)) {
      for (const d of live) {
        if (BANNED.test(d.name || '')) { await patch(d.id, { review_status: 'flagged', flag_reason: 'deal-site placeholder title' }); flaggedLive++; }
      }
    }
  } catch (e) { /* ignore */ }

  // C) Expiry sweep — remove any deal whose seller-set end date (ends_at) has passed.
  // (The frontend also hides these instantly; this keeps the table + admin tidy.)
  let expired = 0;
  try {
    const nowIso = new Date().toISOString();
    const del = await fetch(`${sbUrl}/rest/v1/deals?ends_at=lt.${encodeURIComponent(nowIso)}&is_top_pick=eq.false`, {
      method: 'DELETE', headers: { ...H, Prefer: 'return=representation' },
    });
    if (del.ok) { const gone = await del.json().catch(() => []); expired = Array.isArray(gone) ? gone.length : 0; }
  } catch (e) { /* ignore — the ends_at column may not exist yet */ }

  const result = { ok: true, published, fastDone, flagged, flaggedLive, heldForApi, expired, readySeen, apiSeen: pending.length };
  console.log('[review-deals]', JSON.stringify(result));
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
};
