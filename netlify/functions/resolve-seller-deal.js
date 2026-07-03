// Resolve a Pending seller promo-code-link deal.
//
// Seller submissions that came in via a /promocode/ link have no ASIN, so they land
// Pending with no image. The Seller-Deal-Upload agent opens the promo link in a real
// browser, follows it to the actual product page, reads the ASIN (and grabs the product
// image URL as a fallback), then calls this endpoint. We fetch the official Amazon
// image / name / regular price via the Creators API and enrich the deal — while KEEPING
// the promo-code link as the buy button (it auto-applies the code at cart). The deal
// stays Pending for the owner's one-click approval.
//
// GET  ?password=...          -> the work queue: Pending seller deals that still need an image.
// POST { password, dealId, asin, imageUrl? }  -> enrich one resolved deal.

const TOKEN_ENDPOINT = 'https://api.amazon.com/auth/o2/token';
const ITEMS_ENDPOINT = 'https://creatorsapi.amazon/catalog/v1/getItems';
const MARKETPLACE    = 'www.amazon.com';

function inferCategory(text) {
  const t = (text || '').toLowerCase();
  if (/\bbaby\b|infant|newborn|toddler|diaper|stroller|\bcrib\b|pacifier|nursing|breast ?pump|baby monitor/.test(t)) return 'Baby Products';
  if (/\bdog\b|\bcat\b|puppy|kitten|\bpet\b|\bleash\b|litter box|aquarium|chew toy|pet bed|pet supplies/.test(t)) return 'Pet Supplies';
  if (/\btoys?\b|\blego\b|puzzle|board game|\bdoll\b|action figure|\bnerf\b|building blocks|stuffed animal/.test(t)) return 'Toys & Games';
  if (/automotive|\bcar\b|\btruck\b|\btire\b|dash ?cam|motor oil|windshield|jump starter|\bbrake|headlight|seat cover/.test(t)) return 'Automotive';
  if (/phone case|screen protector|iphone|galaxy s\d|pixel \d|charging (cable|station)|airpods|wireless charger|power bank|magsafe/.test(t)) return 'Cell Phones & Accessories';
  if (/\btools?\b|hardware|\bdrill\b|\bsaw\b|wrench|screwdriver|power tool|cordless|pliers|\bladder\b|air compressor|\bhammer\b|tool ?(box|set)|\bfaucet\b|plumbing/.test(t)) return 'Tools & Home Improvement';
  if (/garden|\blawn\b|\bplant\b|\bseed|\bsoil\b|fertilizer|\bhose\b|sprinkler|\bmower\b|leaf blower|\bpatio\b|\bgrill\b|fire pit|string trimmer/.test(t)) return 'Patio, Lawn & Garden';
  if (/appliance|refrigerator|washing machine|\bwasher\b|\bdryer\b|dishwasher|microwave|\bfreezer\b|mini fridge|\bstove\b/.test(t)) return 'Appliances';
  if (/kitchen|air fryer|coffee maker|\bblender\b|instant pot|cookware|knife set|toaster|espresso|keurig|\bpot\b|\bpan\b|mattress|\bpillow\b|bedding|\btowel|curtain|\brug\b|\blamp\b|furniture|organizer|\bvacuum\b|\bmop\b|\bhome\b/.test(t)) return 'Home & Kitchen';
  if (/\bhealth\b|vitamin|supplement|protein powder|first aid|thermometer|toilet paper|paper towel|\bcleaning|detergent|sanitizer|pain relief|melatonin/.test(t)) return 'Health & Household';
  if (/beauty|makeup|skincare|\bserum\b|shampoo|conditioner|\blotion\b|perfume|cologne|\brazor\b|beard trimmer|hair (trimmer|clipper|dryer)|moisturizer|sunscreen|lipstick/.test(t)) return 'Beauty & Personal Care';
  if (/electronic|headphone|earbud|\bspeaker\b|\btv\b|television|laptop|\btablet\b|smart ?watch|\bcamera\b|keyboard|\bmouse\b|monitor|projector|\bssd\b|hard drive|soundbar|\brouter\b/.test(t)) return 'Electronics';
  if (/clothing|apparel|\bshirt\b|t-?shirt|\bshoes\b|sneaker|\bboots\b|\bjacket\b|\bjeans\b|\bdress\b|\bwatch\b|hoodie|\bhat\b|sunglasses|jewelry|necklace|\bring\b|leggings|\bwallet\b|handbag/.test(t)) return 'Clothing, Shoes & Jewelry';
  if (/sports|outdoor|dumbbell|barbell|workout|\byoga\b|exercise|fitness|treadmill|resistance band|massage gun|camping|hiking|\btent\b|sleeping bag|backpack|\bcooler\b|fishing|\bbike\b/.test(t)) return 'Sports & Outdoors';
  return 'Everything Else';
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
    body: JSON.stringify({ itemIds: [asin], itemIdType: 'ASIN', resources: ['images.primary.large', 'itemInfo.title', 'itemInfo.byLineInfo', 'offersV2.listings.price', 'customerReviews.starRating', 'customerReviews.count'], partnerTag: 'founditchea09-20', partnerType: 'Associates', marketplace: MARKETPLACE }),
  });
  const data = await res.json();
  const item = data.itemsResult?.items?.[0];
  if (!item) return null;
  const listing = item.offersV2?.listings?.[0];
  return {
    name: item.itemInfo?.title?.displayValue || '',
    apiPrice: Number(listing?.price?.money?.amount ?? listing?.price?.amount) || 0,
    img: item.images?.primary?.large?.url || '',
    rating: item.customerReviews?.starRating?.value || 0,
    reviews: item.customerReviews?.count || 0,
    brandName: item.itemInfo?.byLineInfo?.brand?.displayValue || '',
  };
}

