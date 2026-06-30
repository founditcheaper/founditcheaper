// Amazon deal discovery — BACKGROUND function (runs up to 15 min, vs 26s for a
// normal function). Triggered by the scheduled `sync-deals` kickoff. Sweeps a
// large keyword list via the Creators API searchItems (sequential, ~1.5s apart
// to respect the ~1 req/sec rate limit), keeps deals 10–80% off, dedupes, and
// replaces the auto-pulled Amazon grid (preserving Top Picks + coded deals).

const AFFILIATE_TAG = 'founditchea09-20';
const MIN_DISCOUNT  = 10;       // % off — wide net per Erik
const MAX_DISCOUNT  = 80;       // cap fake/inflated-MSRP deals
const MIN_PRICE     = 5;        // skip sub-$5 junk
const MIN_RATING    = 3.0;      // only cut clearly-bad rated items; 0/unknown is KEPT
const TIME_CAP_MS   = 780000;   // 13 min — stay safely under the 15-min background limit
const MAX_PAGES     = 3;        // pages per keyword (deeper results); stops early if dry

// Broad category sweep — the more terms, the more deals (the API has no
// "browse all deals" endpoint, so coverage = how many keywords we search).
const SEARCH_TERMS = [
  'cordless drill','power tools','tool set','impact driver','wrench set','socket set','tool box','work light','shop vac','air compressor','generator','pressure washer','ladder','tool bag','multimeter','nail gun','angle grinder','work boots','tape measure','utility knife',
  'bluetooth headphones','bluetooth speaker','wireless earbuds','gaming headset','smart tv','monitor','laptop','tablet','smartwatch','security camera','dash cam','power bank','phone charger','usb c cable','keyboard','mouse','webcam','wifi router','ssd','microsd card','projector','soundbar','streaming device','smart watch',
  'air fryer','coffee maker','blender','espresso machine','cookware set','knife set','instant pot','toaster oven','food processor','stand mixer','water bottle','cast iron skillet','kitchen utensils','rice cooker',
  'vacuum cleaner','robot vacuum','air purifier','space heater','humidifier','dehumidifier','tower fan','led strip lights','mattress','pillow','bedding set','smart plug','video doorbell','storage bins','area rug','sheets',
  'camping gear','tent','sleeping bag','cooler','fishing rod','backpack','hiking boots','dumbbells','yoga mat','resistance bands','exercise bike','grill','flashlight','massage gun',
  'car accessories','car vacuum','jump starter','tire inflator','floor mats','motor oil','phone mount','car cover',
  'garden tools','lawn mower','string trimmer','leaf blower','garden hose','planter',
  'office chair','standing desk','electric toothbrush','hair dryer','beard trimmer','sunglasses','watch','backpack cooler',
];

const BRANDS = [
  'dewalt','milwaukee','makita','ryobi','craftsman','black+decker','black & decker','bosch',
  'stanley','ridgid','kobalt','skil','porter-cable','metabo','hart','greenworks','ego',
  'ninja','kitchenaid','cuisinart','keurig','instant pot','crock-pot','hamilton beach','oster',
  'vitamix','nespresso','breville','pyrex','rubbermaid',
  'sony','samsung','lg','bose','jbl','apple','beats','anker','logitech','razer','hp','dell','asus','acer','lenovo','tcl','hisense','roku','amazon','google','garmin','gopro',
  'dyson','shark','bissell','hoover','irobot','roomba',
  'yeti','coleman','igloo','carhartt','dickies','nike','adidas','under armour','columbia','the north face',
];

function isBrand(name, brandName) {
  const hay = `${(brandName || '')} ${(name || '')}`.toLowerCase();
  return BRANDS.some(b => hay.includes(b));
}

