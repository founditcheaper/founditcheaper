// Promo-code deal sync — reads a published Google Sheet (CSV) of promo codes that
// Erik's VA maintains, and turns each row into a live Amazon deal on the site.
//
// Sheet columns (row 1 headers, lowercase):
//   amazon_link      — the Amazon product URL (any tag; we strip it and apply ours)
//   promo_code       — the checkout code, e.g. SAVE20
//   discount_price   — the AFTER-code price (the one thing the API can't know)
//   expires          — OPTIONAL end date (YYYY-MM-DD) if the deal site shows one
//
// Behavior:
//   * The SHEET is the source of truth. Row added -> deal added (live API price +
//     code overlay). Row deleted -> deal removed on the next run.
//   * 5-DAY auto-expiry: any coded deal older than 5 days drops off (codes churn
//     fast). An explicit `expires` only ever makes it expire SOONER, never later.
//   * Dedup by ASIN. A coded deal BEATS an auto-discovered one (sync-deals): when
//     we add a code for an ASIN, any plain auto deal for that ASIN is removed.
//   * Compliant: the displayed regular price comes from the official Amazon API;
//     only the after-code price + code string come from the sheet (a promo claim).
//   * Incremental + time-capped: only NEW rows hit the rate-limited Amazon API, so
//     a normal run is fast. Big bulk drops fill in over a few runs.
//
// Triggered on a schedule (see netlify.toml) and on demand via the admin
// "Sync now" button (GET/POST with ?key=ADMIN_PASSWORD).

const TOKEN_ENDPOINT = 'https://api.amazon.com/auth/o2/token';
const ITEMS_ENDPOINT = 'https://creatorsapi.amazon/catalog/v1/getItems';
const MARKETPLACE    = 'www.amazon.com';
const AFFILIATE_TAG  = 'founditchea09-20';

const MAX_AGE_DAYS = 5;       // hard cap — nothing lingers longer than this
const TIME_CAP_MS  = 20000;   // stay inside the function limit; rest fills in next run
const API_SPACING  = 1200;    // ~1 req/sec — respect the Creators API rate limit

const RESOURCES = [
  'images.primary.large',
  'images.variants.large',
  'itemInfo.title',
  'itemInfo.byLineInfo',
  'offersV2.listings.price',
  'offersV2.listings.dealDetails',
  'customerReviews.starRating',
  'customerReviews.count',
];

