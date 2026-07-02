// Public "Submit Your Deals" intake (seller-facing form on submit-deal.html).
//
// 1) Stores the RAW submission (email + text) in `deal_submissions` — nothing is lost.
// 2) Parses each deal out of the text and inserts it into `deals` as review_status
//    ='pending', uploaded_by='Seller Submission', so it flows through the SAME scan
//    pipeline as agent deals (review-deals verifies + poison-scans → live/flagged).
//    Seller expiry dates become `ends_at`; expired seller deals drop off automatically.
//
// Compliant: product name/price/image come from the official Amazon API; the code,
// after-code price, and expiry are the seller's claim layered on a real ASIN.
// (sync-codes is patched to leave uploaded_by='Seller Submission' deals alone so they
//  aren't pruned for not being in the VA's sheet.)
//
// POST { email, deals, fileName?, fileText? }

const TOKEN_ENDPOINT = 'https://api.amazon.com/auth/o2/token';
const ITEMS_ENDPOINT = 'https://creatorsapi.amazon/catalog/v1/getItems';
const MARKETPLACE    = 'www.amazon.com';
const AFFILIATE_TAG  = 'founditchea09-20';
const SELLER_TAG     = 'Seller Submission';
const MAX_DEALS      = 40;   // per submission — safety cap

function extractAsin(url) {
  const s = String(url || '');
  const m = s.match(/(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/product\/|[?&]asin=)([A-Z0-9]{10})/i);
  if (m) return m[1].toUpperCase();
  const b = s.match(/\b(B0[A-Z0-9]{8})\b/i);
  return b ? b[1].toUpperCase() : null;
}

// Human date string -> YYYY-MM-DD, or '' if not sensible / not within ~2 years.
function parseExpiry(v) {
  if (!v) return '';
  v = String(v).trim().replace(/(\d)(st|nd|rd|th)/gi, '$1');
  let d = new Date(v);
  if (isNaN(d.getTime())) {
    const m = v.match(/^(\d{1,2})[\/\-](\d{1,2})$/);   // MM/DD -> assume this year
    if (m) d = new Date(new Date().getFullYear(), +m[1] - 1, +m[2]);
  }
  if (isNaN(d.getTime())) return '';
  const now = Date.now(), t = d.getTime();
  if (t < now - 2 * 86400000 || t > now + 730 * 86400000) return '';
  return d.toISOString().slice(0, 10);
}

// Turn the pasted text into an array of { asin, code, sale, orig, expires, title }.
function parseSubmittedDeals(text) {
  if (!text) return [];
  const blocks = String(text).split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  const deals = [];
  for (const block of blocks) {
    if (deals.length >= MAX_DEALS) break;
    const asin = extractAsin(block);
    if (!asin) continue;
    const get = (labels) => {
      for (const line of block.split('\n')) {
        const m = line.match(/^[\s*>\-]*([A-Za-z ]+?)\s*[:\-]\s*(.+)$/);
        if (m) { const key = m[1].trim().toLowerCase(); if (labels.some(l => key.includes(l))) return m[2].trim(); }
      }
      return '';
    };
    const price = (labels) => { const n = parseFloat(String(get(labels)).replace(/[^0-9.]/g, '')); return isFinite(n) && n > 0 ? n : 0; };
    deals.push({
      asin,
      code:    get(['promo code', 'discount code', 'coupon code', 'code']).replace(/[^A-Za-z0-9]/g, '').toUpperCase(),
      sale:    price(['sale price', 'discount price', 'deal price', 'after code', 'after-code', 'price']),
      orig:    price(['original price', 'retail price', 'list price', 'regular price', 'was']),
      expires: parseExpiry(get(['expiration date', 'expiration', 'expires', 'expiry', 'end date', 'ends', 'valid until', 'valid through', 'good through'])),
      title:   get(['product name', 'product title', 'title', 'item', 'product', 'name']).slice(0, 250),
    });
  }
  return deals;
}

