// TEMPORARY probe — checks whether the Amazon Creators API exposes PROMOTIONS
// (promo code / promotion IDs) on offers. Returns raw responses so we can see if
// we can get Amazon promo codes compliantly via the API. Delete after.
async function getToken() {
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.AMAZON_CREATORS_CLIENT_ID,
      client_secret: process.env.AMAZON_CREATORS_CLIENT_SECRET,
      scope: 'creatorsapi::default',
    }).toString(),
  });
  const d = await res.json();
  return d.access_token;
}

async function searchWith(token, resources, q) {
  const res = await fetch('https://creatorsapi.amazon/catalog/v1/searchItems', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-marketplace': 'www.amazon.com' },
    body: JSON.stringify({
      keywords: q || 'cordless drill',
      itemCount: 5,
      resources,
      partnerTag: 'founditchea09-20',
      partnerType: 'Associates',
      marketplace: 'www.amazon.com',
    }),
  });
  const text = await res.text();
  return { status: res.status, raw: text.slice(0, 2500) };
}

exports.handler = async function () {
  const out = {};
  try {
    const token = await getToken();
    out.gotToken = !!token;
    // Try several candidate promotion-related resource names; invalid ones will
    // surface as an error so we learn the correct name.
    const candidates = [
      'offersV2.listings.promotions',
      'offersV2.listings.promotion',
      'offersV2.listings.dealDetails',
      'promotions',
    ];
    out.byResource = {};
    for (const r of candidates) {
      out.byResource[r] = await searchWith(token, ['itemInfo.title', r], 'cordless drill');
    }
    // Also a full pull with a rich offer resource set to see everything offers expose
    out.fullOffers = await searchWith(token, [
      'itemInfo.title',
      'offersV2.listings.price',
      'offersV2.listings.dealDetails',
      'offersV2.listings.promotions',
    ], 'beauty');
  } catch (e) {
    out.exception = String(e).slice(0, 300);
  }
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out, null, 2) };
};
