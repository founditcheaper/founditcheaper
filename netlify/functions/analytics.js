// Admin analytics: returns aggregated on-site numbers for the admin dashboard.
// Reads with the service key via the analytics_* SQL functions, so raw click/search
// rows (which include coarse referrer/UA) never leave the server — only aggregates.
//
// POST { password, days? }  -> auth ADMIN_PASSWORD or AGENT_PASSWORD.
// Returns: { ok, days:[{dt,visits,clicks,cpv}], totals, topDeals:[{asin,name,clicks}],
//            topSearches:[{term,cnt,avg_results}], zeroSearches:[{term,cnt}] }

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: JSON.stringify({ error: 'bad json' }) }; }

  const pass = String(b.password || '');
  const owner = process.env.ADMIN_PASSWORD, agent = process.env.AGENT_PASSWORD;
  if (!((owner && pass === owner) || (agent && pass === agent))) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, body: JSON.stringify({ error: 'Config error' }) };
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };
  const days = Math.max(1, Math.min(90, parseInt(b.days, 10) || 14));

  const rpc = async (fn, args) => {
    try {
      const r = await fetch(`${sbUrl}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(args) });
      const j = await r.json();
      return Array.isArray(j) ? j : [];
    } catch (e) { return []; }
  };

  try {
    const [daily, topDeals, topSearches, zeroSearches] = await Promise.all([
      rpc('analytics_daily', { days }),
      rpc('analytics_top_deals', { days: 7, lim: 15 }),
      rpc('analytics_top_searches', { days: 7, lim: 20, zero_only: false }),
      rpc('analytics_top_searches', { days: 7, lim: 15, zero_only: true }),
    ]);

    // clicks-per-visit per day + rolling totals
    const daysOut = daily.map(d => {
      const visits = Number(d.visits) || 0, clicks = Number(d.clicks) || 0;
      return { dt: d.dt, visits, clicks, cpv: visits ? +(clicks / visits).toFixed(2) : 0 };
    });
    const last7 = daysOut.slice(-7);
    const sum = (arr, k) => arr.reduce((a, x) => a + x[k], 0);
    const v7 = sum(last7, 'visits'), c7 = sum(last7, 'clicks');
    const totals = { visits7: v7, clicks7: c7, cpv7: v7 ? +(c7 / v7).toFixed(2) : 0 };

    // resolve top-deal ASINs to names (best-effort)
    let topDealsOut = topDeals.map(d => ({ asin: d.asin, clicks: Number(d.clicks) || 0, name: d.asin }));
    const asins = topDealsOut.map(d => d.asin).filter(Boolean);
    if (asins.length) {
      try {
        const inList = asins.map(a => `"${a}"`).join(',');
        const r = await fetch(`${sbUrl}/rest/v1/deals?select=name,url&or=(${asins.map(a => `url.ilike.*${a}*`).join(',')})&limit=200`, { headers: H });
        const rows = await r.json();
        if (Array.isArray(rows)) {
          for (const d of topDealsOut) {
            const hit = rows.find(x => (x.url || '').toUpperCase().includes(d.asin.toUpperCase()));
            if (hit && hit.name) d.name = hit.name;
          }
        }
      } catch (e) {}
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        days: daysOut,
        totals,
        topDeals: topDealsOut,
        topSearches: topSearches.map(s => ({ term: s.term, cnt: Number(s.cnt) || 0, avg_results: Number(s.avg_results) || 0 })),
        zeroSearches: zeroSearches.map(s => ({ term: s.term, cnt: Number(s.cnt) || 0 })),
      }),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'analytics failed', detail: String(e).slice(0, 160) }) };
  }
};
