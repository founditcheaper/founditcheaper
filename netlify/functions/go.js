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
  // Amazon shopping app URL scheme — opens the app to this product on iOS (and as a
  // fallback path). This is the exact scheme Joylink uses (verified), and it opens the
  // app even from inside Instagram/Facebook in-app browsers.
  const appUrl = `com.amazon.mobile.shopping.web://www.amazon.com/dp/${asin}?tag=${AFFILIATE_TAG}`;
  // Android intent:// URL — far more reliable than a bare custom scheme at breaking OUT of
  // an in-app webview (Gmail, etc.) into the real Amazon app. It carries its own web
  // fallback (browser_fallback_url), so if the app isn't installed it lands on the tagged
  // web page by itself. Package = the Amazon Shopping app on Google Play.
  const intentUrl = `intent://www.amazon.com/dp/${asin}?tag=${AFFILIATE_TAG}`
    + `#Intent;scheme=https;package=com.amazon.mShop.android.shopping;`
    + `S.browser_fallback_url=${encodeURIComponent(webUrl)};end`;

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
  <a id="appBtn" class="btn" href="${webUrl}">Continue in the Amazon app</a>
  <div class="h">or <a id="web" class="web" href="${webUrl}">continue on the web</a></div>
  <script>
  (function(){
    var web=${J(webUrl)}, app=${J(appUrl)}, intent=${J(intentUrl)};
    var ua=navigator.userAgent||'';
    var isAndroid=/Android/i.test(ua);
    var isIOS=/iPhone|iPad|iPod/i.test(ua);
    // Android: use the intent:// URL (best at escaping in-app browsers into the app; it has
    // its own web fallback built in). iOS: use the custom app scheme.
    function redirectToApp(){ try{ window.location = isAndroid ? intent : app; }catch(e){} }
    function redirectToFallBack(){ try{ window.location = web; }catch(e){} }

    // Manual button = a guaranteed one-tap path if the auto-open is blocked.
    var btn=document.getElementById('appBtn');
    if(btn){ btn.addEventListener('click', function(e){ e.preventDefault(); redirectToApp(); }); }

    var isFacebookMessengerIphone = /FBCR/i.test(ua) && /iPhone/i.test(ua);
    if(isAndroid){
      // intent:// opens the app and carries its own web fallback — no timer needed.
      redirectToApp();
    } else if(isIOS && !isFacebookMessengerIphone){
      // Launch the Amazon app, then fall back to the tagged web page ONLY if the app
      // didn't take over. Give iOS ~1.4s: the old 100ms fired the web redirect before the
      // OS could hand off to the app, which cancelled the launch and dumped everyone on
      // the mobile web page. The elapsed-time guard means that when the app DID open (JS
      // is frozen while Safari is backgrounded, so far more than 2s elapses), we don't yank
      // the shopper back to the web page when they return.
      redirectToApp();
      var _t0=Date.now();
      setTimeout(function(){ if(Date.now()-_t0 < 2000){ redirectToFallBack(); } }, 1400);
    } else {
      // Desktop (no app to open, and the custom scheme errors there) or FB Messenger on
      // iPhone (the scheme misbehaves): go straight to the tagged web page.
      redirectToFallBack();
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
