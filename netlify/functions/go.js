// Self-hosted deep linker — Amazon (replaces JoyLink for Amazon links).
//
// A shopper clicks /go/<ASIN> and this function:
//   1. Validates the ASIN (so the endpoint can't be abused as an open redirect)
//   2. Builds the Amazon product URL with the founditcheaper-20 affiliate tag
//   3. Logs the click to Supabase (fire-and-forget — never blocks the redirect)
//   4. 302-redirects the shopper to Amazon
//
// Only Amazon is wired up for now. Other stores can be added later once their
// affiliate programs are connected — see the `store` handling below.

const AFFILIATE_TAG = process.env.AFFILIATE_TAG || 'founditcheaper-20';

// Amazon ASINs are always 10 chars: a digit or capital letters/digits.
const ASIN_RE = /^[A-Z0-9]{10}$/;

// Pull the ASIN from either /go/<ASIN> (path) or /go?asin=<ASIN> (query).
function extractAsin(event) {
  const q = (event.queryStringParameters && event.queryStringParameters.asin) || '';
  if (q) return q.trim().toUpperCase();
  const seg = (event.path || '').split('/').filter(Boolean).pop() || '';
  return seg.trim().toUpperCase();
}

// Fire-and-forget click log. Any failure here is swallowed so the redirect
// always succeeds even if Supabase is down or the table doesn't exist yet.
async function logClick(asin, event) {
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return;

  const h = event.headers || {};
  const row = {
    asin,
    store:   'Amazon',
    source:  (event.queryStringParameters && event.queryStringParameters.s) || null,
    referer: h.referer || h.referrer || null,
    ua:      h['user-agent'] || null,
  };

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  try {
    await fetch(`${sbUrl}/rest/v1/clicks`, {
      method:  'POST',
      headers: {
        apikey:         sbKey,
        Authorization:  `Bearer ${sbKey}`,
        'Content-Type': 'application/json',
        Prefer:         'return=minimal',
      },
      body:   JSON.stringify(row),
      signal: ctrl.signal,
    });
  } catch {
    // ignore — stats are best-effort, the redirect is what matters
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async function (event) {
  const asin = extractAsin(event);

  if (!ASIN_RE.test(asin)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'text/plain' },
      body: 'Bad link. Missing or invalid product id.',
    };
  }

  // Build the plain Amazon product URL with only the affiliate tag.
  // We intentionally do NOT append extra Amazon tracking params (e.g. ascsubtag)
  // — the policy around them is murky, so we keep the link clean and standard.
  // Channel tracking is handled by our own click log (the ?s= source), which
  // never touches the Amazon URL.
  const dest = `https://www.amazon.com/dp/${asin}?tag=${AFFILIATE_TAG}`;

  // Log without blocking the redirect.
  await logClick(asin, event);

  return {
    statusCode: 302,
    headers: {
      Location:       dest,
      'Cache-Control': 'no-store',
    },
    body: '',
  };
};
