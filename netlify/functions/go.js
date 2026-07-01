// Self-hosted deep linker — Amazon (replaces JoyLink for Amazon links).
//
// A shopper taps /deal/<ASIN> and this function serves a tiny interstitial page
// that OPENS THE AMAZON APP when it's installed — even from inside an in-app
// browser like Instagram or Facebook, which is the whole point of a deep link.
// A plain https://amazon.com link can't do this from those webviews; you have to
// launch the app's own URL scheme (iOS) / intent:// URL (Android). If the app
// isn't installed, it falls back to the tagged Amazon web page.
//
//   1. Validate the ASIN (so the endpoint can't be abused as an open redirect)
//   2. Build the app-scheme + web URLs, both carrying the founditchea09-20 tag
//   3. Log the click to Supabase (fire-and-forget — never blocks anything)
//   4. Return a page that jumps to the app, falling back to the web

const AFFILIATE_TAG = process.env.AFFILIATE_TAG || 'founditchea09-20';

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
    // ignore — stats are best-effort, the deep link is what matters
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

  // Plain tagged web URL — the universal fallback (works everywhere).
  const webUrl = `https://www.amazon.com/dp/${asin}?tag=${AFFILIATE_TAG}`;
  // iOS: the Amazon shopping app's own URL scheme opens the app to this product.
  const iosApp = `com.amazon.mobile.shopping.web://www.amazon.com/dp/${asin}?tag=${AFFILIATE_TAG}`;
  // Android: an intent:// URL opens the Amazon app, with a built-in web fallback
  // if the app isn't installed.
  const androidIntent =
    `intent://www.amazon.com/dp/${asin}?tag=${AFFILIATE_TAG}` +
    `#Intent;scheme=https;package=com.amazon.mShop.android.shopping;` +
    `S.browser_fallback_url=${encodeURIComponent(webUrl)};end`;

  // Log without blocking anything.
  await logClick(asin, event);

  const J = JSON.stringify;
  const html = `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Opening Amazon…</title>
<style>
  html,body{margin:0;height:100%}
  body{background:#0a1f33;color:#f5c842;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
       display:flex;min-height:100%;align-items:center;justify-content:center;flex-direction:column;gap:16px;padding:24px;text-align:center}
  .s{width:46px;height:46px;border-radius:50%;border:4px solid rgba(245,200,66,.25);border-top-color:#f5c842;animation:sp .8s linear infinite}
  @keyframes sp{to{transform:rotate(360deg)}}
  .t{font-size:16px;font-weight:800;letter-spacing:.3px}
  .btn{display:inline-block;background:#f5c842;color:#0a1f33;font-weight:800;font-size:15px;
       text-decoration:none;padding:13px 22px;border-radius:10px;letter-spacing:.3px}
  .h{font-size:13px;color:#8aa0b4}
  a.web{color:#8aa0b4;font-weight:700}
</style></head>
<body>
  <div class="s"></div>
  <div class="t">Opening Amazon…</div>
  <a id="appBtn" class="btn" href="${webUrl}">Open in the Amazon app</a>
  <div class="h">or <a id="web" class="web" href="${webUrl}">continue on the web</a></div>
  <script>
  (function(){
    var web=${J(webUrl)}, ios=${J(iosApp)}, intent=${J(androidIntent)};
    var ua=navigator.userAgent||'';
    var isAndroid=/Android/i.test(ua);
    var isIOS=/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && 'ontouchend' in document);
    var appUrl = isAndroid ? intent : ios;
    function go(u){ try{ window.location.href=u; }catch(e){} }
    function openApp(){ go(appUrl); }

    // Manual button = a guaranteed user-gesture path if the auto-open is blocked.
    var btn=document.getElementById('appBtn');
    if(btn){ btn.addEventListener('click', function(e){
      if(isAndroid || isIOS){ e.preventDefault(); openApp(); }
    }); }

    if(isAndroid){
      // intent:// decides app-vs-web by itself (S.browser_fallback_url). No extra timer.
      openApp();
    } else if(isIOS){
      // Try the app; only fall back to web if the app did NOT take over the screen.
      var done=false;
      function cancel(){ done=true; }
      document.addEventListener('visibilitychange', function(){ if(document.hidden) cancel(); });
      window.addEventListener('pagehide', cancel);
      window.addEventListener('blur', cancel);
      setTimeout(function(){ if(!done) go(web); }, 1400);
      openApp();
    } else {
      // Desktop / anything else — straight to the web page.
      go(web);
    }
  })();
  </script>
</body></html>`;

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    body: html,
  };
};
