var ENDPOINT = 'https://founditcheaper.netlify.app/.netlify/functions/manage-code';
var $ = function (id) { return document.getElementById(id); };
var savedPw = '';
var currentTab = null;

function isAmazonProduct(u) {
  u = u || '';
  return /amazon\.[a-z.]+\/.*(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/product\/|[?&]asin=)/i.test(u)
    || (/amazon\.[a-z.]+/i.test(u) && /\b[A-Z0-9]{10}\b/.test(u));
}
function setStatus(m, c) { var s = $('status'); s.textContent = m; s.className = 'status' + (c ? ' ' + c : ''); }
function setHint(m) { $('hint').textContent = m; }

// Injected into the page to pull the promo code + deal price (heuristic).
function scrapeDeal() {
  var out = { code: '', price: '' };
  try {
    var text = document.body ? (document.body.innerText || '') : '';
    var pm = text.match(/\$\s?(\d{1,4}(?:\.\d{1,2})?)/);     // first $ amount = the deal price
    if (pm) out.price = pm[1];
    var nodes = document.querySelectorAll('div,span,p,strong,b,code,h1,h2,h3,h4,td,li');
    for (var i = 0; i < nodes.length; i++) {
      var t = (nodes[i].textContent || '').trim();           // an element that is JUST a code-like token
      if (/^[A-Z0-9]{6,14}$/.test(t) && /[A-Z]/.test(t) && /[0-9]/.test(t) && !/^B0[A-Z0-9]{8}$/.test(t)) { out.code = t; break; }
    }
  } catch (e) {}
  return out;
}

chrome.storage.local.get(['ficPw'], function (res) {
  savedPw = res.ficPw || '';
  if (savedPw) { $('pwRow').classList.add('saved'); $('changePw').style.display = 'inline-block'; }
});

chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
  currentTab = tabs && tabs[0];
  var url = (currentTab && currentTab.url) || '';
  if (isAmazonProduct(url)) {
    $('link').value = url;
    chrome.storage.local.get(['pendCode', 'pendPrice'], function (p) {
      if (p.pendCode && !$('code').value) $('code').value = p.pendCode;
      if (p.pendPrice && !$('price').value) $('price').value = p.pendPrice;
      setHint('Amazon link grabbed' + ((p.pendCode || p.pendPrice) ? ' — code & price filled from the deal site. Review and Add.' : '. Add the code + price.'));
    });
  } else {
    setHint('Reading this page for the code + price… then open the deal on Amazon and reopen me to grab the link.');
    grabFromPage(true);
  }
});

function grabFromPage(auto) {
  if (!currentTab) return;
  chrome.scripting.executeScript({ target: { tabId: currentTab.id }, func: scrapeDeal }, function (results) {
    var r = results && results[0] && results[0].result;
    if (!r) { if (!auto) setStatus('Could not read this page.', 'err'); return; }
    if (r.code) $('code').value = r.code;
    if (r.price) $('price').value = r.price;
    chrome.storage.local.set({ pendCode: r.code || '', pendPrice: r.price || '' });  // remember for the Amazon step
    if (r.code || r.price) setStatus('Grabbed: ' + (r.code ? 'code ' + r.code : '') + (r.price ? '  $' + r.price : ''), 'ok');
    else if (!auto) setStatus('Nothing found on this page — type it in.', 'err');
  });
}

$('grabBtn').addEventListener('click', function () { grabFromPage(false); });
$('changePw').addEventListener('click', function () { $('pwRow').classList.remove('saved'); $('changePw').style.display = 'none'; $('pw').value = ''; $('pw').focus(); });

$('addBtn').addEventListener('click', async function () {
  var pw = $('pwRow').classList.contains('saved') ? savedPw : ($('pw').value || '').trim();
  var link = ($('link').value || '').trim();
  var code = ($('code').value || '').trim();
  var price = ($('price').value || '').trim();
  if (!pw) { setStatus('Enter your admin password first.', 'err'); return; }
  if (!/\/(dp|gp\/product|gp\/aw\/d|product)\/[A-Z0-9]{10}|[?&]asin=[A-Z0-9]{10}|\bB0[A-Z0-9]{8}\b/i.test(link)) {
    setStatus('Need a valid Amazon product link — open the deal on Amazon first.', 'err'); return;
  }
  $('addBtn').disabled = true; setStatus('Adding…');
  try {
    var res = await fetch(ENDPOINT, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw, action: 'add', amazon_link: link, promo_code: code, discount_price: price }),
    });
    var data = await res.json();
    if (res.status === 401) { setStatus('Wrong admin password.', 'err'); $('addBtn').disabled = false; return; }
    if (res.ok && data.ok) {
      chrome.storage.local.set({ ficPw: pw, pendCode: '', pendPrice: '' }); savedPw = pw;
      $('pwRow').classList.add('saved'); $('changePw').style.display = 'inline-block';
      setStatus(data.instant ? '✓ Added — live on the site now' : '✓ Added — will appear shortly', 'ok');
      $('code').value = ''; $('price').value = '';
    } else { setStatus('Failed: ' + (data.error || ('HTTP ' + res.status)), 'err'); }
  } catch (e) { setStatus('Network error — try again.', 'err'); }
  $('addBtn').disabled = false;
});
