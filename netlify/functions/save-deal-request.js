// Public "Deal Alert" intake (from deal-alert.html). A visitor tells us an item they
// want and we store it in `deal_requests`. A separate scheduled job
// (match-deal-requests) watches the deals feed and emails them when a matching deal
// lands. Two-level opt-out: each request gets an `alert_token` for a per-item "stop
// alerting me about this" link; the newsletter unsubscribe is separate (Beehiiv).
//
// POST { email, query, targetPrice? }
//   query = either a pasted Amazon/Walmart product link OR a typed item name/keywords.
//   We auto-detect a link and pull the ASIN; otherwise we store lowercased keywords.

const AFFILIATE_TAG = 'founditchea09-20';

function extractAsin(url) {
  const s = String(url || '');
  const m = s.match(/(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/product\/|[?&]asin=)([A-Z0-9]{10})/i);
  if (m) return m[1].toUpperCase();
  const b = s.match(/\b(B0[A-Z0-9]{8})\b/i);
  return b ? b[1].toUpperCase() : null;
}
function isUrl(s) { return /^https?:\/\//i.test(String(s || '').trim()); }
function isWalmart(s) { return /walmart\.com/i.test(String(s || '')); }

// Typed item -> lowercased keyword tokens (drop tiny words + common filler so matching
// keys on the real product words).
const STOP = new Set(['the','a','an','for','and','with','of','to','in','on','my','me','it','is','are','this','that','need','want','looking','deal','deals','cheap','under','any','some','good','best','new']);
function toKeywords(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter(function (w) { return w.length >= 3 && !STOP.has(w); }).slice(0, 8);
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) }; }

  const email = String(body.email || '').trim().toLowerCase();
  const query = String(body.query || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Enter a valid email' }) };
  }
  if (query.length < 2 || query.length > 300) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Tell us the item you want' }) };
  }

  let targetPrice = null;
  const tp = parseFloat(body.targetPrice);
  if (!isNaN(tp) && tp > 0 && tp < 100000) targetPrice = Math.round(tp * 100) / 100;

  // Detect a pasted link vs typed keywords.
  let type = 'keyword', asin = null, store = 'any', keywords = [];
  if (isUrl(query)) {
    if (isWalmart(query)) { type = 'link'; store = 'Walmart'; }
    else { asin = extractAsin(query); type = asin ? 'asin' : 'link'; store = 'Amazon'; }
  } else {
    keywords = toKeywords(query);
    if (!keywords.length) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Add a few more words describing the item' }) };
    }
  }

  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Config error' }) };
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  const row = {
    email: email,
    type: type,
    query_text: query.slice(0, 300),
    asin: asin,
    keywords: keywords,
    store: store,
    target_price: targetPrice,
    active: true,
  };

  try {
    const r = await fetch(`${sbUrl}/rest/v1/deal_requests`, {
      method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(row),
    });
    if (!r.ok) {
      const d = await r.text();
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'Could not save your alert', detail: d.slice(0, 160) }) };
    }
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(e).slice(0, 160) }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