function baseNameKey(name) {
  return (name || '').toLowerCase()
    .replace(/[\s,\-|]+(?:black|white|blue|red|green|grey|gray|silver|gold|pink|purple|midnight|charcoal|cream|navy|teal|rose|ivory|titanium|sage|natural|espresso|walnut|oak|brown|beige|tan|coral|yellow|orange|lavender|violet|maroon|olive|mint|turquoise|multicolor|multi.color|\d+[\s-]?pack|\d+\s*oz|\d+\s*lbs?|\d+\s*ft|\d+\s*in(?:ch)?|\d+\s*count)\b.*$/i, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').slice(0, 7).join(' ');
}

function inferCategory(title) {
  const t = (title || '').toLowerCase();
  if (/drill|saw|wrench|screwdriver|power tool|cordless|nailer|sander|grinder|router|socket|plier|ladder|compressor/.test(t)) return 'Tools';
  if (/headphone|earbud|speaker|\btv\b|smart tv|television|laptop|tablet|smartwatch|smart watch|camera|gaming|console|keyboard|mouse|charger|monitor|projector|alexa|\becho\b|ring\b|router|ssd/.test(t)) return 'Electronics';
  if (/air fryer|coffee|blender|instant pot|mixer|cookware|knife|cutting board|toaster|oven|bakeware|\bpot\b|\bpan\b|espresso|keurig|food processor|pressure cooker|skillet/.test(t)) return 'Kitchen';
  if (/vacuum|dehumidifier|humidifier|air purifier|mattress|pillow|bedding|\bfan\b|sofa|furniture|lamp|light|candle|curtain|rug|carpet|sheet|storage/.test(t)) return 'Home';
  if (/camp|hiking|tent|sleeping bag|backpack|cooler|fishing|kayak|paddle|trail|hammock/.test(t)) return 'Outdoors';
  if (/dumbbell|barbell|workout|yoga|exercise|fitness|bicycle|\bbike\b|treadmill|gym|weight set|resistance band|massage gun/.test(t)) return 'Sports';
  if (/\bcar\b|truck|automotive|tire|dash cam|car seat|motor oil|windshield|vehicle|jump starter/.test(t)) return 'Auto';
  if (/garden|plant|lawn|seed|soil|fertilizer|hose|sprinkler|greenhouse|pruner|mower|trimmer|blower/.test(t)) return 'Garden';
  return 'Home';
}

let _creatorsToken = null, _creatorsTokenExp = 0;
async function getCreatorsToken() {
  if (_creatorsToken && Date.now() < _creatorsTokenExp - 60000) return _creatorsToken;
  const clientId = process.env.AMAZON_CREATORS_CLIENT_ID, clientSecret = process.env.AMAZON_CREATORS_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Creators API not configured');
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'creatorsapi::default' }).toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Creators token failed: ' + JSON.stringify(data));
  _creatorsToken = data.access_token; _creatorsTokenExp = Date.now() + (data.expires_in || 3600) * 1000;
  return _creatorsToken;
}

async function searchAmazon(keywords, token, page = 1, retry = true) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch('https://creatorsapi.amazon/catalog/v1/searchItems', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-marketplace': 'www.amazon.com' },
      body: JSON.stringify({
        keywords, searchIndex: 'All', itemCount: 10, itemPage: page, minSavingPercent: MIN_DISCOUNT,
        resources: ['images.primary.large', 'itemInfo.title', 'itemInfo.byLineInfo', 'offersV2.listings.price', 'offersV2.listings.dealDetails', 'customerReviews.starRating', 'customerReviews.count'],
        partnerTag: AFFILIATE_TAG, partnerType: 'Associates', marketplace: 'www.amazon.com',
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.status === 429 && retry) { await new Promise(r => setTimeout(r, 2500)); return searchAmazon(keywords, token, page, false); }
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch {}
    if (res.status !== 200) { console.error(`[sync-deals-bg] "${keywords}" p${page} -> HTTP ${res.status}: ${text.slice(0, 120)}`); return { items: [], status: res.status }; }
    return { items: (data && (data.searchResult?.items || data.itemsResult?.items || data.items)) || [], status: 200 };
  } catch (e) { clearTimeout(timer); return { items: [], status: 0 }; }
}

