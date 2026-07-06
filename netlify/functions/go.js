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
  // iOS app scheme — opens the Amazon app to this product on iPhones, even from inside
  // Instagram/Facebook in-app browsers. Same scheme Joylink uses; verified on iPhones.
  const appUrl = `com.amazon.mobile.shopping.web://www.amazon.com/dp/${asin}?tag=${AFFILIATE_TAG}`;
  // Android app launch — Chrome on Android blocks plain custom-scheme auto-redirects (which
  // left Android stuck on the mobile web page), so use its sanctioned intent:// URL. It opens
  // the Amazon app and carries its OWN web fallback (browser_fallback_url) if the app isn't
  // installed. Package = the Amazon Shopping app on Google Play.
  //
  // TEST TOGGLE: ?m=amz builds the intent around Amazon's own app SCHEME instead of the https
  // App Link. A custom scheme isn't tied to the phone's "Open supported links" setting, so it
  // can open the app even where App Links is set to "Always ask"/off (like the S9). This is
  // opt-in via the query param ONLY — with no ?m param, behavior is identical for everyone.
  const androidScheme = (event.queryStringParameters && event.queryStringParameters.m === 'amz')
    ? 'com.amazon.mobile.shopping.web' : 'https';
  const intentUrl = `intent://www.amazon.com/dp/${asin}?tag=${AFFILIATE_TAG}`
    + `#Intent;scheme=${androidScheme};package=com.amazon.mShop.android.shopping;`
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
    // Android → intent:// (Chrome's real app-launch). iOS → custom scheme (works on iPhones).
    function redirectToApp(){ try{ window.location = isAndroid ? intent : app; }catch(e){} }
    function redirectToFallBack(){ try{ window.location = web; }catch(e){} }

    // The button is the reliable path: tapping it is a real user gesture, which is exactly
    // what Chrome/Android REQUIRES to launch an app (it blocks gesture-less auto-launches).
    var btn=document.getElementById('appBtn');
    if(btn){ btn.addEventListener('click', function(e){ e.preventDefault(); redirectToApp(); }); }

    var isFacebookMessengerIphone = /FBCR/i.test(ua) && /iPhone/i.test(ua);
    if(isAndroid){
      // Samsung Internet honours a gesture-less auto-launch — keep it seamless there. Chrome
      // (and most other Android browsers) BLOCK it and would drop the shopper on the mobile
      // web page (the intent's own fallback), so DON'T auto-fire there — have them tap the
      // button (a real gesture), which opens the app reliably. Make the prompt say so.
      if(/SamsungBrowser/i.test(ua)){
        redirectToApp();
      } else {
        var t=document.querySelector('.t'); if(t){ t.textContent='Tap to open in the Amazon app'; }
      }
    } else {
      // iOS/desktop: seamless auto hand-off, then the tagged web page as fallback.
      if(!isFacebookMessengerIphone){ redirectToApp(); }
      setTimeout(redirectToFallBack, 100);
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
