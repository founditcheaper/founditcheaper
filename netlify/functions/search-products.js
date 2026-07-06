// PROBE / DEMO: on-demand Amazon keyword search via the Creators API (parallel to
// fetch-product's getItems, but SearchItems by keywords). Returns a handful of matches so
// the admin "Deal Finder (Demo)" can show live products that aren't in our catalog yet.
// This is diagnostic: if the search endpoint isn't available/allowed it returns the raw
// error so we can see exactly what Amazon says, instead of pretending it worked.
//
// POST { keywords }

const TOKEN_ENDPOINT  = 'https://api.amazon.com/auth/o2/token';
// getItems lives at .../catalog/v1/getItems — try the sibling searchItems operation.
const SEARCH_ENDPOINT = 'https://creatorsapi.amazon/catalog/v1/searchItems';
const MARKETPLACE     = 'www.amazon.com';
const AFFILIATE_TAG   = 'founditchea09-20';

const RESOURCES = [
  'images.primary.large',
  'itemInfo.title',
  'offersV2.listings.price',
  'offersV2.listings.dealDetails',
  'customerReviews.starRating',
  'customerReviews.count',
];

let _token = null, _tokenExp = 0;
async function getToken(clientId, clientSecret) {
  if (_token && Date.now() < _tokenExp - 60000) return _token;
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret,
      scope: 'creatorsapi::default',
    }).toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('token: ' + JSON.stringify(data).slice(0, 200));
  _token = data.access_token;
  _tokenExp = Date.now() + (data.expires_in || 3600) * 1000;
  return _token;
}

function mapItem(item) {
  if (!item) return null;
  const primary = item.images?.primary?.large?.url || '';
  const listing = item.offersV2?.listings?.[0];
  const price = Number(listing?.price?.money?.amount ?? listing?.price?.amount) || 0;
  const deal = listing?.dealDetails || {};
  const was = Number(listing?.price?.savingBasis?.money?.amount ?? deal.originalPrice?.amount) || price;
  const off = deal.percentageSaved ? Math.round(deal.percentageSaved) : (was > price ? Math.round((1 - price / was) * 100) : 0);
  return {
    asin: item.asin || item.itemId || null,
    name: item.itemInfo?.title?.displayValue || '',
    price, was, off,
    img: primary,
    rating: item.customerReviews?.starRating?.value || 0,
    reviews: item.customerReviews?.count || 0,
    coupon: deal.coupon?.displayLabel || null,
  };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let keywords;
  try { ({ keywords } = JSON.parse(event.body || '{}')); }
  catch { return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) }; }
  keywords = String(keywords || '').trim().slice(0, 120);
  if (keywords.length < 2) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Enter a product to search' }) };

  const clientId = process.env.AMAZON_CREATORS_CLIENT_ID, clientSecret = process.env.AMAZON_CREATORS_CLIENT_SECRET;
  if (!clientId || !clientSecret) return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Amazon creds not set' }) };

  try {
    const token = await getToken(clientId, clientSecret);
    const res = await fetch(SEARCH_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-marketplace': MARKETPLACE },
      body: JSON.stringify({
        keywords,
        resources: RESOURCES,
        partnerTag: AFFILIATE_TAG,
        partnerType: 'Associates',
        marketplace: MARKETPLACE,
        itemCount: 8,
      }),
    });
    const raw = await res.text();
    let data = null; try { data = JSON.parse(raw); } catch (e) {}

    // Diagnostic passthrough so we can see exactly what the endpoint returns during the probe.
    if (!res.ok || !data) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, status: res.status, raw: raw.slice(0, 600) }) };
    }
    const reason = data.reason || data.errors?.[0]?.reason || data.errors?.[0]?.code;
    const list = data.searchResult?.items || data.itemsResult?.items || data.items || [];
    const items = list.map(mapItem).filter(function (x) { return x && x.name; });
    return { statusCode: 200, body: JSON.stringify({ ok: items.length > 0, count: items.length, reason: reason || null, items }) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: String(e).slice(0, 200) }) };
  }
};
