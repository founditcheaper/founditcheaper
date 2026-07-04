// Daily Top Deal Picks refresh (scheduled — see netlify.toml).
//
// Every morning this replaces the Top Deal Picks carousel with a FRESH,
// randomized set of 10 quality deals pulled from the current grid — a ~50/50
// Amazon/Walmart mix, with a boost for promo-code deals and recognized brands,
// plus a random jitter so the lineup feels new each day. Erik can still hand-edit
// the picks afterward; his changes hold until the next morning's run.
//
// It DEMOTES the prior picks back to the grid (is_top_pick=false) rather than
// deleting them, so nothing is lost — yesterday's picks just rejoin the pool.

const PICKS = 10;
const PROMO_TARGET = 5;   // include up to this many promo-code deals (if available)
const MIN_OFF = 15;       // quality floor

function score(d) {
  const off     = Number(d.off) || 0;
  const rating  = Number(d.rating) || 0;
  const reviews = Number(d.reviews) || 0;
  return off
       + rating * 5
       + Math.min(reviews, 5000) / 300
       + (d.brand ? 20 : 0)
       + (d.code ? 25 : 0)            // feature promo-code deals (Erik's focus)
       + Math.random() * 40;          // freshness — different lineup each day
}

// Recognized-brand test — the SAME regex the site's grid uses for its "Remove
// Inflated Discounts" filter. Kept in sync so the promoter never features a deal the
// grid itself would hide.
const BRAND_RE = /\b(sony|lg|nike|apple|samsung|ninja|dyson|beats|dewalt|milwaukee|bosch|kitchenaid|instant\s+pot|nespresso|adidas|under\s+armour|new\s+balance|north\s+face|patagonia|columbia|carhartt|levi'?s|black\s*[&+]\s*decker|craftsman|ridgid|makita|ryobi|snap.on|cuisinart|breville|hamilton\s+beach|oster|keurig|vitamix|nutribullet|lodge|calphalon|philips|braun|oral.b|shark|irobot|roomba|bose|jbl|anker|jabra|sennheiser|logitech|razer|corsair|microsoft|lenovo|dell|asus|acer|hp|ipad|iphone|macbook|airpods|garmin|fitbit|yeti|stanley|oxo|rubbermaid|weber|traeger|coleman|igloo|contigo|hydro\s+flask)\b/i;

// Guard against featuring an implausibly-discounted (i.e. mis-priced) deal in Top
// Picks. Without this, a bad source price like a "92% off" item that's really ~$100
// scores HIGH (score() adds `off`) and gets auto-promoted — and Top Picks are shown
// regardless of the grid's inflated-discount filter. CODED deals are exempt: their big
// discount is the legitimate after-code price and is the whole point of featuring them.
// For no-code deals we apply the grid's cap: no-name items are held to 65% off (unless
// the original price is under $25), recognized brands to 90%. Brand is judged by the
// brand FIELD only, never the title (a no-name "…for iPhone" charger must not read as
// branded), matching the grid.
function isInflated(d) {
  if (d.code) return false;
  const off = Number(d.off) || 0;
  const brandDeal = BRAND_RE.test(d.brand_name || '');
  const cap = (brandDeal || Number(d.was || 0) < 25) ? 90 : 65;
  return off > cap;
}

function baseNameKey(name) {
  return (name || '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').slice(0, 8).join(' ');
}

// Current Central-Time date + minutes-since-midnight (handles CST/CDT).
function ctParts() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const p = {}; for (const x of parts) p[x.type] = x.value;
  let hour = parseInt(p.hour, 10); if (hour === 24) hour = 0;
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: hour * 60 + parseInt(p.minute, 10) };
}