function authed(password) {
  return (process.env.ADMIN_PASSWORD && password === process.env.ADMIN_PASSWORD)
      || (process.env.VA_PASSWORD && password === process.env.VA_PASSWORD)
      || (process.env.AGENT_PASSWORD && password === process.env.AGENT_PASSWORD);
}

exports.handler = async function (event) {
  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Config error' }) };
  const sb = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  // GET = the work queue: Pending seller deals still missing an image (the promo-link ones).
  if (event.httpMethod === 'GET') {
    if (!authed((event.queryStringParameters || {}).password)) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized' }) };
    try {
      const q = `${sbUrl}/rest/v1/deals?uploaded_by=eq.Seller%20Submission&review_status=eq.pending&or=(img.is.null,img.eq.)&select=id,url,name,code,price,was&order=created_at.asc&limit=100`;
      const r = await fetch(q, { headers: sb });
      const rows = await r.json();
      return { statusCode: 200, body: JSON.stringify({ ok: true, count: Array.isArray(rows) ? rows.length : 0, deals: Array.isArray(rows) ? rows : [] }) };
    } catch (e) { return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'query failed' }) }; }
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) }; }

  if (!authed(body.password)) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized' }) };

  const dealId = String(body.dealId || '').trim();
  const asin   = String(body.asin || '').trim().toUpperCase();
  const imageUrl = String(body.imageUrl || '').trim();
  if (!dealId) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing dealId' }) };
  if (!/^[A-Z0-9]{10}$/.test(asin)) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid ASIN' }) };

  // Load the deal (need its current after-code price to recompute % off).
  let deal;
  try {
    const dr = await fetch(`${sbUrl}/rest/v1/deals?id=eq.${encodeURIComponent(dealId)}&select=price,was,name&limit=1`, { headers: sb });
    deal = (await dr.json())[0];
  } catch (e) {}
  if (!deal) return { statusCode: 404, body: JSON.stringify({ ok: false, error: 'Deal not found' }) };

  // Official product data via the Creators API. If the API can't resolve it, we can
  // still set the image the agent grabbed off the page (image only — never a scraped price).
  let prod = null;
  try { prod = await fetchProduct(asin, await getToken()); } catch (e) {}

  const patch = {};
  if (prod && prod.name) patch.name = prod.name.slice(0, 250);
  const img = (prod && prod.img) || imageUrl;
  if (img) patch.img = img;
  const price = Number(deal.price) || 0;
  const apiPrice = (prod && prod.apiPrice) || 0;
  if (apiPrice > 0 || Number(deal.was) > 0) {
    const was = Math.max(apiPrice, Number(deal.was) || 0, price);
    patch.was = was;
    patch.off = was > price ? Math.round((1 - price / was) * 100) : 0;
  }
  if (prod && prod.rating)  patch.rating = prod.rating;
  if (prod && prod.reviews) patch.reviews = prod.reviews;
  if (prod && prod.brandName) patch.brand_name = prod.brandName;
  const catName = (prod && prod.name) || deal.name || '';
  if (catName) patch.category = inferCategory(catName);

  if (!Object.keys(patch).length || !patch.img) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, resolved: false, error: 'Could not get an image for this ASIN — Amazon API may be down. Try again, or grab the product image URL and pass it as imageUrl.' }) };
  }

  try {
    const r = await fetch(`${sbUrl}/rest/v1/deals?id=eq.${encodeURIComponent(dealId)}`, {
      method: 'PATCH', headers: { ...sb, Prefer: 'return=minimal' }, body: JSON.stringify(patch),
    });
    if (!r.ok) { const detail = await r.text(); return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'update failed', detail: detail.slice(0, 160) }) }; }
  } catch (e) { return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'resolve failed', detail: String(e).slice(0, 160) }) }; }

  // Deal keeps its promo-code buy link + code + price; it now has an image and stays
  // Pending for the owner to approve.
  return { statusCode: 200, body: JSON.stringify({ ok: true, resolved: true, asin, name: patch.name || deal.name, hasImage: !!patch.img }) };
};
