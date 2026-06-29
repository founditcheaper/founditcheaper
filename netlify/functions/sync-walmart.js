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
const MIN_RATING   = 3.5;  // skip junk (0 rating = unknown, allowed)
const MIN_REVIEWS  = 3;

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

  // 1. Existing Walmart item ids (dedupe) — itemId is embedded in the /ip/<id> url
  const seen = new Set();
  try {
    const res  = await fetch(`${sbUrl}/rest/v1/deals?select=url&store=eq.Walmart&limit=20000`, { headers: sbHeaders });
    const rows = await res.json();
    for (const r of (rows || [])) { const m = (r.url || '').match(/\/ip\/(\d+)/); if (m) seen.add(m[1]); }
    console.log(`[sync-walmart] ${seen.size} existing Walmart deals in DB`);
  } catch (e) {
    console.error('[sync-walmart] Could not load existing Walmart deals:', e.message);
  }

  // 2. Search across terms IN PARALLEL (stays within the function time limit)
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
      if (!id || seen.has(id) || found[id]) continue;
      const price = Number(it.salePrice) || 0;
      const was   = Number(it.msrp) || 0;
      if (price <= 0 || was <= price) continue;            // require a real markdown
      const off = Math.round((1 - price / was) * 100);
      if (off < MIN_DISCOUNT) continue;
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
        category: inferCategory(it.categoryPath),
      };
    }
  }

  const deals = Object.values(found);
  console.log(`[sync-walmart] ${deals.length} new qualifying Walmart deals`);
  if (deals.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, added: 0 }) };
  }

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
