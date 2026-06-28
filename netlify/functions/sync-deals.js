// Scheduled daily at 6 AM UTC (configured in netlify.toml).
// Uses Rainforest API type=deals to pull Amazon's live deal pages.
// Only inserts products not already in Supabase (deduplicates by ASIN).
// Historical rows are never deleted — the grid accumulates over time.

const AFFILIATE_TAG  = 'founditcheaper-20';
const MIN_DISCOUNT   = 10;   // % off
const MAX_PRICE      = 0;    // 0 = no price cap
const PAGES_TO_FETCH = 5;    // 5 API credits per run; 500 total deals, ~30/page

function baseNameKey(name) {
  // Strip trailing color/variant qualifiers then keep first 7 words as dedup key
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

// In-process Creators API token cache
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
      grant_type:    'client_credentials',
      client_id:     clientId,
      client_secret: clientSecret,
      scope:         'creatorsapi::default',
    }).toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Creators token failed: ' + JSON.stringify(data));
  _creatorsToken    = data.access_token;
  _creatorsTokenExp = Date.now() + (data.expires_in || 3600) * 1000;
  return _creatorsToken;
}

exports.handler = async function (event) {
  const apiKey = process.env.RAINFOREST_API_KEY;
  const sbUrl  = process.env.SUPABASE_URL;
  const sbKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!apiKey || !sbUrl || !sbKey) {
    console.error('[sync-deals] Missing required environment variables');
    return { statusCode: 500, body: 'Configuration error' };
  }

  const sbHeaders = {
    apikey:         sbKey,
    Authorization:  `Bearer ${sbKey}`,
    'Content-Type': 'application/json',
  };

  // ── 1. Load existing ASINs from Supabase to skip duplicates ──────────────
  const seenAsins = new Set();
  try {
    const res  = await fetch(`${sbUrl}/rest/v1/deals?select=url&limit=20000`, {
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
    });
    const rows = await res.json();
    for (const row of (rows || [])) {
      const m = (row.url || '').match(/\/dp\/([A-Z0-9]{10})/i);
      if (m) seenAsins.add(m[1]);
    }
    console.log(`[sync-deals] ${seenAsins.size} existing products in DB`);
  } catch (e) {
    console.error('[sync-deals] Could not load existing ASINs:', e.message);
    // Non-fatal — worst case a few duplicates get in
  }

  // ── 2. Fetch pages of Amazon deals in parallel ───────────────────────────
  async function fetchPage(page) {
    const url =
      `https://api.rainforestapi.com/request?api_key=${apiKey}` +
      `&type=deals&amazon_domain=amazon.com&page=${page}`;

    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);

    try {
      const res  = await fetch(url, { signal: ctrl.signal });
      const data = await res.json();
      clearTimeout(timer);

      if (data.request_info?.success === false) {
        console.error(`[sync-deals] API error page ${page}:`, data.request_info.message);
        return [];
      }

      const hits = [];
      for (const d of (data.deals_results || [])) {
        const asin = d.asin;
        if (!asin || seenAsins.has(asin)) continue;

        const price = d.deal_price?.value ?? d.current_price?.value ?? 0;
        const was   = d.list_price?.value ?? d.regular_price?.value ?? 0;
        const off   = typeof d.percent_off === 'number' ? d.percent_off : 0;

        if (price <= 0) continue;
        if (MAX_PRICE > 0 && price > MAX_PRICE) continue;
        if (off < MIN_DISCOUNT) continue;

        seenAsins.add(asin);
        hits.push({
          asin,
          name:     (d.title || '').slice(0, 250),
          category: inferCategory(d.title),
          price,
          was:      was > price ? was : price,
          off,
          img:      d.image ?? '',
          url:      `https://www.amazon.com/dp/${asin}?tag=${AFFILIATE_TAG}`,
        });
      }

      console.log(`[sync-deals] Page ${page}: ${hits.length} qualifying deals`);
      return hits;
    } catch (e) {
      clearTimeout(timer);
      console.error(`[sync-deals] Page ${page} failed:`, e.message);
      return [];
    }
  }

  const pages   = Array.from({ length: PAGES_TO_FETCH }, (_, i) => i + 1);
  const batches = await Promise.all(pages.map(fetchPage));
  let   newDeals = batches.flat();

  // Dedup variants: same base product name → keep highest-discount entry only
  const _bestByKey = {};
  newDeals.forEach(d => {
    const key = baseNameKey(d.name);
    if (!_bestByKey[key] || d.off > _bestByKey[key].off) _bestByKey[key] = d;
  });
  newDeals = Object.values(_bestByKey);

  console.log(`[sync-deals] ${newDeals.length} new deals to insert (after variant dedup)`);

  if (newDeals.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, added: 0 }) };
  }

  // ── 3. Enrich each deal with images + rating via Creators API / Rainforest ──
  // Returns { images, rating, reviews } for each ASIN.
  // Tries Creators first (free, images only); falls back to Rainforest type=product
  // which returns both images AND rating data in one call.
  let creatorsEligible = true;

  async function fetchProductData(asin) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 7000);

    if (creatorsEligible) {
      try {
        const token = await getCreatorsToken();
        const res   = await fetch('https://creatorsapi.amazon/catalog/v1/getItems', {
          method:  'POST',
          headers: {
            Authorization:   `Bearer ${token}`,
            'Content-Type':  'application/json',
            'x-marketplace': 'www.amazon.com',
          },
          body: JSON.stringify({
            itemIds:     [asin],
            itemIdType:  'ASIN',
            resources:   ['images.primary.large', 'images.variants.large'],
            partnerTag:  AFFILIATE_TAG,
            partnerType: 'Associates',
            marketplace: 'www.amazon.com',
          }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const data       = await res.json();
        const firstError = data.errors?.[0];
        if (firstError?.reason === 'AssociateNotEligible') {
          creatorsEligible = false;
          console.log('[sync-deals] Creators API not yet eligible — switching to Rainforest');
        } else {
          const item    = data.itemsResult?.items?.[0];
          if (item) {
            const primary  = item.images?.primary?.large?.url;
            const variants = (item.images?.variants || []).map(v => v.large?.url).filter(Boolean);
            return { images: primary ? [primary, ...variants] : variants, rating: 0, reviews: 0 };
          }
          return { images: [], rating: 0, reviews: 0 };
        }
      } catch {
        clearTimeout(timer);
      }
    }

    // Fallback: Rainforest type=product — returns images AND rating in one call
    if (!apiKey) return { images: [], rating: 0, reviews: 0 };
    try {
      const url  = `https://api.rainforestapi.com/request?api_key=${apiKey}&type=product&asin=${asin}&amazon_domain=amazon.com`;
      const res  = await fetch(url);
      const data = await res.json();
      const p    = data.product || {};
      return {
        images:  (p.images || []).map(img => img.link).filter(Boolean),
        rating:  p.rating        ?? 0,
        reviews: p.ratings_total ?? 0,
      };
    } catch {
      return { images: [], rating: 0, reviews: 0 };
    }
  }

  const IMG_BATCH   = 20;
  const enrichStart = Date.now();
  for (let b = 0; b < newDeals.length; b += IMG_BATCH) {
    if (Date.now() - enrichStart > 10000) {
      console.log('[sync-deals] Enrichment time cap reached — remaining deals stored without images/ratings');
      break;
    }
    const slice   = newDeals.slice(b, b + IMG_BATCH);
    const results = await Promise.all(slice.map(d => fetchProductData(d.asin)));
    slice.forEach((d, i) => {
      d.images  = results[i].images;
      d.rating  = results[i].rating;
      d.reviews = results[i].reviews;
    });
  }
  console.log(`[sync-deals] Enrichment done in ${Date.now() - enrichStart}ms`);

  // ── 4. Insert new deals into Supabase in chunks ───────────────────────────
  const today = new Date().toISOString().split('T')[0];
  const rows  = newDeals.map((d, i) => ({
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
    images:       d.images?.length ? JSON.stringify(d.images) : null,
    url:          d.url,
    code:         null,
    use_code_url: false,
    creator:      false,
    brand:        false,
    brand_name:   null,
    active_date:  today,
    is_top_pick:  false,
  }));

  const CHUNK  = 100;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const ins   = await fetch(`${sbUrl}/rest/v1/deals`, {
      method:  'POST',
      headers: { ...sbHeaders, Prefer: 'return=minimal' },
      body:    JSON.stringify(chunk),
    });
    if (!ins.ok) {
      const detail = await ins.text();
      console.error(`[sync-deals] Insert chunk ${i} failed:`, detail);
    } else {
      inserted += chunk.length;
    }
  }

  console.log(`[sync-deals] ✓ Inserted ${inserted} deals`);
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, added: inserted }),
  };
};
