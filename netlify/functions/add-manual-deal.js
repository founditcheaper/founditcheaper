// Admin-gated MANUAL deal entry for stores with no API (Home Depot, Best Buy, Lowe's…).
// Amazon deals auto-enrich from the Creators API by ASIN; these can't, so every field is
// supplied by hand. The buy link is whatever affiliate link the agent pastes (e.g. a
// Mavely link) and the site's buy button uses it exactly as-is (affiliateUrl() returns
// the stored url unchanged for non-Amazon stores).
//
// POST { password, store, name, url, img, price, was, category, code }

// Frontend uses no-space store keys; accept the friendly labels too.
const STORE_KEY = {
  'Home Depot': 'HomeDepot', 'HomeDepot': 'HomeDepot',
  'Best Buy': 'BestBuy', 'BestBuy': 'BestBuy',
  "Lowe's": 'Lowes', 'Lowes': 'Lowes',
  'Walmart': 'Walmart', 'Amazon': 'Amazon',
};

function todayCT() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); }

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) }; }

  const { password } = body;
  const role = (process.env.ADMIN_PASSWORD && password === process.env.ADMIN_PASSWORD) ? 'owner'
             : ((process.env.VA_PASSWORD && password === process.env.VA_PASSWORD) ||
                (process.env.AGENT_PASSWORD && password === process.env.AGENT_PASSWORD)) ? 'va' : null;
  if (!role) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized' }) };
  const uploader = (process.env.VA_PASSWORD && password === process.env.VA_PASSWORD) ? 'Kuldeep'
                 : (process.env.AGENT_PASSWORD && password === process.env.AGENT_PASSWORD) ? 'Manual Agent'
                 : 'Erik';

  const storeKey = STORE_KEY[String(body.store || '').trim()];
  const name  = String(body.name || '').trim().slice(0, 250);
  const url   = String(body.url || '').trim();
  const img   = String(body.img || '').trim();
  const category = String(body.category || '').trim() || 'Everything Else';
  const code  = (String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '')) || null;
  const price = Number(body.price);
  let   was   = Number(body.was);

  if (!storeKey)               return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Pick a store' }) };
  if (!name)                   return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Product title is required' }) };
  if (!/^https?:\/\//i.test(url)) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Paste the product / affiliate link (https://…)' }) };
  if (!(price > 0))            return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Enter a valid deal price' }) };
  if (!(was > price)) was = price;                     // no valid "was" → treat as no discount
  const off = was > price ? Math.round((1 - price / was) * 100) : 0;

  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Config error' }) };
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  const row = {
    rank: 900, name, store: storeKey, category, price, was, off,
    rating: 0, reviews: 0, img: img || null, images: null,
    url,                                               // pasted affiliate link — used as-is
    code, use_code_url: false, creator: false, brand: false, brand_name: null,
    active_date: todayCT(), is_top_pick: false,
    uploaded_by: uploader, review_status: 'live',      // manually curated → live immediately
  };

  try {
    const ins = await fetch(`${sbUrl}/rest/v1/deals`, {
      method: 'POST', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(row),
    });
    if (!ins.ok) {
      const t = await ins.text();
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'Insert failed', detail: t.slice(0, 160) }) };
    }
    const rows = await ins.json().catch(() => []);
    const id = Array.isArray(rows) && rows[0] ? rows[0].id : null;
    return { statusCode: 200, body: JSON.stringify({ ok: true, id, store: storeKey }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(e).slice(0, 160) }) };
  }
};
