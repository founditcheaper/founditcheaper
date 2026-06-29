// Scheduled twice daily (see netlify.toml) — Amazon deal sync.
//
// Discovers discounted Amazon products via the Amazon Creators API `searchItems`
// operation (searches category terms, filtered by minimum discount), applies the
// same quality rules as Walmart, then REPLACES the auto-pulled Amazon deals in
// Supabase (store='Amazon', is_top_pick=false) so the grid stays current and
// dup-free. Manually curated Top Picks (is_top_pick=true) are always preserved.

const AFFILIATE_TAG = 'founditchea09-20';
const MIN_DISCOUNT  = 20;   // % off
const MAX_DISCOUNT  = 75;   // brand trust: above this is usually an inflated list price
const BRAND_MAX     = 90;   // hard sanity ceiling even for brands
const MIN_PRICE     = 5;    // skip sub-$5 junk
const MIN_RATING    = 3.5;
const MIN_REVIEWS   = 3;
const MAX_PRICE_CAP = 0;    // 0 = no price cap

const SEARCH_TERMS = [
  'cordless drill', 'power tools', 'tool set', 'impact driver', 'work boots',
  'air fryer', 'coffee maker', 'bluetooth headphones', 'bluetooth speaker',
  'smart tv', 'vacuum cleaner', 'gaming headset', 'kitchen appliances',
  'home improvement', 'garden tools', 'car accessories', 'camping gear',
  'fitness equipment', 'laptop', 'monitor', 'security camera', 'space heater',
  'generator', 'air compressor', 'cooler',
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
  if (/drill|saw|wrench|screwdriver|power tool|cordless|nailer|sander|grinder|router|socket|plier/.test(t)) return 'Tools';
  if (/headphone|earbud|speaker|\btv\b|smart tv|television|laptop|tablet|smartwatch|smart watch|camera|gaming|console|keyboard|mouse|charger|monitor|projector|alexa|\becho\b|ring\b/.test(t)) return 'Electronics';
  if (/air fryer|coffee|blender|instant pot|mixer|cookware|knife|cutting board|toaster|oven|bakeware|\bpot\b|\bpan\b|espresso|keurig|food processor|pressure cooker/.test(t)) return 'Kitchen';
  if (/vacuum|dehumidifier|humidifier|air purifier|mattress|pillow|bedding|\bfan\b|sofa|furniture|lamp|light bulb|candle|curtain|rug|carpet cleaner/.test(t)) return 'Home';
  if (/camp|hiking|tent|sleeping bag|backpack|cooler|fishing|kayak|paddle|trail|hammock/.test(t)) return 'Outdoors';
  if (/dumbbell|barbell|workout|yoga|exercise|fitness|bicycle|\bbike\b|treadmill|gym|weight set|resistance band/.test(t)) return 'Sports';
  if (/\bcar\b|truck|automotive|tire|dash cam|car seat|motor oil|windshield|vehicle/.test(t)) return 'Auto';
  if (/garden|plant|lawn|seed|soil|fertilizer|hose|sprinkler|greenhouse|pruner/.test(t)) return 'Garden';
  return 'Home';
}

// ── Amazon Creators API token (cached across warm invocations) ────────────
let _creatorsToken = null;
let _creatorsTokenExp = 0;

async function getCreatorsToken() {
  if (_creatorsToken && Date.now() < _creatorsTokenExp - 60000) return _creatorsToken;
  const clientId     = process.env.AMAZON_CREATORS_CLIENT_ID;
  const clientSecret = process.env.AMAZON_CREATORS_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Creators API not configured');
  const res  = await fetch('https://api.amazon.com/auth/o2/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type: 'client_credentials', client_id: clientId,
      client_secret: clientSecret, scope: 'creatorsapi::default',
    }).toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Creators token failed: ' + JSON.stringify(data));
  _creatorsToken    = data.access_token;
  _creatorsTokenExp = Date.now() + (data.expires_in || 3600) * 1000;
  return _creatorsToken;
}

