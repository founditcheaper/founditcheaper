// Admin-only: remove a promo-code deal from the grid and BLOCK its ASIN so the
// sheet sync (sync-codes) and the Amazon sync never re-add it.
//
// POST { password, action: 'block' | 'unblock', asin, label }
//   block   -> upsert ASIN into blocked_deals + delete its row(s) from the grid now
//   unblock -> remove ASIN from blocked_deals (it can flow back in on the next sync)
//
// Requires the blocked_deals table (see setup SQL). Gated by ADMIN_PASSWORD.

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { password, action, asin, label } = body;
  if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const norm = String(asin || '').toUpperCase().trim();
  if (!/^[A-Z0-9]{10}$/.test(norm)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid ASIN' }) };
  }

  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, body: JSON.stringify({ error: 'Config error' }) };
  const h = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  try {
    if (action === 'unblock') {
      const r = await fetch(`${sbUrl}/rest/v1/blocked_deals?asin=eq.${norm}`, {
        method: 'DELETE', headers: { ...h, Prefer: 'return=minimal' },
      });
      return { statusCode: r.ok ? 200 : 500, body: JSON.stringify({ ok: r.ok, action: 'unblock', asin: norm }) };
    }

    // block (default): record it, then pull it from the grid immediately
    const ins = await fetch(`${sbUrl}/rest/v1/blocked_deals`, {
      method: 'POST',
      headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ asin: norm, label: String(label || '').slice(0, 250) }),
    });
    if (!ins.ok) {
      const detail = await ins.text();
      return { statusCode: 500, body: JSON.stringify({ error: 'block list write failed', detail: detail.slice(0, 200) }) };
    }
    // Remove it from the All Deals grid now (leave manual Top Picks untouched)
    await fetch(`${sbUrl}/rest/v1/deals?url=like.*${norm}*&is_top_pick=eq.false`, {
      method: 'DELETE', headers: { ...h, Prefer: 'return=minimal' },
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true, action: 'block', asin: norm }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'block-deal failed', detail: String(e).slice(0, 200) }) };
  }
};