// Maps a product title to an Amazon-department-style category.
// Order matters — most specific / least ambiguous checks come first.
function inferCategory(text) {
  const t = (text || '').toLowerCase();
  if (/\bbaby\b|infant|newborn|toddler|diaper|stroller|\bcrib\b|pacifier|nursing|breast ?pump|baby monitor|onesie|sippy/.test(t)) return 'Baby Products';
  if (/\bdog\b|\bcat\b|puppy|kitten|\bpet\b|\bleash\b|litter box|aquarium|fish tank|chew toy|pet bed|\bflea\b|\bkennel\b|dog food|cat food|pet supplies/.test(t)) return 'Pet Supplies';
  if (/\btoys?\b|\blego\b|jigsaw|puzzle|board game|\bdoll\b|action figure|\bnerf\b|building blocks|play ?set|stuffed animal|rc car|remote control car|play kitchen/.test(t)) return 'Toys & Games';
  if (/automotive|\bcar\b|\btruck\b|\btire\b|dash ?cam|motor oil|windshield|\bvehicle\b|jump starter|\bbrake|headlight|\bwiper|\bobd\b|\bsuv\b|\batv\b|car cover|seat cover|car wash/.test(t)) return 'Automotive';
  if (/alexa|echo dot|echo show|fire tv|fire stick|fire tablet|ring doorbell|blink (camera|mini)|\becho\b/.test(t)) return 'Amazon Devices & Accessories';
  if (/phone case|screen protector|iphone|galaxy s\d|pixel \d|charging cable|phone (holder|mount|grip)|airpods|wireless charger|power bank|usb-?c cable|lightning cable/.test(t)) return 'Cell Phones & Accessories';
  if (/\bps5\b|\bps4\b|\bxbox\b|nintendo switch|playstation|video game|game controller|gaming controller|joy-?con|dualsense/.test(t)) return 'Video Games';
  if (/musical instrument|\bguitar\b|\bpiano\b|drum (set|kit)|\bviolin\b|ukulele|amplifier|midi keyboard|saxophone|trumpet|bass guitar/.test(t)) return 'Musical Instruments';
  if (/\btools?\b|hardware|\bdrill\b|\bsaw\b|wrench|screwdriver|power tool|cordless|nail(er| gun)|\bsander\b|grinder|\bsocket|pliers|\bladder\b|air compressor|\bhammer\b|tool ?box|tool ?set|workbench|drill bit|tape measure|utility knife|caulk|\bfaucet\b|plumbing|stud finder/.test(t)) return 'Tools & Home Improvement';
  if (/garden|\blawn\b|\bplant\b|\bseed|\bsoil\b|fertilizer|\bhose\b|sprinkler|greenhouse|pruner|\bmower\b|hedge|leaf blower|\bpatio\b|\bgrill\b|fire pit|gazebo|wheelbarrow|\bweed\b|string trimmer|outdoor furniture|raised bed/.test(t)) return 'Patio, Lawn & Garden';
  if (/appliance|refrigerator|washing machine|\bwasher\b|\bdryer\b|dishwasher|microwave|\bfreezer\b|mini fridge|ice maker|range hood|cooktop|\bstove\b|dehumidifier/.test(t)) return 'Appliances';
  if (/kitchen|air fryer|coffee maker|\bblender\b|instant pot|cookware|knife set|cutting board|toaster|bakeware|skillet|espresso|keurig|food processor|pressure cooker|\bpot\b|\bpan\b|dish (rack|set)|mattress|\bpillow\b|bedding|sheet set|\btowel|curtain|\brug\b|\blamp\b|furniture|\bsofa\b|\bcouch\b|organizer|storage (bin|box)|\bvacuum\b|\bmop\b|comforter|blanket|dinnerware|flatware|spatula|\bhome\b/.test(t)) return 'Home & Kitchen';
  if (/grocery|\bfood\b|\bsnack|\bcandy\b|chocolate|coffee beans|ground coffee|\btea\b|protein bar|\bsauce\b|\bspice|seasoning|beverage|drink mix|gummies|\bhoney\b|olive oil|\bjerky\b|\bcereal\b|\bcoffee\b/.test(t)) return 'Grocery & Gourmet Food';
  if (/\bhealth\b|vitamin|supplement|protein powder|first aid|thermometer|toilet paper|paper towel|\bcleaning|detergent|sanitizer|face mask|probiotic|pain relief|bandage|ibuprofen|collagen|melatonin|disinfect/.test(t)) return 'Health & Household';
  if (/beauty|makeup|skincare|\bserum\b|shampoo|conditioner|\blotion\b|perfume|cologne|\brazor\b|beard trimmer|hair (trimmer|clipper|dryer)|nail (polish|kit)|lipstick|moisturizer|electric shaver|sunscreen|foundation|mascara|cosmetic/.test(t)) return 'Beauty & Personal Care';
  if (/office|printer|ink cartridge|\btoner\b|\bpens?\b|notebook|\bdesk\b|office chair|stapler|label maker|planner|\bbinder\b|shredder|calculator|sticky notes|file cabinet/.test(t)) return 'Office Products';
  if (/electronic|headphone|earbud|\bspeaker\b|\btv\b|television|laptop|\btablet\b|smart ?watch|\bcamera\b|\bconsole\b|keyboard|\bmouse\b|monitor|projector|\bssd\b|hard drive|webcam|soundbar|\brouter\b|\bmodem\b|\bcharger\b|\bhdmi\b|\bdrone\b|smart home/.test(t)) return 'Electronics';
  if (/clothing|apparel|footwear|\bshirt\b|t-?shirt|\bshoes\b|sneaker|\bboots\b|\bjacket\b|\bjeans\b|\bdress\b|\bwatch\b|\bsocks\b|hoodie|\bhat\b|\bcap\b|sunglasses|jewelry|necklace|bracelet|\bring\b|earrings|\bbra\b|leggings|sandals|\bbelt\b|\bwallet\b|\bpurse\b|handbag|\bcoat\b|sweater|underwear/.test(t)) return 'Clothing, Shoes & Jewelry';
  if (/sports|outdoor|dumbbell|barbell|workout|\byoga\b|exercise|fitness|treadmill|\bgym\b|weight set|resistance band|massage gun|camping|hiking|\btent\b|sleeping bag|backpack|\bcooler\b|fishing|kayak|\bpaddle|hammock|\bgolf\b|basketball|bicycle|\bbike\b|\bhelmet\b|skateboard|football/.test(t)) return 'Sports & Outdoors';
  if (/arts.{0,4}crafts|sewing|\byarn\b|knitting|crochet|paint brush|\bcanvas\b|\bcraft|\bbeads\b|embroidery|scrapbook|\bsticker|acrylic paint|glue gun|\bfabric\b|quilting/.test(t)) return 'Arts, Crafts & Sewing';
  if (/industrial|microscope|\blab\b|safety glasses|work gloves|\btarp\b|generator|multimeter|hand truck|\bdolly\b|\bcaster|telescope/.test(t)) return 'Industrial & Scientific';
  return 'Everything Else';
}