exports.handler = async function (event) {
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) { console.error('[promote-top-picks] missing env'); return { statusCode: 500, body: 'Configuration error' }; }
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };
  const force = !!(event && event.queryStringParameters && event.queryStringParameters.force);
  const nowCT = ctParts();
  const today = nowCT.date;

  // Editable settings (run time + promo count); defaults if the table is missing.
  let runTime = '02:30', promoTarget = PROMO_TARGET, lastRun = '';
  try {
    const sres = await fetch(`${sbUrl}/rest/v1/settings?select=key,value`, { headers: H });
    const srows = await sres.json();
    if (Array.isArray(srows)) {
      const m = {}; srows.forEach(s => { m[s.key] = s.value; });
      if (m.pick_run_time) runTime = m.pick_run_time;
      if (m.promo_target != null && m.promo_target !== '') promoTarget = Math.max(0, Math.min(10, parseInt(m.promo_target, 10) || PROMO_TARGET));
      lastRun = m.pick_last_run || '';
    }
  } catch (e) { /* settings table missing -> defaults */ }

  // Scheduled runs fire once per day at/after the configured time. The manual
  // "Generate now" button passes ?force=1 to bypass this gate.
  if (!force) {
    const [hh, mm] = String(runTime).split(':').map(n => parseInt(n, 10));
    const runMin = (hh || 0) * 60 + (mm || 0);
    if (lastRun === today) return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'already ran today' }) };
    if (nowCT.minutes < runMin) return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'before run time' }) };
    // Claim today's run by stamping last-run; if this write fails the settings
    // table doesn't exist yet, so abort (avoids re-running every tick).
    const claim = await fetch(`${sbUrl}/rest/v1/settings`, {
      method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key: 'pick_last_run', value: today }),
    });
    if (!claim.ok) return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'settings table missing — run the setup SQL to enable the schedule' }) };
  }

  // Candidates come from the GRID only (is_top_pick=false), so each day's set
  // rotates instead of re-picking the same deals. Variant-dedup, keep best score.
  const cres = await fetch(`${sbUrl}/rest/v1/deals?select=id,name,off,rating,reviews,brand,brand_name,was,code,store,is_top_pick,img,review_status&limit=5000`, { headers: H });
  const rows = await cres.json();
  const best = {};
  for (const r of (rows || [])) {
    if ((Number(r.off) || 0) < MIN_OFF) continue;
    if (!(r.img || '').trim()) continue;                                          // no image → never a Top Pick
    if (r.review_status === 'flagged' || r.review_status === 'pending') continue; // only clean, published deals
    if (isInflated(r)) continue;                                                  // skip implausibly-discounted (likely mis-priced) deals
    const k = baseNameKey(r.name);
    r._s = score(r);
    if (!best[k] || r._s > best[k]._s) best[k] = r;
  }
  const all = Object.values(best);

  // Promo codes get priority: take up to PROMO_TARGET coded deals (eligible
  // regardless of current state, so ~5 can be featured daily). Then fill the rest
  // with regular GRID deals (is_top_pick=false) so they rotate for freshness.
  const promo   = all.filter(d => d.code).sort((a, b) => b._s - a._s);
  const regular = all.filter(d => !d.code && !d.is_top_pick).sort((a, b) => b._s - a._s);
  const regAmz  = regular.filter(d => d.store === 'Amazon');
  const regWmt  = regular.filter(d => d.store !== 'Amazon');

  const ordered = promo.slice(0, promoTarget);
  let ai = 0, wi = 0;
  while (ordered.length < PICKS && (ai < regAmz.length || wi < regWmt.length)) {
    if (ai < regAmz.length && ordered.length < PICKS) ordered.push(regAmz[ai++]);
    if (wi < regWmt.length && ordered.length < PICKS) ordered.push(regWmt[wi++]);
  }
  // Thin catalog? Top up from any leftover promo deals.
  for (let i = promoTarget; i < promo.length && ordered.length < PICKS; i++) ordered.push(promo[i]);

  // Safety: if the grid is empty (a sync failed), leave the existing picks alone
  // rather than blanking the carousel.
  if (ordered.length === 0) {
    console.log('[promote-top-picks] no candidates — leaving existing picks unchanged');
    return { statusCode: 200, body: JSON.stringify({ ok: true, picked: 0 }) };
  }

  // Demote the prior picks back to the grid (don't delete — they rejoin the pool).
  await fetch(`${sbUrl}/rest/v1/deals?is_top_pick=eq.true`, {
    method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ is_top_pick: false }),
  });

  // Promote the fresh set.
  let promoted = 0;
  for (let i = 0; i < ordered.length; i++) {
    const r = await fetch(`${sbUrl}/rest/v1/deals?id=eq.${ordered[i].id}`, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({ is_top_pick: true, active_date: today, rank: i + 1 }),
    });
    if (r.ok) promoted++; else console.error(`[promote-top-picks] patch ${ordered[i].id} -> ${r.status}`);
  }

  console.log(`[promote-top-picks] ✓ refreshed Top Picks: ${promoted} deals`);
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, picked: promoted }),
  };
};