async function discoverDeals() {
  let token;
  try { token = await getCreatorsToken(); }
  catch (e) { console.error('[sync-deals-bg] token failed:', e.message); return { deals: [], stats: {} }; }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const start = Date.now();
  const found = {};
  const stats = { terms: 0, s200: 0, s429: 0, sErr: 0, itemsSeen: 0 };

  for (const term of SEARCH_TERMS) {
    if (Date.now() - start > TIME_CAP_MS) { stats.timeCap = true; break; }
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { items, status } = await searchAmazon(term, token, page);
      stats.terms++;
      if (status === 200) stats.s200++; else if (status === 429) stats.s429++; else stats.sErr++;
      stats.itemsSeen += items.length;
      let newOnPage = 0;
      for (const it of items) {
        const asin = it.asin || it.ASIN;
        if (!asin || found[asin]) continue;
        const listings = it.offersV2?.listings || [];
        const listing = listings.find(l => l.isBuyBoxWinner) || listings[0];
        const price = Number(listing?.price?.money?.amount) || 0;
        const was = Number(listing?.price?.savingBasis?.money?.amount) || 0;
        const pct = listing?.price?.savings?.percentage;
        if (price < MIN_PRICE || was <= price) continue;
        const off = (typeof pct === 'number' && pct > 0) ? Math.round(pct) : Math.round((1 - price / was) * 100);
        if (off < MIN_DISCOUNT || off > MAX_DISCOUNT) continue;
        const name = it.itemInfo?.title?.displayValue || '';
        const brandName = it.itemInfo?.byLineInfo?.brand?.displayValue || '';
        const brand = isBrand(name, brandName);
        const rating = it.customerReviews?.starRating?.value || 0;
        if (rating > 0 && rating < MIN_RATING) continue;
        newOnPage++;
        found[asin] = {
          asin, name: name.slice(0, 250), price, was, off,
          img: it.images?.primary?.large?.url || '',
          rating, reviews: it.customerReviews?.count || 0, brand,
          brandName: brand ? brandName : '',
          category: inferCategory(name),
          url: `https://www.amazon.com/dp/${asin}?tag=${AFFILIATE_TAG}`,
        };
      }
      await sleep(1500);
      if (items.length < 10) break;            // last page for this term
      if (page > 1 && newOnPage === 0) break;  // pagination not yielding anything new
      if (Date.now() - start > TIME_CAP_MS) { stats.timeCap = true; break; }
    }
  }
  stats.found = Object.keys(found).length;
  console.log('[sync-deals-bg] discovery stats:', JSON.stringify(stats));
  return { deals: Object.values(found), stats };
}

exports.handler = async function () {
  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) { console.error('[sync-deals-bg] missing env'); return { statusCode: 500, body: 'Configuration error' }; }
  const sbHeaders = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  const disc = await discoverDeals();
  let deals = disc.deals;
  const bestByKey = {};
  for (const d of deals) { const k = baseNameKey(d.name); if (!bestByKey[k] || d.off > bestByKey[k].off) bestByKey[k] = d; }
  deals = Object.values(bestByKey);

  // Don't duplicate coded deals, blocked ASINs, or current Top Picks.
  const skipAsins = new Set();
  async function collectSkips(url, mapFn) {
    try { const r = await fetch(url, { headers: sbHeaders }); const j = await r.json(); if (Array.isArray(j)) j.forEach(x => { const a = mapFn(x); if (a) skipAsins.add(a); }); } catch (e) {}
  }
  await collectSkips(`${sbUrl}/rest/v1/deals?store=eq.Amazon&code=not.is.null&select=url`, d => (d.url.match(/\/dp\/([A-Z0-9]{10})/i) || [])[1]);
  await collectSkips(`${sbUrl}/rest/v1/blocked_deals?select=asin`, x => String(x.asin || '').toUpperCase());
  await collectSkips(`${sbUrl}/rest/v1/deals?is_top_pick=eq.true&select=url`, d => (d.url.match(/\/dp\/([A-Z0-9]{10})/i) || [])[1]);
  if (skipAsins.size) deals = deals.filter(d => !skipAsins.has(d.asin));

  console.log(`[sync-deals-bg] ${deals.length} qualifying Amazon deals`);
  if (deals.length === 0) return { statusCode: 200, body: JSON.stringify({ ok: true, added: 0, stats: disc.stats }) };

  try {
    await fetch(`${sbUrl}/rest/v1/deals?store=eq.Amazon&is_top_pick=eq.false&code=is.null`, { method: 'DELETE', headers: { ...sbHeaders, Prefer: 'return=minimal' } });
  } catch (e) { console.error('[sync-deals-bg] clear failed:', e.message); }

  const today = new Date().toISOString().split('T')[0];
  const rows = deals.map((d, i) => ({
    rank: i + 1, name: d.name, store: 'Amazon', category: d.category,
    price: d.price, was: d.was, off: d.off, rating: d.rating || 0, reviews: d.reviews || 0,
    img: d.img, images: null, url: d.url, code: null, use_code_url: false,
    creator: d.brand, brand: d.brand, brand_name: d.brandName || null, active_date: today, is_top_pick: false,
  }));

  const CHUNK = 100; let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const ins = await fetch(`${sbUrl}/rest/v1/deals`, { method: 'POST', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify(chunk) });
    if (ins.ok) inserted += chunk.length; else console.error(`[sync-deals-bg] insert chunk ${i} failed:`, await ins.text());
  }
  console.log(`[sync-deals-bg] ✓ Inserted ${inserted} Amazon deals`);
  return { statusCode: 200, body: JSON.stringify({ ok: true, added: inserted, stats: disc.stats }) };
};