// ── ASIN extraction from any Amazon URL ────────────────────────────────────
function extractAsin(url) {
  if (!url) return null;
  const u = String(url);
  const path = u.match(/(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/product\/|[?&]asin=)([A-Z0-9]{10})/i);
  if (path) return path[1].toUpperCase();
  // Fallback: a bare 10-char ASIN-looking token (Amazon ASINs are usually B0...)
  const bare = u.match(/\b(B0[A-Z0-9]{8})\b/i);
  return bare ? bare[1].toUpperCase() : null;
}

// ── Minimal RFC-4180 CSV parser (handles quoted fields with commas/newlines) ─
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* ignore */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function parseSheet(text) {
  const rows = parseCsv(text).filter(r => r.some(c => c && c.trim()));
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => h.trim().toLowerCase());
  const iLink = headers.indexOf('amazon_link');
  const iCode = headers.indexOf('promo_code');
  const iPrice = headers.indexOf('discount_price');
  const iExp = headers.indexOf('expires');
  if (iLink < 0 || iCode < 0) return [];   // sheet not set up correctly
  const out = {};
  for (const r of rows.slice(1)) {
    const asin = extractAsin(r[iLink]);
    const code = (r[iCode] || '').trim();
    if (!asin || !code) continue;
    const discount = iPrice >= 0 ? parseFloat(String(r[iPrice]).replace(/[^0-9.]/g, '')) : 0;
    const expires = iExp >= 0 ? (r[iExp] || '').trim() : '';
    out[asin] = { asin, code: code.toUpperCase(), discount: discount > 0 ? discount : 0, expires };
  }
  return Object.values(out);   // dedup by ASIN — last row wins
}

// ── Amazon Creators API: official price/title/image for one ASIN ────────────
let _token = null, _tokenExp = 0;
async function getToken() {
  if (_token && Date.now() < _tokenExp - 60000) return _token;
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.AMAZON_CREATORS_CLIENT_ID,
      client_secret: process.env.AMAZON_CREATORS_CLIENT_SECRET,
      scope: 'creatorsapi::default',
    }).toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token fetch failed: ' + JSON.stringify(data));
  _token = data.access_token;
  _tokenExp = Date.now() + (data.expires_in || 3600) * 1000;
  return _token;
}

async function fetchProduct(asin, token) {
  const res = await fetch(ITEMS_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-marketplace': MARKETPLACE },
    body: JSON.stringify({
      itemIds: [asin], itemIdType: 'ASIN', resources: RESOURCES,
      partnerTag: AFFILIATE_TAG, partnerType: 'Associates', marketplace: MARKETPLACE,
    }),
  });
  const data = await res.json();
  const reason = data.reason || data.errors?.[0]?.reason || data.errors?.[0]?.message;
  const item = data.itemsResult?.items?.[0];
  if (!item) return { skip: reason || 'no-item', sample: JSON.stringify(data).slice(0, 300) };
  const primary = item.images?.primary?.large?.url || '';
  const listing = item.offersV2?.listings?.[0];
  // getItems nests price like searchItems: price.money.amount (fall back to .amount)
  const apiPrice = Number(listing?.price?.money?.amount ?? listing?.price?.amount) || 0;
  if (!apiPrice) return { skip: 'no-price', sample: JSON.stringify(listing || item.offersV2 || {}).slice(0, 300) };
  return {
    name:      item.itemInfo?.title?.displayValue || '',
    apiPrice,
    img:       primary,
    rating:    item.customerReviews?.starRating?.value || 0,
    reviews:   item.customerReviews?.count || 0,
    brandName: item.itemInfo?.byLineInfo?.brand?.displayValue || '',
  };
}

