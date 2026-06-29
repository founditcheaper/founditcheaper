// Scheduled Walmart deal sync (daily, see netlify.toml).
//
// Pulls discounted Walmart products via the Walmart Affiliate Marketing API
// (signed requests; searches a set of category terms), keeps items with a real
// markdown >= MIN_DISCOUNT, dedupes by Walmart itemId, and inserts them into the
// Supabase `deals` table with store='Walmart'. The affiliate link is the
// API-provided productTrackingUrl (publisher id baked in — already monetized).
const crypto = require('crypto');

const BASE         = 'https://developer.api.walmart.com/api-proxy/service/affil/product/v2';
const MIN_DISCOUNT = 20;   // % off
const MAX_DISCOUNT = 75;   // brand trust: above this is usually a fake/inflated MSRP
const MIN_PRICE    = 5;    // skip sub-$5 junk
const MIN_RATING   = 3.0;  // only cut clearly-bad rated items; 0/unknown is KEPT
const MIN_REVIEWS  = 0;    // KEEP no-name / low-review products (promo-code sources)
const BRAND_MAX    = 90;   // hard sanity ceiling even for brands (above = likely a price error)

// Recognized brands: a >MAX_DISCOUNT deal is trustworthy if it's a real brand
// (real brands rarely fake-inflate MSRP). Per Erik: brand + big discount = great deal.
const BRANDS = [
  'dewalt','milwaukee','makita','ryobi','craftsman','black+decker','black & decker','bosch',
  'stanley','ridgid','kobalt','skil','porter-cable','metabo','hart','greenworks','ego',
  'ninja','kitchenaid','cuisinart','keurig','instant pot','crock-pot','hamilton beach','oster',
  'vitamix','nespresso','breville','pyrex','rubbermaid','tupperware',
  'sony','samsung','lg','bose','jbl','apple','beats','anker','logitech','razer','hp','dell','asus','acer','lenovo','tcl','hisense','roku','amazon','google','garmin','gopro',
  'dyson','shark','bissell','hoover','irobot','roomba',
  'yeti','coleman','igloo','stanley','carhartt','dickies','nike','adidas','under armour','columbia','the north face',
  'graco','fisher-price','lego','nerf','hot wheels','barbie',
  'gillette','olay','cerave','colgate','crest',
];

function isBrand(name, brandName) {
  const hay = `${(brandName || '')} ${(name || '')}`.toLowerCase();
  return BRANDS.some(b => hay.includes(b));
}

// Strip trailing color/size/variant words → dedup key (avoids the same item twice)
function baseNameKey(name) {
  return (name || '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').slice(0, 8).join(' ');
}

// Blue-collar / male-skewed category terms (mirrors the old auto-picker intent)
const SEARCH_TERMS = [
  'cordless drill', 'power tools', 'tool set', 'impact driver', 'work boots',
  'air fryer', 'coffee maker', 'bluetooth headphones', 'bluetooth speaker',
  'smart tv', 'vacuum cleaner', 'gaming headset', 'kitchen appliances',
  'home improvement', 'garden tools', 'car accessories', 'camping gear',
  'fitness equipment', 'laptop', 'monitor', 'security camera', 'space heater',
  'generator', 'air compressor', 'cooler',
];

function getPrivateKeyPem() {
  return Buffer.from(process.env.WALMART_PRIVATE_KEY || '', 'base64').toString('utf8');
}

function sign(consumerId, keyVersion, timestamp, pem) {
  const s = crypto.createSign('RSA-SHA256');
  s.update(`${consumerId}\n${timestamp}\n${keyVersion}\n`);
  s.end();
  return s.sign(pem, 'base64');
}

