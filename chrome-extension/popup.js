var ENDPOINT = 'https://founditcheaper.netlify.app/.netlify/functions/manage-code';

var $ = function (id) { return document.getElementById(id); };
var savedPw = '';

// Load saved password + prefill the Amazon link from the current tab.
chrome.storage.local.get(['ficPw'], function (res) {
  savedPw = res.ficPw || '';
  if (savedPw) { $('pwRow').classList.add('saved'); $('changePw').style.display = 'inline-block'; }
});

chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
  var url = (tabs && tabs[0] && tabs[0].url) || '';
  if (/amazon\.[a-z.]+\/.*(?:\/dp\/|\/gp\/|\/product\/)/i.test(url) || /amazon\.[a-z.]+/i.test(url) && /[A-Z0-9]{10}/.test(url)) {
    $('link').value = url;
  }
});

$('changePw').addEventListener('click', function () {
  $('pwRow').classList.remove('saved');
  $('changePw').style.display = 'none';
  $('pw').value = '';
  $('pw').focus();
});

function setStatus(msg, cls) {
  var s = $('status');
  s.textContent = msg;
  s.className = 'status' + (cls ? ' ' + cls : '');
}

$('addBtn').addEventListener('click', async function () {
  var pw = $('pwRow').classList.contains('saved') ? savedPw : ($('pw').value || '').trim();
  var link = ($('link').value || '').trim();
  var code = ($('code').value || '').trim();
  var price = ($('price').value || '').trim();

  if (!pw) { setStatus('Enter your admin password first.', 'err'); return; }
  if (!/\/(dp|gp\/product|gp\/aw\/d|product)\/[A-Z0-9]{10}|[?&]asin=[A-Z0-9]{10}|\bB0[A-Z0-9]{8}\b/i.test(link)) {
    setStatus('That doesn\'t look like an Amazon product link.', 'err'); return;
  }

  $('addBtn').disabled = true;
  setStatus('Adding…');
  try {
    var res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw, action: 'add', amazon_link: link, promo_code: code, discount_price: price }),
    });
    var data = await res.json();
    if (res.status === 401) { setStatus('Wrong admin password.', 'err'); $('addBtn').disabled = false; return; }
    if (res.ok && data.ok) {
      // remember the password now that it worked
      chrome.storage.local.set({ ficPw: pw });
      savedPw = pw;
      $('pwRow').classList.add('saved'); $('changePw').style.display = 'inline-block';
      setStatus(data.instant ? '✓ Added — live on the site now' : '✓ Added to the sheet — will appear shortly', 'ok');
      $('code').value = ''; $('price').value = '';   // ready for the next one
    } else {
      setStatus('Failed: ' + (data.error || ('HTTP ' + res.status)), 'err');
    }
  } catch (e) {
    setStatus('Network error — try again.', 'err');
  }
  $('addBtn').disabled = false;
});