const todayStr = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const daysAgo  = n => new Date(Date.now() - n * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

exports.handler = async function (event) {
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const csvUrl = process.env.CODES_SHEET_CSV_URL;
  const manual = !!(event && (event.httpMethod === 'POST' || (event.queryStringParameters && event.queryStringParameters.key)));

  if (!sbUrl || !sbKey) return { statusCode: 500, body: 'Configuration error (Supabase)' };
  if (!csvUrl) return { statusCode: 200, body: JSON.stringify({ ok: true, added: 0, note: 'CODES_SHEET_CSV_URL not set yet' }) };

  // Manual trigger (admin button) requires the admin password.
  if (manual) {
    const key = (event.queryStringParameters && event.queryStringParameters.key) ||
                (() => { try { return JSON.parse(event.body || '{}').key; } catch { return ''; } })();
    if (!process.env.ADMIN_PASSWORD || key !== process.env.ADMIN_PASSWORD) {
      return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized' }) };
    }
  }

  const sbHeaders = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  // Auto-expire: prune sheet rows older than MAX_AGE_DAYS via the gateway, so the
  // sheet self-cleans and aged-out deals drop off the site on this same run.
  if (process.env.SHEET_API_URL && process.env.SHEET_API_TOKEN) {
    try {
      await fetch(process.env.SHEET_API_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'follow',
        body: JSON.stringify({ token: process.env.SHEET_API_TOKEN, action: 'cleanup', days: MAX_AGE_DAYS }),
      });
    } catch (e) { console.error('[sync-codes] sheet cleanup failed:', e.message); }
  }

  // 1. Read the sheet
  let sheet = [];
  try {
    const res = await fetch(csvUrl);
    if (!res.ok) throw new Error(`CSV fetch HTTP ${res.status}`);
    sheet = parseSheet(await res.text());
  } catch (e) {
    console.error('[sync-codes] sheet read failed:', e.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'sheet read failed: ' + e.message }) };
  }
  // Drop any ASINs blocked via the admin "Remove" button so they never re-enter
  // the grid even while they're still in the VA's sheet. (Table may not exist
  // yet -> treat as empty.)
  let blocked = new Set();
  try {
    const br = await fetch(`${sbUrl}/rest/v1/blocked_deals?select=asin`, { headers: sbHeaders });
    const bj = await br.json();
    if (Array.isArray(bj)) blocked = new Set(bj.map(x => String(x.asin || '').toUpperCase()));
  } catch (e) { /* table missing/unreachable -> no blocks */ }
  if (blocked.size) sheet = sheet.filter(s => !blocked.has(s.asin));

  // Don't re-add any ASIN that's currently a manual Top Pick — it lives in the
  // picks carousel (hidden from the grid), so re-adding would duplicate it.
  let topPicks = new Set();
  try {
    const tr = await fetch(`${sbUrl}/rest/v1/deals?is_top_pick=eq.true&select=url`, { headers: sbHeaders });
    const tj = await tr.json();
    if (Array.isArray(tj)) topPicks = new Set(tj.map(x => extractAsin(x.url)).filter(Boolean));
  } catch (e) { /* ignore */ }
  if (topPicks.size) sheet = sheet.filter(s => !topPicks.has(s.asin));

  const sheetByAsin = {};
  for (const s of sheet) sheetByAsin[s.asin] = s;
  const sheetAsins = new Set(Object.keys(sheetByAsin));

  // 2. Current coded deals already on the site
  let existing = [];
  try {
    const res = await fetch(`${sbUrl}/rest/v1/deals?store=eq.Amazon&is_top_pick=eq.false&code=not.is.null&select=id,url,code,price,active_date,uploaded_by`, { headers: sbHeaders });
    existing = await res.json();
    if (!Array.isArray(existing)) existing = [];
  } catch (e) { console.error('[sync-codes] load existing failed:', e.message); }
  // Seller-submitted deals are their own stream (not in the VA's sheet) and are managed
  // by review-deals + their own ends_at expiry — never let this sheet-sync prune them.
  existing = existing.filter(d => d.uploaded_by !== 'Seller Submission');

  // Map ASIN -> one row; if the same ASIN has multiple grid rows, drop the extras.
  const existingByAsin = {};
  const removeIds = [];
  for (const d of existing) {
    const a = extractAsin(d.url);
    if (!a) continue;
    if (existingByAsin[a]) { removeIds.push(d.id); }   // duplicate ASIN -> remove the extra row
    else existingByAsin[a] = d;
  }

  const cutoff = daysAgo(MAX_AGE_DAYS);
  const today  = todayStr();

  // 3. Decide removals: gone from sheet, OR older than 5 days, OR past explicit expires
  for (const d of existing) {
    if (removeIds.indexOf(d.id) !== -1) continue;     // already flagged as a duplicate
    const a = extractAsin(d.url);
    const s = a && sheetByAsin[a];
    const fresh = d.active_date === today;          // added today — the published CSV may still be caching, so don't yank it for "not in sheet" yet
    const tooOld = !d.active_date || d.active_date < cutoff;
    const expired = s && s.expires && s.expires < today;
    if ((!s && !fresh) || tooOld || expired) removeIds.push(d.id);
  }

  // 4. New rows to add (in sheet, not already a coded deal)
  const toAdd = sheet.filter(s => !existingByAsin[s.asin]);

  // 5. Apply removals
  let removed = 0;
  if (removeIds.length) {
    try {
      const idList = removeIds.map(encodeURIComponent).join(',');
      const del = await fetch(`${sbUrl}/rest/v1/deals?id=in.(${idList})`, { method: 'DELETE', headers: { ...sbHeaders, Prefer: 'return=minimal' } });
      if (del.ok) removed = removeIds.length;
    } catch (e) { console.error('[sync-codes] remove failed:', e.message); }
  }

  // 6. Add new ones — fetch the live API price for each, time-capped
  let token;
  try { token = await getToken(); }
  catch (e) { return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'amazon token: ' + e.message, removed }) }; }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const start = Date.now();
  let added = 0, skipped = 0, capped = false;
  const skipInfo = [];

  for (const s of toAdd) {
    if (Date.now() - start > TIME_CAP_MS) { capped = true; break; }
    let prod = null;
    try { prod = await fetchProduct(s.asin, token); } catch (e) { prod = { skip: 'fetch-error: ' + e.message }; }
    await sleep(API_SPACING);
    if (!prod || prod.skip || !prod.apiPrice) {
      skipped++;
      if (skipInfo.length < 3) skipInfo.push({ asin: s.asin, why: prod?.skip || 'unknown', sample: prod?.sample });
      continue;
    }
    // Safeguard: never post a deal-site placeholder title (belt-and-suspenders).
    if (/dealseek|joylink|koupon|coupert|slickdeals|dealnews|couponbirds|capital one shopping|we'?re building|for smarter shopping/i.test(prod.name || '')) { skipped++; continue; }

    const regular = prod.apiPrice;                       // compliant regular price (API)
    const price   = s.discount > 0 && s.discount < regular ? s.discount : regular;
    const off     = regular > price ? Math.round((1 - price / regular) * 100) : 0;

    // Coded deal beats any plain auto deal for the same ASIN
    try {
      await fetch(`${sbUrl}/rest/v1/deals?store=eq.Amazon&is_top_pick=eq.false&code=is.null&url=like.*${s.asin}*`, {
        method: 'DELETE', headers: { ...sbHeaders, Prefer: 'return=minimal' },
      });
    } catch {}

    const row = {
      rank:         900 + added,
      name:         prod.name.slice(0, 250),
      store:        'Amazon',
      category:     inferCategory(prod.name),
      price,
      was:          regular,
      off,
      rating:       prod.rating  || 0,
      reviews:      prod.reviews || 0,
      img:          prod.img,
      images:       null,
      url:          `https://www.amazon.com/dp/${s.asin}?tag=${AFFILIATE_TAG}`,
      code:         s.code,
      use_code_url: false,
      creator:      false,
      brand:        false,
      brand_name:   prod.brandName || null,
      active_date:  today,
      price_checked_at: new Date().toISOString(),   // API price just pulled — fresh per Amazon's 24h rule
      is_top_pick:  false,
    };
    try {
      const ins = await fetch(`${sbUrl}/rest/v1/deals`, { method: 'POST', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify(row) });
      if (ins.ok) added++; else { skipped++; console.error('[sync-codes] insert failed:', await ins.text()); }
    } catch (e) { skipped++; console.error('[sync-codes] insert error:', e.message); }
  }

  const result = { ok: true, sheetRows: sheet.length, added, removed, skipped, capped, remaining: capped ? toAdd.length - added - skipped : 0 };
  if (skipInfo.length) result.skipInfo = skipInfo;
  console.log('[sync-codes]', JSON.stringify(result));
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
};
