// Scheduled daily at 6 AM UTC (configured in netlify.toml).
//
// Pulls Amazon deals, dedupes by ASIN against Supabase, enriches each with
// images + ratings via the Amazon Creators API, then inserts the new rows.
// Historical rows are never deleted — the grid accumulates over time.
//
// ⚠️  DEAL DISCOVERY IS NOT WIRED UP YET.
// Rainforest (the previous deal source) was removed for Amazon Associates
// compliance. The Amazon-native deal-finder still needs to be built — see
// discoverDeals() below. Until then this function pulls nothing and inserts 0.

const AFFILIATE_TAG = 'founditchea09-20';
const MIN_DISCOUNT  = 10;   // % off — minimum discount a deal must have to qualify
const MAX_PRICE     = 0;    // 0 = no price cap

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

// ── Deal discovery ────────────────────────────────────────────────────────
// TODO: implement Amazon-native deal discovery here, via the Amazon Creators /
// PA-API SearchItems endpoint with a minimum-discount filter (MIN_DISCOUNT)
// across the target categories. Should return an array of:
//   { asin, name, category, price, was, off, img, url }
// `seenAsins` holds ASINs already in the DB — skip those. Honor MAX_PRICE.
// Returns [] until the Amazon search piece is built.
async function discoverDeals(seenAsins) {
  console.log(
    '[sync-deals] No Amazon deal-discovery source is configured yet ' +
    '(Rainforest was removed for compliance). Nothing to pull — build ' +
    'discoverDeals() on the Amazon API.'
  );
  return [];
}

// ── Enrich a single ASIN with images + rating via the Amazon Creators API ──
let _creatorsEligible = true;

async function fetchProductData(asin) {
  if (!_creatorsEligible) return { images: [], rating: 0, reviews: 0 };
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
        resources:   ['images.primary.large', 'images.variants.large', 'customerReviews.starRating', 'customerReviews.count'],
        partnerTag:  AFFILIATE_TAG,
        partnerType: 'Associates',
        marketplace: 'www.amazon.com',
      }),
    });
    const data = await res.json();

    // AssociateNotEligible can arrive at the top level OR inside errors[].
    const reason = data.reason || data.errors?.[0]?.reason;
    if (reason === 'AssociateNotEligible') {
      _creatorsEligible = false;
      console.log('[sync-deals] Amazon Creators API not eligible yet — storing deals without enrichment');
      return { images: [], rating: 0, reviews: 0 };
    }

    const item = data.itemsResult?.items?.[0];
    if (!item) return { images: [], rating: 0, reviews: 0 };
    const primary  = item.images?.primary?.large?.url;
    const variants = (item.images?.variants || []).map(v => v.large?.url).filter(Boolean);
    return {
      images:  primary ? [primary, ...variants] : variants,
      rating:  item.customerReviews?.starRating?.value || 0,
      reviews: item.customerReviews?.count || 0,
    };
  } catch {
    return { images: [], rating: 0, reviews: 0 };
  }
}

exports.handler = async function (event) {
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!sbUrl || !sbKey) {
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

  // ── 2. Discover new Amazon deals (not yet implemented — see discoverDeals) ─
  let newDeals = await discoverDeals(seenAsins);

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

  // ── 3. Enrich each deal with images + rating via the Amazon Creators API ──
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
