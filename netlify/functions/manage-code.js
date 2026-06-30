// Admin-gated add/remove of promo-code deals via the Google Sheet gateway.
// The sheet is the source of truth, so adding/removing here edits the sheet
// (Apps Script web app); sync-codes then mirrors it onto the site.
//
// POST { password, action:'add'|'remove', amazon_link, promo_code, discount_price, asin }

function asinFromUrl(url) {
  const s = String(url || '');
  const m = s.match(/(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/product\/|[?&]asin=)([A-Z0-9]{10})/i);
  if (m) return m[1].toUpperCase();
  const b = s.match(/\b(B0[A-Z0-9]{8})\b/i);
  return b ? b[1].toUpperCase() : '';
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { password, action, amazon_link, promo_code, discount_price } = body;
  if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const gwUrl = process.env.SHEET_API_URL;
  const gwTok = process.env.SHEET_API_TOKEN;
  if (!gwUrl || !gwTok) return { statusCode: 500, body: JSON.stringify({ error: 'Sheet gateway not configured' }) };

  const callGateway = async (payload) => {
    const r = await fetch(gwUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: gwTok, ...payload }),
      redirect: 'follow',
    });
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { ok: false, error: 'gateway non-JSON: ' + text.slice(0, 120) }; }
  };

  try {
    if (action === 'add') {
      const asin = asinFromUrl(amazon_link);
      if (!asin) return { statusCode: 400, body: JSON.stringify({ error: 'No Amazon ASIN found in that link' }) };
      const res = await callGateway({
        action: 'append',
        amazon_link: String(amazon_link || ''),
        promo_code: String(promo_code || ''),
        discount_price: String(discount_price || ''),
      });
      return { statusCode: res.ok ? 200 : 502, body: JSON.stringify({ ...res, asin }) };
    }

    if (action === 'remove') {
      const asin = (body.asin ? String(body.asin) : asinFromUrl(amazon_link)).toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(asin)) return { statusCode: 400, body: JSON.stringify({ error: 'Invalid ASIN' }) };
      // 1) remove the row from the sheet (so the sync won't re-add it)
      const res = await callGateway({ action: 'remove', asin });
      // 2) delete it from the grid now (don't wait for the next sync)
      const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (sbUrl && sbKey) {
        await fetch(`${sbUrl}/rest/v1/deals?url=like.*${asin}*&is_top_pick=eq.false`, {
          method: 'DELETE',
          headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, Prefer: 'return=minimal' },
        }).catch(() => {});
      }
      return { statusCode: res.ok ? 200 : 502, body: JSON.stringify({ ...res, asin }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'manage-code failed', detail: String(e).slice(0, 200) }) };
  }
};
