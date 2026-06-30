// Service worker: receives "add this deal" messages from the in-page scan
// buttons and submits to manage-code using the saved admin password. Runs in
// the extension's own context, so it has host permission and isn't CORS-blocked.
//
// On deal sites (DealSeek) the card has no Amazon link — only a "View deal"
// redirect. When we get a dealUrl instead of a direct Amazon link, we follow it
// to the real Amazon page and pull the ASIN out of the landed URL / page.

var ENDPOINT = 'https://founditcheaper.netlify.app/.netlify/functions/manage-code';
var ASIN_RE = /(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|%2Fdp%2F|[?&]asin=)([A-Z0-9]{10})/i;

function amazonUrl(asin) { return 'https://www.amazon.com/dp/' + asin.toUpperCase(); }

// Return a usable Amazon link (with ASIN), or '' if we couldn't resolve one.
async function resolveAmazon(link, dealUrl) {
  if (link && ASIN_RE.test(link)) return link;
  if (!dealUrl) return '';
  try {
    var r = await fetch(dealUrl, { redirect: 'follow' });
    var landed = r.url || '';
    var m = landed.match(ASIN_RE);
    if (m) return amazonUrl(m[1]);
    // Redirect may be JS-based; scan the returned HTML for an ASIN.
    var html = await r.text();
    var hm = html.match(ASIN_RE) || html.match(/\b(B0[A-Z0-9]{8})\b/);
    if (hm) return amazonUrl(hm[1]);
  } catch (e) { /* fall through */ }
  return '';
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'ficAdd') return;
  (async function () {
    var store = await chrome.storage.local.get(['ficPw']);
    var pw = store.ficPw || '';
    if (!pw) { sendResponse({ ok: false, error: 'No saved password — open the extension popup and add it once.' }); return; }

    var amazon = await resolveAmazon(msg.link || '', msg.dealUrl || '');
    if (!amazon) { sendResponse({ ok: false, error: "Couldn't find the Amazon link from this deal — open the deal on Amazon and use the popup instead." }); return; }

    var resolvedNote = (!msg.link && amazon) ? ('link: ' + (amazon.match(ASIN_RE) ? amazon.match(ASIN_RE)[1] : '')) : '';
    try {
      var res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw, action: 'add', amazon_link: amazon, promo_code: msg.code || '', discount_price: msg.price || '' }),
      });
      var d = await res.json().catch(function () { return {}; });
      if (res.status === 401) { sendResponse({ ok: false, error: 'Wrong saved password' }); return; }
      sendResponse({ ok: !!(d && d.ok), instant: d && d.instant, resolved: resolvedNote, error: d && d.error });
    } catch (e) { sendResponse({ ok: false, error: String(e) }); }
  })();
  return true; // async response
});
