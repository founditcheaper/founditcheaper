// Admin-gated add/remove of promo-code deals via the Google Sheet gateway.
// The sheet is the source of truth, so adding/removing here edits the sheet
// (Apps Script web app); sync-codes then mirrors it onto the site.
//
// POST { password, action:'add'|'remove', amazon_link, promo_code, discount_price, asin }

function asinFromUrl(url) {
  const s = String(url || '');
  const m = s.match(/(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/product\/|[?&]asin=)([A-Z0-9]{10})/i);
  if (m) return m[1].toUpperCase();
  const b = s.match(/\b(B0[A-Z0-9]{8})\b/i);
  return b ? b[1].toUpperCase() : '';
}

// ── Amazon Creators API (for instant insert on add) ───────────────────────
const TOKEN_ENDPOINT = 'https://api.amazon.com/auth/o2/token';
const ITEMS_ENDPOINT = 'https://creatorsapi.amazon/catalog/v1/getItems';
const MARKETPLACE    = 'www.amazon.com';
const AFFILIATE_TAG  = 'founditchea09-20';
const RESOURCES = ['images.primary.large', 'itemInfo.title', 'itemInfo.byLineInfo', 'offersV2.listings.price', 'customerReviews.starRating', 'customerReviews.count'];

function inferCategory(title) {
  const t = (title || '').toLowerCase();
  if (/drill|saw|wrench|power tool|cordless|sander|grinder|socket|plier/.test(t)) return 'Tools';
  if (/headphone|earbud|speaker|\btv\b|laptop|tablet|camera|gaming|keyboard|mouse|charger|monitor/.test(t)) return 'Electronics';
  if (/air fryer|coffee|blender|cookware|knife|toaster|oven|espresso|keurig|tray|\bpot\b|\bpan\b/.test(t)) return 'Kitchen';
  if (/vacuum|humidifier|air purifier|mattress|pillow|bedding|\bfan\b|lamp|rug/.test(t)) return 'Home';
  if (/camp|hiking|tent|backpack|cooler|fishing|kayak/.test(t)) return 'Outdoors';
  if (/dumbbell|workout|yoga|exercise|fitness|\bbike\b|treadmill/.test(t)) return 'Sports';
  if (/\bcar\b|truck|automotive|tire|dash cam/.test(t)) return 'Auto';
  if (/garden|plant|lawn|hose|sprinkler/.test(t)) return 'Garden';
  return 'Home';
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
async function fetchProduct(asin, token) {
  const res = await fetch(ITEMS_ENDPOINT, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-marketplace': MARKETPLACE },
    body: JSON.stringify({ itemIds: [asin], itemIdType: 'ASIN', resources: RESOURCES, partnerTag: AFFILIATE_TAG, partnerType: 'Associates', marketplace: MARKETPLACE }),
  });
  const data = await res.json();
  const item = data.itemsResult?.items?.[0];
  if (!item) return null;
  const listing = item.offersV2?.listings?.[0];
  const apiPrice = Number(listing?.price?.money?.amount ?? listing?.price?.amount) || 0;
  return {
    name: item.itemInfo?.title?.displayValue || '',
    apiPrice,
    img: item.images?.primary?.large?.url || '',
    rating: item.customerReviews?.starRating?.value || 0,
    reviews: item.customerReviews?.count || 0,
    brandName: item.itemInfo?.byLineInfo?.brand?.displayValue || '',
  };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { password, action, amazon_link, promo_code, discount_price } = body;
  if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const gwUrl = process.env.SHEET_API_URL;
  const gwTok = process.env.SHEET_API_TOKEN;
  if (!gwUrl || !gwTok) return { statusCode: 500, body: JSON.stringify({ error: 'Sheet gateway not configured' }) };

  const callGateway = async (payload) => {
    const r = await fetch(gwUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: gwTok, ...payload }),
      redirect: 'follow',
    });
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { ok: false, error: 'gateway non-JSON: ' + text.slice(0, 120) }; }
  };

  try {
    if (action === 'add') {
      const asin = asinFromUrl(amazon_link);
      if (!asin) return { statusCode: 400, body: JSON.stringify({ error: 'No Amazon ASIN found in that link' }) };
      const retailIn = parseFloat(String(body.retail_price || '').replace(/[^0-9.]/g, '')) || 0;
      const titleIn = String(body.title || '').trim();
      const res = await callGateway({
        action: 'append',
        amazon_link: String(amazon_link || ''),
        promo_code: String(promo_code || ''),
        discount_price: String(discount_price || ''),
      });
      // Insert into the grid right away so it appears instantly. Use the Amazon
      // API for the best data, but fall back to the price/retail/title the caller
      // supplied so the deal still shows up even if the API lookup comes back empty.
      let instant = false;
      try {
        const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        let prod = null;
        try { prod = await fetchProduct(asin, await getToken()); } catch (e) { /* API may be unavailable */ }
        if (sbUrl && sbKey) {
          const dp = parseFloat(String(discount_price || '').replace(/[^0-9.]/g, '')) || 0;
          const apiPrice = (prod && prod.apiPrice) || 0;
          const price = dp > 0 ? dp : apiPrice;                                  // deal/after-code price
          let regular = Math.max(apiPrice, retailIn, price);                     // "was" = highest known price
          if (!(regular > 0)) regular = price;
          if (price > 0) {
            const off = regular > price ? Math.round((1 - price / regular) * 100) : 0;
            const name = (prod && prod.name) ? prod.name : (titleIn || ('Amazon deal ' + asin));
            const today = new Date().toISOString().split('T')[0];
            const sb = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };
            await fetch(`${sbUrl}/rest/v1/deals?url=like.*${asin}*&is_top_pick=eq.false`, { method: 'DELETE', headers: { ...sb, Prefer: 'return=minimal' } }).catch(() => {});
            const row = {
              rank: 900, name: name.slice(0, 250), store: 'Amazon', category: inferCategory(name),
              price, was: regular, off, rating: (prod && prod.rating) || 0, reviews: (prod && prod.reviews) || 0,
              img: (prod && prod.img) || '', images: null, url: `https://www.amazon.com/dp/${asin}?tag=${AFFILIATE_TAG}`,
              code: String(promo_code || ''), use_code_url: false, creator: false, brand: false,
              brand_name: (prod && prod.brandName) || null, active_date: today, is_top_pick: false,
            };
            const insRes = await fetch(`${sbUrl}/rest/v1/deals`, { method: 'POST', headers: { ...sb, Prefer: 'return=minimal' }, body: JSON.stringify(row) });
            instant = insRes.ok;
          }
        }
      } catch (e) { /* sheet has it; the scheduled sync will pull it in even if this failed */ }
      // Success if EITHER the sheet append or the instant insert worked.
      return { statusCode: (res.ok || instant) ? 200 : 502, body: JSON.stringify({ ok: !!(res.ok || instant), asin, instant }) };
    }

    if (action === 'remove') {
      const asin = (body.asin ? String(body.asin) : asinFromUrl(amazon_link)).toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(asin)) return { statusCode: 400, body: JSON.stringify({ error: 'Invalid ASIN' }) };
      // 1) remove the row from the sheet (so the sync won't re-add it)
      const res = await callGateway({ action: 'remove', asin });
      // 2) delete it from the site now (both the grid row AND any Top-Pick row)
      const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (sbUrl && sbKey) {
        await fetch(`${sbUrl}/rest/v1/deals?url=like.*${asin}*`, {
          method: 'DELETE',
          headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, Prefer: 'return=minimal' },
        }).catch(() => {});
      }
      return { statusCode: res.ok ? 200 : 502, body: JSON.stringify({ ...res, asin }) };
    }

    if (action === 'addsheet') {
      // Append to the sheet only (no grid insert) — used to keep coded Top Picks
      // recorded in the promo sheet so the two stay in sync.
      const asin = asinFromUrl(amazon_link);
      if (!asin) return { statusCode: 400, body: JSON.stringify({ error: 'No ASIN' }) };
      const res = await callGateway({ action: 'append', amazon_link: String(amazon_link), promo_code: String(promo_code || ''), discount_price: String(discount_price || '') });
      return { statusCode: res.ok ? 200 : 502, body: JSON.stringify({ ...res, asin }) };
    }

    if (action === 'promote' || action === 'demote') {
      const asin = (body.asin ? String(body.asin) : asinFromUrl(amazon_link)).toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(asin)) return { statusCode: 400, body: JSON.stringify({ error: 'Invalid ASIN' }) };
      const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!sbUrl || !sbKey) return { statusCode: 500, body: JSON.stringify({ error: 'Config error' }) };
      const sb = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };
      const today = new Date().toISOString().split('T')[0];
      // When sending a deal back to the grid, make sure it's in the sheet first,
      // so the promo sync keeps it instead of pruning it as "not in the sheet".
      if (action === 'demote' && amazon_link) {
        await callGateway({ action: 'append', amazon_link: String(amazon_link), promo_code: String(promo_code || ''), discount_price: String(discount_price || '') }).catch(() => {});
      }
      // Flip the existing row in place — no delete/insert, so no duplicate row.
      const from = action === 'promote' ? 'false' : 'true';
      const patch = action === 'promote' ? { is_top_pick: true, active_date: today } : { is_top_pick: false };
      const r = await fetch(`${sbUrl}/rest/v1/deals?url=like.*${asin}*&is_top_pick=eq.${from}`, {
        method: 'PATCH', headers: { ...sb, Prefer: 'return=minimal' }, body: JSON.stringify(patch),
      });
      return { statusCode: r.ok ? 200 : 502, body: JSON.stringify({ ok: r.ok, action, asin }) };
    }

    if (action === 'edit') {
      // Edit a deal in place (fix a wrong price, title, code, etc.). Matches by
      // row id so it touches exactly the one row. % off is recomputed here.
      const id = String(body.id || '');
      if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'Missing deal id' }) };
      const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!sbUrl || !sbKey) return { statusCode: 500, body: JSON.stringify({ error: 'Config error' }) };
      const sb = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };
      const patch = {};
      if (body.name != null) patch.name = String(body.name).slice(0, 250);
      if (body.code != null) patch.code = String(body.code);
      const price = parseFloat(String(body.price ?? '').replace(/[^0-9.]/g, ''));
      const was = parseFloat(String(body.was ?? '').replace(/[^0-9.]/g, ''));
      if (price > 0) patch.price = price;
      if (was > 0) patch.was = was;
      if (price > 0 && was > 0) patch.off = was > price ? Math.round((1 - price / was) * 100) : 0;
      if (!Object.keys(patch).length) return { statusCode: 400, body: JSON.stringify({ error: 'Nothing to update' }) };
      const r = await fetch(`${sbUrl}/rest/v1/deals?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { ...sb, Prefer: 'return=minimal' }, body: JSON.stringify(patch),
      });
      return { statusCode: r.ok ? 200 : 502, body: JSON.stringify({ ok: r.ok, action: 'edit', id }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'manage-code failed', detail: String(e).slice(0, 200) }) };
  }
};
