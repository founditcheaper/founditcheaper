const AFFILIATE_TAG = 'founditchea09-20';

function withTag(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (u.hostname.includes('amazon.com')) {
      u.searchParams.set('tag', AFFILIATE_TAG);
      return u.toString();
    }
  } catch {}
  return url;
}

// In-process Creators API token cache
let _creatorsToken = null, _creatorsTokenExp = 0, _creatorsEligible = true;

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
  if (!data.access_token) throw new Error('Token failed');
  _creatorsToken    = data.access_token;
  _creatorsTokenExp = Date.now() + (data.expires_in || 3600) * 1000;
  return _creatorsToken;
}

async function fetchImages(asin) {
  // Amazon Creators API only — Rainforest removed for Associates compliance.
  if (_creatorsEligible) {
    try {
      const token = await getCreatorsToken();
      const res   = await fetch('https://creatorsapi.amazon/catalog/v1/getItems', {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-marketplace': 'www.amazon.com' },
        body:    JSON.stringify({
          itemIds: [asin], itemIdType: 'ASIN',
          resources:   ['images.primary.large', 'images.variants.large'],
          partnerTag:  AFFILIATE_TAG, partnerType: 'Associates', marketplace: 'www.amazon.com',
        }),
      });
      const data       = await res.json();
      const reason = data.reason || data.errors?.[0]?.reason;
      if (reason === 'AssociateNotEligible') {
        _creatorsEligible = false;
      } else {
        const item    = data.itemsResult?.items?.[0];
        if (item) {
          const primary  = item.images?.primary?.large?.url;
          const variants = (item.images?.variants || []).map(v => v.large?.url).filter(Boolean);
          const imgs     = primary ? [primary, ...variants] : variants;
          if (imgs.length >= 2) return imgs;
        }
      }
    } catch {}
  }

  return [];
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let password, deals, activeDate;
  try {
    ({ password, deals, activeDate } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // Owner (Erik), the VA (Kuldeep), and the promo agent may all manage Top Deal Picks.
  const _ok = (process.env.ADMIN_PASSWORD && password === process.env.ADMIN_PASSWORD)
           || (process.env.VA_PASSWORD && password === process.env.VA_PASSWORD)
           || (process.env.AGENT_PASSWORD && password === process.env.AGENT_PASSWORD);
  if (!_ok) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // Password valid — if no deals, this was just a login probe
  if (!deals || deals.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, saved: 0 }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const date        = activeDate || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const headers     = {
    apikey:          supabaseKey,
    Authorization:   `Bearer ${supabaseKey}`,
    'Content-Type':  'application/json',
  };

  // Build rows (images populated below)
  const rows = deals.map((d, i) => ({
    rank:         d.rank ?? i + 1,
    name:         d.name,
    store:        d.store,
    price:        d.price,
    was:          d.was,
    // Always derive % off from the actual prices so the badge can't disagree with
    // them (the admin Fetch may have left a stale API discount in d.off).
    off:          (Number(d.was) > Number(d.price) && Number(d.was) > 0)
                    ? Math.round((1 - Number(d.price) / Number(d.was)) * 100)
                    : (Number(d.off) || 0),
    rating:       d.rating  ?? 0,
    reviews:      d.reviews ?? 0,
    code:         d.code || null,
    use_code_url: d.useCodeUrl ?? false,
    creator:      d.creator ?? false,
    img:          d.img,
    url:          withTag(d.url),
    category:     d.category  || null,
    brand:        d.brand     ?? false,
    brand_name:   d.brandName || null,
    active_date:  date,
    is_top_pick:  true,
    images:       null,
  }));

  // Fetch product images in parallel for all Amazon deals before inserting
  await Promise.all(rows.map(async (row) => {
    const asin = (row.url || '').match(/\/dp\/([A-Z0-9]{10})/i)?.[1];
    if (!asin) return;
    const imgs = await fetchImages(asin);
    if (imgs.length >= 2) row.images = JSON.stringify(imgs);
  }));

  const storedCount = rows.filter(r => r.images).length;
  console.log(`[save-deals] ${storedCount}/${rows.length} deals have images stored`);

  // Replace all existing top picks with the new set
  const del = await fetch(`${supabaseUrl}/rest/v1/deals?is_top_pick=eq.true`, {
    method: 'DELETE', headers: { ...headers, Prefer: 'return=minimal' },
  });
  if (!del.ok) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to clear existing deals' }) };
  }

  const ins = await fetch(`${supabaseUrl}/rest/v1/deals`, {
    method:  'POST',
    headers: { ...headers, Prefer: 'return=minimal' },
    body:    JSON.stringify(rows),
  });

  if (!ins.ok) {
    const detail = await ins.text();
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to save deals', detail }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, saved: rows.length, imagesStored: storedCount }) };
};