// ── Search Amazon for discounted items (one keyword) ───────────────────────
let _loggedShape = false;
async function searchAmazon(keywords, token, retry = true) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch('https://creatorsapi.amazon/catalog/v1/searchItems', {
      method:  'POST',
      headers: {
        Authorization:   `Bearer ${token}`,
        'Content-Type':  'application/json',
        'x-marketplace': 'www.amazon.com',
      },
      body: JSON.stringify({
        keywords,
        searchIndex:      'All',
        itemCount:        10,
        minSavingPercent: MIN_DISCOUNT,
        resources: [
          'images.primary.large', 'itemInfo.title', 'itemInfo.byLineInfo',
          'offersV2.listings.price', 'offersV2.listings.dealDetails',
          'customerReviews.starRating', 'customerReviews.count',
        ],
        partnerTag:  AFFILIATE_TAG,
        partnerType: 'Associates',
        marketplace: 'www.amazon.com',
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.status === 429 && retry) {            // throttled — back off once and retry
      await new Promise(r => setTimeout(r, 2500));
      return searchAmazon(keywords, token, false);
    }
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch {}
    if (res.status !== 200) { console.error(`[sync-deals] search "${keywords}" -> HTTP ${res.status}: ${text.slice(0, 160)}`); return { items: [], status: res.status, err: text.slice(0, 120) }; }
    const items = (data && (data.searchResult?.items || data.itemsResult?.items || data.items)) || [];
    return { items, status: 200 };
  } catch (e) {
    clearTimeout(timer);
    return { items: [], status: 0, err: String(e).slice(0, 120) };
  }
}

// ── Deal discovery via the Creators API searchItems operation ──────────────
async function discoverDeals() {
  let token;
  try { token = await getCreatorsToken(); }
  catch (e) { console.error('[sync-deals] token failed:', e.message); return []; }

  // The Creators API throttles to ~1 request/sec, so search SEQUENTIALLY with a
  // small delay (parallel calls return HTTP 429). A time cap keeps us safely
  // inside the function limit; whatever we gathered is used.
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const start = Date.now();
  const found = {};
  const stats = { terms: 0, s200: 0, s429: 0, sOther: 0, sErr: 0, itemsSeen: 0, lastErr: '' };

  for (const term of SEARCH_TERMS) {
    if (Date.now() - start > 18000) { stats.timeCap = true; break; }
    const { items, status, err } = await searchAmazon(term, token);
    stats.terms++;
    if (status === 200) stats.s200++;
    else if (status === 429) stats.s429++;
    else if (status === 0) { stats.sErr++; if (err) stats.lastErr = err; }
    else { stats.sOther++; if (err) stats.lastErr = `${status}:${err}`; }
    stats.itemsSeen += items.length;
    for (const it of items) {
      const asin = it.asin || it.ASIN;
      if (!asin || found[asin]) continue;
      const listings = it.offersV2?.listings || [];
      const listing  = listings.find(l => l.isBuyBoxWinner) || listings[0];
      const price = Number(listing?.price?.money?.amount) || 0;
      const was   = Number(listing?.price?.savingBasis?.money?.amount) || 0;
      const pct   = listing?.price?.savings?.percentage;
      if (price < MIN_PRICE || was <= price) continue;     // require a real markdown
      const off = (typeof pct === 'number' && pct > 0) ? Math.round(pct) : Math.round((1 - price / was) * 100);
      if (off < MIN_DISCOUNT) continue;
      const name      = it.itemInfo?.title?.displayValue || '';
      const brandName = it.itemInfo?.byLineInfo?.brand?.displayValue || '';
      const brand     = isBrand(name, brandName);
      if (off > MAX_DISCOUNT && !brand) continue;      // trust: no fake-looking mega-discounts
      if (off > BRAND_MAX) continue;
      const rating  = it.customerReviews?.starRating?.value || 0;
      const reviews = it.customerReviews?.count || 0;
      if (rating > 0 && rating < MIN_RATING) continue;
      if (reviews < MIN_REVIEWS) continue;
      if (MAX_PRICE_CAP > 0 && price > MAX_PRICE_CAP) continue;
      found[asin] = {
        asin, name: name.slice(0, 250), price, was, off,
        img:       it.images?.primary?.large?.url || '',
        rating, reviews, brand,
        brandName: brand ? brandName : '',
        category:  inferCategory(name),
        url:       `https://www.amazon.com/dp/${asin}?tag=${AFFILIATE_TAG}`,
      };
    }
    await sleep(1500);   // conservative spacing — respect the Creators API rate limit
  }
  stats.found = Object.keys(found).length;
  console.log('[sync-deals] discovery stats:', JSON.stringify(stats));
  return { deals: Object.values(found), stats };
}

exports.handler = async function () {
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) {
    console.error('[sync-deals] Missing required environment variables');
    return { statusCode: 500, body: 'Configuration error' };
  }
  const sbHeaders = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  // 1. Discover + variant-dedup
  const disc = await discoverDeals();
  let deals = disc.deals;
  const bestByKey = {};
  for (const d of deals) {
    const k = baseNameKey(d.name);
    if (!bestByKey[k] || d.off > bestByKey[k].off) bestByKey[k] = d;
  }
  deals = Object.values(bestByKey);
  console.log(`[sync-deals] ${deals.length} qualifying Amazon deals (after variant dedup)`);

  // Safety: if discovery returned nothing (API hiccup), leave the existing grid alone.
  if (deals.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, added: 0, stats: disc.stats }) };
  }

  // 2. Replace the auto-pulled Amazon set (preserve manual Top Picks)
  try {
    const del = await fetch(`${sbUrl}/rest/v1/deals?store=eq.Amazon&is_top_pick=eq.false`, {
      method: 'DELETE', headers: { ...sbHeaders, Prefer: 'return=minimal' },
    });
    console.log(`[sync-deals] cleared previous Amazon deals -> HTTP ${del.status}`);
  } catch (e) { console.error('[sync-deals] clear failed:', e.message); }

  // 3. Insert fresh
  const today = new Date().toISOString().split('T')[0];
  const rows  = deals.map((d, i) => ({
    rank:         i + 1,
    name:         d.name,
    store:        'Amazon',
    category:     d.category,
    price:        d.price,
    was:          d.was,
    off:          d.off,
    rating:       d.rating  || 0,
    reviews:      d.reviews || 0,
    img:          d.img,
    images:       null,
    url:          d.url,
    code:         null,
    use_code_url: false,
    creator:      d.brand,
    brand:        d.brand,
    brand_name:   d.brandName || null,
    active_date:  today,
    is_top_pick:  false,
  }));

  const CHUNK  = 100;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const ins   = await fetch(`${sbUrl}/rest/v1/deals`, {
      method: 'POST', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify(chunk),
    });
    if (!ins.ok) console.error(`[sync-deals] insert chunk ${i} failed:`, await ins.text());
    else inserted += chunk.length;
  }

  console.log(`[sync-deals] ✓ Inserted ${inserted} Amazon deals`);
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, added: inserted, stats: disc.stats }),
  };
};
