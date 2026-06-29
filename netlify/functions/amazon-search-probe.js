// TEMPORARY probe — one Creators API searchItems call, returns the raw response
// so we can see the exact shape (where items live, or the real error). Delete after.
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

exports.handler = async function (event) {
  const q = (event.queryStringParameters && event.queryStringParameters.q) || 'cordless drill';
  const withMin = !(event.queryStringParameters && event.queryStringParameters.nomin === '1');
  const out = {};
  try {
    const token = await getToken();
    out.gotToken = !!token;
    const body = {
      keywords: q,
      itemCount: 5,
      resources: ['itemInfo.title', 'offersV2.listings.price', 'offersV2.listings.dealDetails', 'images.primary.large'],
      partnerTag: 'founditchea09-20',
      partnerType: 'Associates',
      marketplace: 'www.amazon.com',
    };
    if (withMin) body.minSavingPercent = 20;
    const res = await fetch('https://creatorsapi.amazon/catalog/v1/searchItems', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-marketplace': 'www.amazon.com' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    out.httpStatus = res.status;
    out.rawBody = text.slice(0, 2200);
  } catch (e) {
    out.exception = String(e).slice(0, 300);
  }
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out, null, 2) };
};