async function wmSearch(term, pub) {
  const consumerId = process.env.WALMART_CONSUMER_ID;
  const keyVersion = process.env.WALMART_KEY_VERSION || '1';
  const pem        = getPrivateKeyPem();
  const ts         = Date.now().toString();
  const sig        = sign(consumerId, keyVersion, ts, pem);
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${BASE}/search?publisherId=${pub}&query=${encodeURIComponent(term)}&numItems=25`, {
      headers: {
        'WM_CONSUMER.ID':          consumerId,
        'WM_CONSUMER.INTIMESTAMP': ts,
        'WM_SEC.KEY_VERSION':      keyVersion,
        'WM_SEC.AUTH_SIGNATURE':   sig,
        'Accept':                  'application/json',
      },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) { console.error(`[sync-walmart] search "${term}" -> HTTP ${res.status}`); return []; }
    const data = await res.json();
    return data.items || [];
  } catch (e) {
    clearTimeout(timer);
    console.error(`[sync-walmart] search "${term}" failed: ${e.message}`);
    return [];
  }
}

function inferCategory(path) {
  const t = (path || '').toLowerCase();
  if (/tool|hardware|power drill|impact/.test(t)) return 'Tools';
  if (/electronic|tv|headphone|speaker|laptop|monitor|camera|gaming|computer|phone/.test(t)) return 'Electronics';
  if (/kitchen|appliance|coffee|air fryer|cookware|blender/.test(t)) return 'Kitchen';
  if (/patio|garden|lawn|outdoor/.test(t)) return 'Garden';
  if (/camp|hik|fish|hunt/.test(t)) return 'Outdoors';
  if (/sport|fitness|exercise|bike/.test(t)) return 'Sports';
  if (/auto|car|vehicle|tire/.test(t)) return 'Auto';
  return 'Home';
}

exports.handler = async function () {
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const pub   = process.env.WALMART_PUBLISHER_ID || '4077610';

  if (!process.env.WALMART_CONSUMER_ID || !process.env.WALMART_PRIVATE_KEY || !sbUrl || !sbKey) {
    console.error('[sync-walmart] Missing required environment variables');
    return { statusCode: 500, body: 'Configuration error' };
  }
  const sbHeaders = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  // 1. Search across terms IN PARALLEL (stays within the function time limit).
  //    REPLACE-style sync: pull the current best deals, then swap out the old
  //    auto-pulled Walmart set below — so deals stay fresh and never accumulate
  //    duplicates or stale prices.
  const termResults = await Promise.all(SEARCH_TERMS.map(t => wmSearch(t, pub)));

  // One-time: reveal the real field names on the first live item
  const probe = termResults.flat().find(Boolean);
  if (probe) {
    console.log('[sync-walmart] sample item keys:', Object.keys(probe).join(','));
    console.log('[sync-walmart] sample item:', JSON.stringify(probe).slice(0, 600));
  }

  const found = {};
  for (const items of termResults) {
    for (const it of items) {
      const id = String(it.itemId || '');
      if (!id || found[id]) continue;
      const price = Number(it.salePrice) || 0;
      const was   = Number(it.msrp) || 0;
      if (price < MIN_PRICE || was <= price) continue;     // real markdown + skip sub-$5 junk
      const off = Math.round((1 - price / was) * 100);
      if (off < MIN_DISCOUNT) continue;
      // Trust rule: cap discounts at MAX_DISCOUNT — UNLESS it's a recognized brand
      // (real brands rarely fake-inflate MSRP, so a big brand discount is a real deal).
      const brand = isBrand(it.name, it.brandName);
      if (off > MAX_DISCOUNT && !brand) continue;
      if (off > BRAND_MAX) continue;                       // sanity backstop even for brands
      const rating  = parseFloat(it.customerRating) || 0;
      const reviews = Number(it.numReviews) || 0;
      if (rating > 0 && rating < MIN_RATING) continue;
      if (reviews < MIN_REVIEWS) continue;
      const url = it.productTrackingUrl || (it.affiliateAddToCartUrl) || '';
      if (!url) continue;                                  // no affiliate link = no commission, skip
      found[id] = {
        name:     (it.name || '').slice(0, 250),
        price, was, off,
        img:      it.largeImage || it.mediumImage || it.thumbnailImage || '',
        url,
        rating, reviews,
        brand,
        brandName: brand ? (it.brandName || '') : '',
        category: inferCategory(it.categoryPath),
      };
    }
  }

  // Dedup variants: same base product name → keep the highest-discount one only
  const bestByKey = {};
  for (const d of Object.values(found)) {
    const k = baseNameKey(d.name);
    if (!bestByKey[k] || d.off > bestByKey[k].off) bestByKey[k] = d;
  }
  const deals = Object.values(bestByKey);
  console.log(`[sync-walmart] ${deals.length} new qualifying Walmart deals (after variant dedup)`);
  if (deals.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, added: 0 }) };
  }

  // 2. Swap: remove the previous auto-pulled Walmart deals (keep any marked as top
  //    picks), then insert the fresh set. Only runs when we actually have new deals,
  //    so an API hiccup never leaves the grid empty.
  try {
    const del = await fetch(`${sbUrl}/rest/v1/deals?store=eq.Walmart&is_top_pick=eq.false`, {
      method: 'DELETE', headers: { ...sbHeaders, Prefer: 'return=minimal' },
    });
    console.log(`[sync-walmart] cleared previous Walmart deals -> HTTP ${del.status}`);
  } catch (e) { console.error('[sync-walmart] clear failed:', e.message); }

  // 3. Insert into Supabase
  const today = new Date().toISOString().split('T')[0];
  const rows  = deals.map((d, i) => ({
    rank:         i + 1,
    name:         d.name,
    store:        'Walmart',
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
    if (!ins.ok) { console.error(`[sync-walmart] insert chunk ${i} failed:`, await ins.text()); }
    else inserted += chunk.length;
  }

  console.log(`[sync-walmart] ✓ Inserted ${inserted} Walmart deals`);
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, added: inserted }),
  };
};
