// Service worker: receives "add this deal" messages from the in-page scan
// buttons and submits to manage-code using the saved admin password. Runs in
// the extension's own context, so it has host permission and isn't CORS-blocked.

var ENDPOINT = 'https://founditcheaper.netlify.app/.netlify/functions/manage-code';

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'ficAdd') return;
  chrome.storage.local.get(['ficPw'], function (res) {
    var pw = res.ficPw || '';
    if (!pw) { sendResponse({ ok: false, error: 'No saved password — open the extension popup and add it once.' }); return; }
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw, action: 'add', amazon_link: msg.link, promo_code: msg.code || '', discount_price: msg.price || '' }),
    })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
      .then(function (o) {
        if (o.status === 401) { sendResponse({ ok: false, error: 'Wrong saved password' }); return; }
        sendResponse({ ok: !!(o.d && o.d.ok), instant: o.d && o.d.instant, error: o.d && o.d.error });
      })
      .catch(function (e) { sendResponse({ ok: false, error: String(e) }); });
  });
  return true; // keep the message channel open for the async response
});
