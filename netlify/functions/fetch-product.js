const TOKEN_ENDPOINT = 'https://api.amazon.com/auth/o2/token';
const ITEMS_ENDPOINT = 'https://creatorsapi.amazon/catalog/v1/getItems';
const MARKETPLACE    = 'www.amazon.com';
const AFFILIATE_TAG  = 'founditchea09-20';

const RESOURCES = [
  'images.primary.large',
  'images.variants.large',
  'itemInfo.title',
  'offersV2.listings.price',
  'offersV2.listings.dealDetails',
  'customerReviews.starRating',
  'customerReviews.count',
];

// In-process cache — reused across warm invocations in the same Lambda container
let _token = null;
let _tokenExp = 0;
let _creatorsEligible = true; // flipped to false on first AssociateNotEligible response

async function getCreatorsToken(clientId, clientSecret) {
  if (_token && Date.now() < _tokenExp - 60000) return _token;
  const res  = await fetch(TOKEN_ENDPOINT, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     clientId,
      client_secret: clientSecret,
      scope:         'creatorsapi::default',
    }).toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token fetch failed: ' + JSON.stringify(data));
  _token    = data.access_token;
  _tokenExp = Date.now() + (data.expires_in || 3600) * 1000;
  return _token;
}

// Try Creators API; returns null if account isn't eligible (falls back to Rainforest)
async function fetchViaCreators(asin, clientId, clientSecret) {
  if (!_creatorsEligible) return null;
  const token = await getCreatorsToken(clientId, clientSecret);
  const res   = await fetch(ITEMS_ENDPOINT, {
    method:  'POST',
    headers: {
      Authorization:   `Bearer ${token}`,
      'Content-Type':  'application/json',
      'x-marketplace': MARKETPLACE,
    },
    body: JSON.stringify({
      itemIds:     [asin],
      itemIdType:  'ASIN',
      resources:   RESOURCES,
      partnerTag:  AFFILIATE_TAG,
      partnerType: 'Associates',
      marketplace: MARKETPLACE,
    }),
  });
  const data = await res.json();

  // Account not yet eligible — cache result so subsequent warm calls skip Creators entirely.
  // Amazon returns this at the top level OR inside errors[].
  const reason = data.reason || data.errors?.[0]?.reason;
  if (reason === 'AssociateNotEligible') {
    _creatorsEligible = false;
    return null;
  }

  const item = data.itemsResult?.items?.[0];
  if (!item) return null;

  const primaryUrl  = item.images?.primary?.large?.url || '';
  const variantUrls = (item.images?.variants || []).map(v => v.large?.url).filter(Boolean);
  const images      = primaryUrl ? [primaryUrl, ...variantUrls] : variantUrls;

  const listing  = item.offersV2?.listings?.[0];
  const price    = listing?.price?.amount || 0;
  const dealDets = listing?.dealDetails || {};
  const was      = dealDets.originalPrice?.amount || price;
  const off      = dealDets.percentageSaved
    ? Math.round(dealDets.percentageSaved)
    : (was > price ? Math.round((1 - price / was) * 100) : 0);

  return {
    name:    item.itemInfo?.title?.displayValue || '',
    price,
    was,
    off,
    img:     primaryUrl,
    images,
    rating:  item.customerReviews?.starRating?.value || 0,
    reviews: item.customerReviews?.count || 0,
    coupon:  dealDets.coupon?.displayLabel || null,
    asin,
  };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let asin, productId;
  try {
    ({ asin, productId } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  if (!asin) {
    return { statusCode: 400, body: JSON.stringify({ error: 'ASIN required' }) };
  }

  try {
    let result = null;

    // Amazon Creators API only — Rainforest removed for Associates compliance.
    const clientId     = process.env.AMAZON_CREATORS_CLIENT_ID;
    const clientSecret = process.env.AMAZON_CREATORS_CLIENT_SECRET;
    if (clientId && clientSecret) {
      result = await fetchViaCreators(asin, clientId, clientSecret).catch(() => null);
    }

    if (!result) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Product not found' }) };
    }

    // Persist images + rating to Supabase for instant future loads (fire-and-forget)
    if (productId) {
      const sbUrl = process.env.SUPABASE_URL;
      const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (sbUrl && sbKey) {
        const patch = {};
        if (result.images.length >= 2) patch.images  = JSON.stringify(result.images);
        if (result.rating  > 0)        patch.rating  = result.rating;
        if (result.reviews > 0)        patch.reviews = result.reviews;
        if (Object.keys(patch).length > 0) {
          fetch(`${sbUrl}/rest/v1/deals?id=eq.${productId}`, {
            method:  'PATCH',
            headers: {
              apikey:         sbKey,
              Authorization:  `Bearer ${sbKey}`,
              'Content-Type': 'application/json',
              Prefer:         'return=minimal',
            },
            body: JSON.stringify(patch),
          }).catch(() => {});
        }
      }
    }

    return {
      statusCode: 200,
      headers:    { 'Content-Type': 'application/json' },
      body:       JSON.stringify(result),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to fetch product', detail: String(err) }),
    };
  }
};
