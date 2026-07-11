// First-party analytics: log an anonymous on-site event (a visit or a search).
// The front end pings this fire-and-forget. NO personal data is stored: just the
// event type, the search term, how many results it returned, a random session id,
// and a coarse traffic source. Written server-side with the service key (the events
// table is RLS-locked, so the public/anon key can't read or write it directly).
//
// POST { type, term?, results?, sid?, source? }
//   type   : 'visit' | 'search'  (anything else is rejected)
//   term   : the search text (search events only)
//   results: how many deals that search matched (0 = a search that found nothing)
//   sid    : random per-session id from the browser (dedupes visits, not a person)
//   source : coarse referrer bucket (instagram, facebook, google, direct, ...)

const clean = (s, n) => (s == null ? null : String(s).slice(0, n));

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: 'bad json' }; }

  const type = String(b.type || '');
  if (type !== 'visit' && type !== 'search') return { statusCode: 400, body: 'bad type' };

  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 200, body: '{"ok":false}' };   // never error the client

  let results = null;
  if (b.results != null) { const n = parseInt(b.results, 10); if (!isNaN(n)) results = Math.max(0, Math.min(100000, n)); }

  const row = {
    type,
    term: type === 'search' ? clean(b.term, 100) : null,
    results_count: type === 'search' ? results : null,
    session_id: clean(b.sid, 64),
    source: clean(b.source, 40),
  };

  try {
    await fetch(`${sbUrl}/rest/v1/events`, {
      method: 'POST',
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(row),
    });
  } catch (e) { /* best-effort; analytics must never break the page */ }

  return { statusCode: 204, headers: { 'Cache-Control': 'no-store' }, body: '' };
};