function inferCategory(text) {
  const t = (text || '').toLowerCase();
  if (/\bbaby\b|infant|newborn|toddler|diaper|stroller|\bcrib\b|pacifier|nursing|breast ?pump|baby monitor|onesie|sippy/.test(t)) return 'Baby Products';
  if (/\bdog\b|\bcat\b|puppy|kitten|\bpet\b|\bleash\b|litter box|aquarium|fish tank|chew toy|pet bed|\bflea\b|\bkennel\b|pet supplies/.test(t)) return 'Pet Supplies';
  if (/\btoys?\b|\blego\b|puzzle|board game|\bdoll\b|action figure|\bnerf\b|building blocks|stuffed animal|rc car/.test(t)) return 'Toys & Games';
  if (/automotive|\bcar\b|\btruck\b|\btire\b|dash ?cam|motor oil|windshield|jump starter|\bbrake|headlight|\bwiper|\bobd\b|seat cover/.test(t)) return 'Automotive';
  if (/phone case|screen protector|iphone|galaxy s\d|pixel \d|charging (cable|station)|phone (holder|mount|grip)|airpods|wireless charger|power bank|magsafe/.test(t)) return 'Cell Phones & Accessories';
  if (/\btools?\b|hardware|\bdrill\b|\bsaw\b|wrench|screwdriver|power tool|cordless|\bsander\b|grinder|pliers|\bladder\b|air compressor|\bhammer\b|tool ?(box|set)|drill bit|tape measure|\bfaucet\b|plumbing/.test(t)) return 'Tools & Home Improvement';
  if (/garden|\blawn\b|\bplant\b|\bseed|\bsoil\b|fertilizer|\bhose\b|sprinkler|pruner|\bmower\b|leaf blower|\bpatio\b|\bgrill\b|fire pit|string trimmer|outdoor furniture/.test(t)) return 'Patio, Lawn & Garden';
  if (/appliance|refrigerator|washing machine|\bwasher\b|\bdryer\b|dishwasher|microwave|\bfreezer\b|mini fridge|ice maker|\bstove\b|dehumidifier/.test(t)) return 'Appliances';
  if (/kitchen|air fryer|coffee maker|\bblender\b|instant pot|cookware|knife set|toaster|bakeware|skillet|espresso|keurig|\bpot\b|\bpan\b|mattress|\bpillow\b|bedding|\btowel|curtain|\brug\b|\blamp\b|furniture|\bsofa\b|organizer|storage (bin|box)|\bvacuum\b|\bmop\b|blanket|\bhome\b/.test(t)) return 'Home & Kitchen';
  if (/\bhealth\b|vitamin|supplement|protein powder|first aid|thermometer|toilet paper|paper towel|\bcleaning|detergent|sanitizer|pain relief|melatonin/.test(t)) return 'Health & Household';
  if (/beauty|makeup|skincare|\bserum\b|shampoo|conditioner|\blotion\b|perfume|cologne|\brazor\b|beard trimmer|hair (trimmer|clipper|dryer)|moisturizer|electric shaver|sunscreen/.test(t)) return 'Beauty & Personal Care';
  if (/electronic|headphone|earbud|\bspeaker\b|\btv\b|television|laptop|\btablet\b|smart ?watch|\bcamera\b|keyboard|\bmouse\b|monitor|projector|\bssd\b|hard drive|webcam|soundbar|\brouter\b|\bhdmi\b|\bdrone\b/.test(t)) return 'Electronics';
  if (/clothing|apparel|\bshirt\b|t-?shirt|\bshoes\b|sneaker|\bboots\b|\bjacket\b|\bjeans\b|\bdress\b|\bwatch\b|\bsocks\b|hoodie|\bhat\b|sunglasses|jewelry|necklace|\bring\b|leggings|\bbelt\b|\bwallet\b|handbag/.test(t)) return 'Clothing, Shoes & Jewelry';
  if (/sports|outdoor|dumbbell|barbell|workout|\byoga\b|exercise|fitness|treadmill|\bgym\b|resistance band|massage gun|camping|hiking|\btent\b|sleeping bag|backpack|\bcooler\b|fishing|\bbike\b|\bhelmet\b/.test(t)) return 'Sports & Outdoors';
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
    body: JSON.stringify({ itemIds: [asin], itemIdType: 'ASIN', resources: ['images.primary.large', 'itemInfo.title', 'itemInfo.byLineInfo', 'offersV2.listings.price', 'customerReviews.starRating', 'customerReviews.count'], partnerTag: AFFILIATE_TAG, partnerType: 'Associates', marketplace: MARKETPLACE }),
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

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) }; }

  const email    = String(body.email || '').trim().toLowerCase().slice(0, 200);
  const deals    = String(body.deals || '').trim().slice(0, 20000);
  const fileName = String(body.fileName || '').slice(0, 200);
  const fileText = String(body.fileText || '').slice(0, 200000);

  if (!email.includes('@')) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Please enter a valid email.' }) };
  if (!deals && !fileText)  return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Please paste at least one deal or attach a file.' }) };

  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Config error' }) };
  const sb = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  // 1) Always store the raw submission first (never lose it).
  try {
    await fetch(`${sbUrl}/rest/v1/deal_submissions`, {
      method: 'POST', headers: { ...sb, Prefer: 'return=minimal' },
      body: JSON.stringify({ email, deals_text: deals, file_name: fileName || null, file_text: fileText || null }),
    });
  } catch (e) { /* non-fatal — still try to import below */ }

  // 2) Parse + insert each deal as PENDING (uploaded_by='Seller Submission').
  const parsed = parseSubmittedDeals(deals + '\n\n' + fileText);
  let imported = 0;
  let token = null;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

  for (const d of parsed) {
    let prod = null;
    try { if (!token) token = await getToken(); prod = await fetchProduct(d.asin, token); } catch (e) { /* API may be ineligible/down */ }
    const apiPrice = (prod && prod.apiPrice) || 0;
    const price = d.sale > 0 ? d.sale : apiPrice;                 // after-code price (seller wins)
    if (!(price > 0)) continue;                                  // can't price it -> leave in raw submission only
    let was = Math.max(apiPrice, d.orig, price);
    if (!(was > 0)) was = price;
    const off = was > price ? Math.round((1 - price / was) * 100) : 0;
    const name = (prod && prod.name) ? prod.name : (d.title || ('Amazon deal ' + d.asin));

    const row = {
      rank: 900, name: name.slice(0, 250), store: 'Amazon', category: inferCategory(name),
      price, was, off, rating: (prod && prod.rating) || 0, reviews: (prod && prod.reviews) || 0,
      img: (prod && prod.img) || '', images: null,
      url: `https://www.amazon.com/dp/${d.asin}?tag=${AFFILIATE_TAG}`,
      code: d.code || null, use_code_url: false, creator: false, brand: false,
      brand_name: (prod && prod.brandName) || null, active_date: today, is_top_pick: false,
      uploaded_by: SELLER_TAG, review_status: 'pending',
      ends_at: d.expires ? (d.expires + 'T23:59:59Z') : null,
    };
    try {
      // Only clear a PRIOR PENDING SELLER row for this ASIN (i.e. a re-submit) — never
      // touch live deals or anyone else's deals. A public form must not delete live rows.
      await fetch(`${sbUrl}/rest/v1/deals?url=like.*${d.asin}*&uploaded_by=eq.Seller%20Submission&review_status=eq.pending`, { method: 'DELETE', headers: { ...sb, Prefer: 'return=minimal' } }).catch(() => {});
      let ins = await fetch(`${sbUrl}/rest/v1/deals`, { method: 'POST', headers: { ...sb, Prefer: 'return=minimal' }, body: JSON.stringify(row) });
      if (!ins.ok) {
        // ends_at column may be missing — retry WITHOUT it but KEEP review_status='pending',
        // so a seller deal never slips onto the site unreviewed. If that still fails, skip it
        // (leave it in the raw submission) rather than publish it live.
        const noEnds = { ...row }; delete noEnds.ends_at;
        ins = await fetch(`${sbUrl}/rest/v1/deals`, { method: 'POST', headers: { ...sb, Prefer: 'return=minimal' }, body: JSON.stringify(noEnds) });
      }
      if (ins.ok) imported++;
    } catch (e) { /* skip this one */ }
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, imported, parsed: parsed.length }) };
};
