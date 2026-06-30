var ENDPOINT = 'https://founditcheaper.netlify.app/.netlify/functions/manage-code';
var $ = function (id) { return document.getElementById(id); };
var savedPw = '';
var currentTab = null;

function isAmazon(u) { return /amazon\.[a-z.]+/i.test(u || ''); }
function setStatus(m, c) { var s = $('status'); s.textContent = m; s.className = 'status' + (c ? ' ' + c : ''); }
function setHint(m) { $('hint').textContent = m; }

// Injected into the page: pull promo code + deal price + Amazon link (heuristic).
function scrapeDeal() {
  var out = { code: '', price: '', link: '' };
  try {
    // DealSeek encodes ASIN + retail + deal price + code in the URL's dealHash —
    // far more reliable than scraping (avoids grabbing a price from another deal).
    var hm = location.href.match(/dealHash=([^&#]+)/i);
    if (hm) {
      var h; try { h = decodeURIComponent(hm[1]); } catch (e) { h = hm[1]; }
      var a = h.match(/^([A-Z0-9]{10})/i) || h.match(/\b(B0[A-Z0-9]{8})\b/i);
      if (a) out.link = 'https://www.amazon.com/dp/' + a[1].toUpperCase();
      var nums = (h.match(/\d+\.\d{2}/g) || []).map(parseFloat).filter(function (n) { return n > 0; });
      if (nums.length >= 2) out.price = String(nums[1]);          // ASIN-ID-RETAIL-DEAL → deal is 2nd
      else if (nums.length) out.price = String(nums[0]);
      var c = h.match(/-{2,}([A-Za-z0-9]{5,14})(?![A-Za-z0-9])/);
      if (c && /[A-Za-z]/.test(c[1]) && !/^B0[A-Z0-9]{8}$/.test(c[1].toUpperCase())) out.code = c[1].toUpperCase();
    }
    var html = document.documentElement ? document.documentElement.innerHTML : '';
    var text = document.body ? (document.body.innerText || '') : '';
    // PRICE fallback: first product $ amount, skipping commission ("$X/sale", "$X/click")
    if (!out.price) {
      var cleaned = text.replace(/\$\s?\d+(?:\.\d+)?\s*\/\s*(?:sale|click)/gi, ' ');
      var pm = cleaned.match(/\$\s?(\d{1,4}(?:\.\d{1,2})?)/); if (pm) out.price = pm[1];
    }
    // LINK fallback: an Amazon ASIN in any anchor, then anywhere in the HTML
    if (!out.link) {
      var asin = '';
      var as = document.querySelectorAll('a[href]');
      for (var i = 0; i < as.length; i++) {
        var ah = as[i].getAttribute('href') || '';
        var m = ah.match(/(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|%2Fdp%2F|[?&]asin=)([A-Z0-9]{10})/i);
        if (m) { asin = m[1].toUpperCase(); break; }
      }
      if (!asin) { var mm = html.match(/(?:\/dp\/|asin["'=:%>\s]+)([A-Z0-9]{10})/i) || html.match(/\b(B0[A-Z0-9]{8})\b/); if (mm) asin = mm[1].toUpperCase(); }
      if (asin) out.link = 'https://www.amazon.com/dp/' + asin;
    }
    // CODE fallback: an element that is JUST a promo-code-looking token
    if (!out.code) {
      var nodes = document.querySelectorAll('div,span,p,strong,b,code,h1,h2,h3,h4,td,li');
      for (var j = 0; j < nodes.length; j++) {
        var t = (nodes[j].textContent || '').trim();
        if (/^[A-Z0-9]{6,14}$/.test(t) && /[A-Z]/.test(t) && /[0-9]/.test(t) && !/^B0[A-Z0-9]{8}$/.test(t)) { out.code = t; break; }
      }
    }
  } catch (e) { out.err = String(e); }
  return out;
}

chrome.storage.local.get(['ficPw'], function (res) {
  savedPw = res.ficPw || '';
  if (savedPw) { $('pwRow').classList.add('saved'); $('changePw').style.display = 'inline-block'; }
});

chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
  currentTab = tabs && tabs[0];
  var url = (currentTab && currentTab.url) || '';
  if (isAmazon(url)) {
    $('link').value = url;
    chrome.storage.local.get(['pendCode', 'pendPrice'], function (p) {
      if (p.pendCode && !$('code').value) $('code').value = p.pendCode;
      if (p.pendPrice && !$('price').value) $('price').value = p.pendPrice;
    });
    tryClipboardCode();
    setHint('Amazon link grabbed. Review code + price, then Add.');
  } else {
    setHint('Reading this page for code, price, and the Amazon link…');
    grabFromPage(true);
  }
});

// On Amazon, DealSeek's "Copy Code & Open Amazon" leaves the code on the clipboard.
function tryClipboardCode() {
  try {
    navigator.clipboard.readText().then(function (txt) {
      txt = (txt || '').trim();
      if (!$('code').value && /^[A-Z0-9]{5,14}$/.test(txt) && /[A-Z]/.test(txt) && /[0-9]/.test(txt) && !/^B0[A-Z0-9]{8}$/.test(txt)) {
        $('code').value = txt;
      }
    }).catch(function () {});
  } catch (e) {}
}

function grabFromPage(auto) {
  if (!currentTab || !currentTab.id) { setStatus('No active tab to read.', 'err'); return; }
  chrome.scripting.executeScript({ target: { tabId: currentTab.id }, func: scrapeDeal }, function (results) {
    if (chrome.runtime.lastError) { setStatus("Can't read this page: " + chrome.runtime.lastError.message, 'err'); return; }
    var r = results && results[0] && results[0].result;
    if (!r) { setStatus('Could not read this page.', 'err'); return; }
    if (r.code) $('code').value = r.code;
    if (r.price) $('price').value = r.price;
    if (r.link) $('link').value = r.link;
    chrome.storage.local.set({ pendCode: r.code || '', pendPrice: r.price || '' });
    var got = [r.code ? 'code' : '', r.price ? 'price' : '', r.link ? 'link' : ''].filter(Boolean);
    if (got.length) { setStatus('Grabbed: ' + got.join(' + ') + (r.code ? '  (' + r.code + ')' : ''), 'ok'); setHint(r.link ? 'Got the Amazon link too — review and Add. No need to open Amazon.' : 'Couldn\'t find the Amazon link here — open the deal on Amazon, then reopen me.'); }
    else { setStatus('Nothing found here — type it in, or open the deal on Amazon.', 'err'); }
  });
}

// Auto-scan toggle — remembered across sessions.
chrome.storage.local.get(['ficAutoScan'], function (res) { $('autoScan').checked = !!res.ficAutoScan; });
$('autoScan').addEventListener('change', function () {
  var on = $('autoScan').checked;
  chrome.storage.local.set({ ficAutoScan: on });
  if (on) {
    setStatus('Auto-scan on — every page you open will be scanned.', 'ok');
    if (currentTab && currentTab.id) chrome.scripting.executeScript({ target: { tabId: currentTab.id }, files: ['content.js'] }, function () { if (chrome.runtime.lastError) {} });
  } else {
    setStatus('Auto-scan off — use the Scan button when you need it.', 'ok');
  }
});

$('scanBtn').addEventListener('click', function () {
  if (!currentTab || !currentTab.id) { setStatus('No active tab to scan.', 'err'); return; }
  chrome.scripting.executeScript({ target: { tabId: currentTab.id }, files: ['content.js'] }, function () {
    if (chrome.runtime.lastError) { setStatus("Can't scan this page: " + chrome.runtime.lastError.message, 'err'); return; }
    setStatus('Scan on — hover a deal, click the gold button.', 'ok');
    setTimeout(function () { window.close(); }, 700);
  });
});
$('changePw').addEventListener('click', function () { $('pwRow').classList.remove('saved'); $('changePw').style.display = 'none'; $('pw').value = ''; $('pw').focus(); });

$('addBtn').addEventListener('click', async function () {
  var pw = $('pwRow').classList.contains('saved') ? savedPw : ($('pw').value || '').trim();
  var link = ($('link').value || '').trim();
  var code = ($('code').value || '').trim();
  var price = ($('price').value || '').trim();
  if (!pw) { setStatus('Enter your admin password first.', 'err'); return; }
  if (!/\/(dp|gp\/product|gp\/aw\/d|product)\/[A-Z0-9]{10}|[?&]asin=[A-Z0-9]{10}|\bB0[A-Z0-9]{8}\b/i.test(link)) {
    setStatus('Need a valid Amazon product link.', 'err'); return;
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
      $('code').value = ''; $('price').value = ''; $('link').value = '';
    } else { setStatus('Failed: ' + (data.error || ('HTTP ' + res.status)), 'err'); }
  } catch (e) { setStatus('Network error — try again.', 'err'); }
  $('addBtn').disabled = false;
});
