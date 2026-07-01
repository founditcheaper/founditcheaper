// Price-history logger for the "Verified Lowest" filter.
// Once a day it (1) records today's price for each deal's ASIN, then (2) flags a
// deal `verified_low = true` when its current price is at/near its lowest over
// the last 30 days. Needs ≥3 days of history for an ASIN before it will verify,
// so nothing shows as "verified" until the log has accumulated a few days.
//
// Requires (run once in Supabase SQL editor):
//   create table if not exists price_history (
//     id bigserial primary key, asin text not null, price numeric not null,
//     day date not null, unique(asin, day));
//   create index if not exists idx_price_history_asin_day on price_history(asin, day);
//   alter table price_history enable row level security;   -- service role only
//   alter table deals add column if not exists verified_low boolean default false;

const MIN_DAYS = 3;        // need at least this many days of history to verify
const NEAR_LOW = 1.02;     // "at/near" = within 2% of the 30-day low
const TIME_CAP_MS = 13 * 60 * 1000;

function asinOf(url) { const m = (url || '').match(/\/dp\/([A-Z0-9]{10})/i); return m ? m[1].toUpperCase() : ''; }
function ctDate(offsetDays) {
  const ms = Date.now() - (offsetDays || 0) * 86400000;
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

exports.handler = async function () {
  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, body: 'Supabase not configured' };
  const sb = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };
  const start = Date.now();
  const today = ctDate(0), cutoff = ctDate(30);

  // 1. Load all deals (id, url, price).
  let deals = [], off = 0;
  while (true) {
    const r = await fetch(`${sbUrl}/rest/v1/deals?select=id,url,price&limit=1000&offset=${off}`, { headers: sb });
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) break;
    deals = deals.concat(rows);
    if (rows.length < 1000) break; off += 1000;
  }

  // 2. Record today's price per ASIN (one row per ASIN per day).
  const byAsin = {};
  for (const d of deals) { const a = asinOf(d.url); if (a && Number(d.price) > 0) byAsin[a] = Number(d.price); }
  const logRows = Object.keys(byAsin).map(a => ({ asin: a, price: byAsin[a], day: today }));
  for (let i = 0; i < logRows.length; i += 500) {
    await fetch(`${sbUrl}/rest/v1/price_history?on_conflict=asin,day`, {
      method: 'POST', headers: { ...sb, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(logRows.slice(i, i + 500)),
    }).catch(() => {});
  }

  // 3. Pull the last 30 days of history; compute min price + distinct day count per ASIN.
  const hist = {}; let ho = 0;
  while (true) {
    const r = await fetch(`${sbUrl}/rest/v1/price_history?select=asin,price,day&day=gte.${cutoff}&limit=10000&offset=${ho}`, { headers: sb });
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) break;
    for (const h of rows) {
      const e = hist[h.asin] || (hist[h.asin] = { min: Infinity, days: {} });
      const p = Number(h.price); if (p > 0 && p < e.min) e.min = p;
      e.days[h.day] = 1;
    }
    if (rows.length < 10000) break; ho += 10000;
  }

  // 4. Flag each deal.
  let verified = 0, scanned = 0;
  for (const d of deals) {
    if (Date.now() - start > TIME_CAP_MS) { console.log('[log-prices] time cap'); break; }
    const a = asinOf(d.url); if (!a) continue;
    scanned++;
    const e = hist[a];
    const daysCount = e ? Object.keys(e.days).length : 0;
    const vlow = !!(e && daysCount >= MIN_DAYS && Number(d.price) > 0 && Number(d.price) <= e.min * NEAR_LOW);
    await fetch(`${sbUrl}/rest/v1/deals?id=eq.${encodeURIComponent(d.id)}`, {
      method: 'PATCH', headers: { ...sb, Prefer: 'return=minimal' }, body: JSON.stringify({ verified_low: vlow }),
    }).catch(() => {});
    if (vlow) verified++;
  }

  console.log(`[log-prices] logged=${logRows.length} scanned=${scanned} verified=${verified}`);
  return { statusCode: 200, body: JSON.stringify({ ok: true, logged: logRows.length, scanned, verified }) };
};
