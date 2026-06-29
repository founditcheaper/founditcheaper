// TEMPORARY diagnostic — checks whether the Amazon Creators API is live for this
// account. Read-only: obtains a token and does one getItems lookup. No DB writes,
// no secrets returned in the response. Safe to delete after use.
const TOKEN_ENDPOINT = 'https://api.amazon.com/auth/o2/token';
const ITEMS_ENDPOINT = 'https://creatorsapi.amazon/catalog/v1/getItems';
const MARKETPLACE     = 'www.amazon.com';

function resp(o) {
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o, null, 2) };
}

exports.handler = async function (event) {
  const clientId     = process.env.AMAZON_CREATORS_CLIENT_ID;
  const clientSecret = process.env.AMAZON_CREATORS_CLIENT_SECRET;
  const out = { hasClientId: !!clientId, hasClientSecret: !!clientSecret };
  if (!clientId || !clientSecret) return resp(out);

  const q    = event.queryStringParameters || {};
  const tag  = q.tag  || 'founditchea09-20';
  const asin = q.asin || 'B08C1W5N87';
  out.tagTested  = tag;
  out.asinTested = asin;

  // 1. OAuth token
  let token;
  try {
    const r = await fetch(TOKEN_ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     clientId,
        client_secret: clientSecret,
        scope:         'creatorsapi::default',
      }).toString(),
    });
    const d = await r.json();
    out.tokenHttpStatus = r.status;
    out.tokenObtained   = !!d.access_token;
    if (!d.access_token) {
      out.tokenError = (d.error || d.error_description || JSON.stringify(d)).slice(0, 200);
      return resp(out);
    }
    token = d.access_token;
  } catch (e) {
    out.tokenException = String(e).slice(0, 200);
    return resp(out);
  }

  // 2. getItems lookup
  try {
    const r = await fetch(ITEMS_ENDPOINT, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-marketplace': MARKETPLACE },
      body: JSON.stringify({
        itemIds:     [asin],
        itemIdType:  'ASIN',
        resources:   ['itemInfo.title', 'offersV2.listings.price'],
        partnerTag:  tag,
        partnerType: 'Associates',
        marketplace: MARKETPLACE,
      }),
    });
    const rawText = await r.text();
    out.getItemsHttpStatus = r.status;
    out.rawBody = rawText.slice(0, 700);
    let d = {};
    try { d = JSON.parse(rawText); } catch {}
    const err = d.errors && d.errors[0];
    if (err) {
      out.errorType    = err.type;
      out.errorReason  = err.reason;
      out.errorMessage = (err.message || '').slice(0, 200);
    }
    const item = d.itemsResult && d.itemsResult.items && d.itemsResult.items[0];
    out.itemReturned = !!item;
    if (item) {
      out.sampleTitle = (item.itemInfo?.title?.displayValue || '').slice(0, 60);
      out.samplePrice = item.offersV2?.listings?.[0]?.price?.amount ?? null;
    }
  } catch (e) {
    out.getItemsException = String(e).slice(0, 200);
  }

  out.verdict = out.itemReturned
    ? 'LIVE — Amazon Creators API is returning product data'
    : (out.errorReason === 'AssociateNotEligible'
        ? 'NOT YET ELIGIBLE — still gated (review window or criteria)'
        : 'NO DATA — see error fields');
  return resp(out);
};
