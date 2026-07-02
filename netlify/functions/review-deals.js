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
// Safety: the trustworthy check is the banned-keyword TITLE scan (no API needed), which
// catches DealSeek/JoyLink poison. It does NOT flag on a missing image (cosmetic; the
// frontend hides broken images), and it only flags "not a real product" when Amazon
// EXPLICITLY reports the ASIN invalid — never on an empty/ineligible API response, which
// would otherwise nuke real deals while the Creators API is still in its eligibility window.

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
  if (item) return { name: item.itemInfo?.title?.displayValue || '', img: item.images?.primary?.large?.url || '' };
  // No item came back. Only call it a fake ASIN if Amazon EXPLICITLY says the item
  // is invalid/inaccessible. An empty response (which is what we get while the account
  // isn't fully eligible yet) means "can't verify", NOT "fake" — treat it as apiDown so
  // we never flag a real deal just because the API couldn't serve it.
  const errs = data.errors || data.itemsResult?.errors || [];
  const explicitInvalid = errs.some(e => /ItemNotAccessible|InvalidParameterValue|NoResult|ItemNotFound/i.test((e && (e.code || e.__type || e.reason)) || ''));
  return explicitInvalid ? { notFound: true } : { apiDown: true };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

exports.handler = async function () {
  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, body: 'Config error' };
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };
  const patch = (id, obj) => fetch(`${sbUrl}/rest/v1/deals?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(obj) }).catch(() => {});

  let published = 0, flagged = 0, heldForApi = 0, flaggedLive = 0;
  const start = Date.now();

  // A) Pending deals old enough to have "settled" — verify, then publish or flag.
  const cutoff = new Date(Date.now() - DELAY_MIN * 60000).toISOString();
  let pending = [];
  try {
    const r = await fetch(`${sbUrl}/rest/v1/deals?review_status=eq.pending&created_at=lt.${encodeURIComponent(cutoff)}&select=id,name,url,img&order=created_at.asc&limit=100`, { headers: H });
    pending = await r.json(); if (!Array.isArray(pending)) pending = [];
  } catch (e) { pending = []; }

  let token = null;
  for (const d of pending) {
    if (Date.now() - start > TIME_CAP_MS) break;   // rest next run
    const asin = extractAsin(d.url);
    let prod = { apiDown: true };
    try { if (!token) token = await getToken(); if (asin) prod = await fetchProduct(asin, token); }
    catch (e) { prod = { apiDown: true }; }
    await sleep(API_SPACING);

    const name = prod.name || d.name || '';
    let reason = '';
    if (BANNED.test(name)) reason = 'deal-site placeholder title';
    else if (prod.notFound) reason = 'not a real Amazon product';
    // A missing image is NOT a reason to flag: the frontend hides broken images, and
    // while the Amazon API is ineligible it can't supply one anyway. Publish regardless;
    // images backfill automatically once the API returns them on a later scan.

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

  const result = { ok: true, published, flagged, flaggedLive, heldForApi, pendingSeen: pending.length };
  console.log('[review-deals]', JSON.stringify(result));
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
};
