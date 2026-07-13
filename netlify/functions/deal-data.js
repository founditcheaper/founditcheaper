// Durable single-deal lookup for shared/email links (?deal=<id>).
//
// WHY THIS EXISTS: the daily email links each deal as founditcheaper.net/?deal=<id>
// (the Amazon-compliant share link). The site opens the product card by looking that
// id up in the `deals` table. But the daily sync jobs DELETE those rows within a day
// (sync-codes prunes aged coded deals, sync-walmart wipes+re-syncs Walmart, the Amazon
// no-code grid purge, etc.). So a subscriber who opens the email a few hours or a day
// later clicks a link whose deal no longer exists, the card silently fails, and they
// land on the bare homepage. That is the "links don't open the product" complaint.
//
// FIX: when the daily email is built we POST a snapshot of those deals here. The site's
// openDrawer() falls back to a GET here whenever the live lookup comes up empty, so the
// product card ALWAYS opens from an email link — even after the live row is deleted.
//
// GET  /.netlify/functions/deal-data?id=<numericId>
//        Public, read-only. Returns { deal, ended } where `deal` is a deals-table-shaped
//        row (or null). `ended:true` means it came from the snapshot store (the live row
//        is gone), so the UI can note that price/stock may have changed.
//
// POST /.netlify/functions/deal-data   { password, deals:[ {id,name,img,price,was,off,
//        code,url,store,category,rating,reviews,images,price_checked_at,active_date} ] }
//        Auth: ADMIN_PASSWORD (owner) or AGENT_PASSWORD (the email agent). Upserts each
//        deal into the `emailed_deal_snapshots` setting (a JSON map keyed by id), capped
//        to the most recent SNAP_CAP entries so the row can never grow without bound.

const SNAP_KEY = 'emailed_deal_snapshots';
const SNAP_CAP = 200;                 // keep the newest N snapshots; old email links age out

// Fields we persist in a snapshot — the subset of `deals` columns the product drawer uses.
const SNAP_FIELDS = ['id', 'name', 'store', 'category', 'brand', 'brand_name', 'price',
  'was', 'off', 'code', 'img', 'url', 'images', 'rating', 'reviews', 'first_seen',
  'created_at', 'active_date', 'price_checked_at', 'price_unavailable', 'verified_low', 'ends_at'];

function cleanId(v) { return String(v == null ? '' : v).replace(/[^0-9]/g, ''); }

exports.handler = async function (event) {
  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, body: JSON.stringify({ error: 'Config error' }) };
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  // ── READ: resolve one deal by id ──────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const id = cleanId((event.queryStringParameters || {}).id);
    if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'Missing or invalid id' }) };
    try {
      // 1) Live row first (service role bypasses RLS, so a merely-hidden row still resolves).
      const lr = await fetch(`${sbUrl}/rest/v1/deals?id=eq.${id}&select=*&limit=1`, { headers: H });
      if (lr.ok) {
        const rows = await lr.json();
        if (Array.isArray(rows) && rows[0]) {
          return { statusCode: 200, headers: { 'Cache-Control': 'public, max-age=120' }, body: JSON.stringify({ deal: rows[0], ended: false }) };
        }
      }
      // 2) Snapshot fallback — the live row was deleted by a sync job; serve the saved copy.
      const gr = await fetch(`${sbUrl}/rest/v1/settings?key=eq.${SNAP_KEY}&select=value`, { headers: H });
      if (gr.ok) {
        const s = await gr.json();
        if (Array.isArray(s) && s[0] && s[0].value) {
          let map = {};
          try { map = JSON.parse(s[0].value) || {}; } catch (e) {}
          const snap = map[id];
          if (snap) return { statusCode: 200, headers: { 'Cache-Control': 'public, max-age=120' }, body: JSON.stringify({ deal: snap, ended: true }) };
        }
      }
      return { statusCode: 200, headers: { 'Cache-Control': 'public, max-age=60' }, body: JSON.stringify({ deal: null, ended: false }) };
    } catch (e) {
      return { statusCode: 500, body: JSON.stringify({ error: 'lookup failed', detail: String(e).slice(0, 160) }) };
    }
  }

  // ── WRITE: save snapshots (agent/owner only) ──────────────────────────
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    const pass = String(body.password || '');
    const owner = process.env.ADMIN_PASSWORD, agent = process.env.AGENT_PASSWORD;
    const authed = (owner && pass === owner) || (agent && pass === agent);
    if (!authed) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };

    const incoming = Array.isArray(body.deals) ? body.deals : (body.deal ? [body.deal] : []);
    const removeIds = Array.isArray(body.remove) ? body.remove.map(cleanId).filter(Boolean) : [];
    if (!incoming.length && !removeIds.length) return { statusCode: 400, body: JSON.stringify({ error: 'No deals provided' }) };

    const now = Date.now();
    try {
      // Read current map.
      let map = {};
      const gr = await fetch(`${sbUrl}/rest/v1/settings?key=eq.${SNAP_KEY}&select=value`, { headers: H });
      if (gr.ok) {
        const s = await gr.json();
        if (Array.isArray(s) && s[0] && s[0].value) { try { map = JSON.parse(s[0].value) || {}; } catch (e) {} }
      }

      // Remove any ids the caller asked to drop (maintenance / cleanup).
      let removed = 0;
      removeIds.forEach(id => { if (map[id]) { delete map[id]; removed++; } });

      // Merge each incoming deal (keep only known fields + a save timestamp).
      let saved = 0;
      for (const d of incoming) {
        const id = cleanId(d.id);
        if (!id) continue;
        const snap = { id: id };
        SNAP_FIELDS.forEach(f => { if (d[f] !== undefined && f !== 'id') snap[f] = d[f]; });
        snap._snapshotAt = now;
        map[id] = snap;
        saved++;
      }

      // Cap to the newest SNAP_CAP entries so the settings value can't grow unbounded.
      const keys = Object.keys(map);
      if (keys.length > SNAP_CAP) {
        keys.sort((a, b) => (map[b]._snapshotAt || 0) - (map[a]._snapshotAt || 0));
        const keep = {};
        keys.slice(0, SNAP_CAP).forEach(k => { keep[k] = map[k]; });
        map = keep;
      }

      const wr = await fetch(`${sbUrl}/rest/v1/settings`, {
        method: 'POST',
        headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ key: SNAP_KEY, value: JSON.stringify(map) }),
      });
      if (!wr.ok) {
        const detail = await wr.text();
        return { statusCode: 502, body: JSON.stringify({ error: 'save failed', detail: detail.slice(0, 160) }) };
      }
      return { statusCode: 200, body: JSON.stringify({ ok: true, saved, removed, total: Object.keys(map).length }) };
    } catch (e) {
      return { statusCode: 500, body: JSON.stringify({ error: 'snapshot failed', detail: String(e).slice(0, 160) }) };
    }
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
