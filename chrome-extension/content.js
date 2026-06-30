// Scan mode: injected into a deal page on demand. Hovering a deal card shows a
// gold "Add" button; clicking it pulls that card's code + price + Amazon link
// and submits via the background worker. Heuristic — works by finding, for the
// card under the cursor, a price + an Amazon link + a promo-code-looking token.

(function () {
  if (window.__ficScanOn) { window.__ficToast && window.__ficToast('Scan already on — hover a deal.', false); return; }
  window.__ficScanOn = true;

  var btn = document.createElement('button');
  btn.textContent = '➕ Add to founditcheaper';
  btn.style.cssText = 'position:absolute;z-index:2147483647;display:none;background:#f5c842;color:#0a1f33;font:800 12px Inter,Arial,sans-serif;border:none;border-radius:6px;padding:6px 10px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.35)';
  var toastEl = document.createElement('div');
  toastEl.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;display:none;background:#0a1f33;color:#fff;font:600 12px Inter,Arial,sans-serif;border:1px solid #f5c842;border-radius:8px;padding:10px 28px 10px 12px;max-width:320px;line-height:1.45;white-space:pre-wrap;box-shadow:0 4px 16px rgba(0,0,0,.4)';
  var closeX = document.createElement('span');
  closeX.textContent = '✕';
  closeX.style.cssText = 'position:absolute;top:6px;right:8px;cursor:pointer;color:#8aa0b4;font-weight:700';
  closeX.addEventListener('click', function () { toastEl.style.display = 'none'; });
  toastEl.appendChild(closeX);
  var toastMsg = document.createElement('span');
  toastEl.appendChild(toastMsg);
  document.documentElement.appendChild(btn);
  document.documentElement.appendChild(toastEl);

  // sticky = stay until dismissed (used for results so we can read them)
  function toast(m, err, sticky) {
    toastMsg.textContent = m;
    toastEl.style.borderColor = err ? '#f87171' : '#4ade80';
    toastEl.style.display = 'block';
    clearTimeout(toast._t);
    if (!sticky) toast._t = setTimeout(function () { toastEl.style.display = 'none'; }, 2800);
  }
  window.__ficToast = toast;

  var currentCard = null;

  function findCard(el) {
    var node = el, depth = 0;
    while (node && node !== document.body && depth < 14) {
      if (node.nodeType === 1 && node.querySelector) {
        var txt = node.textContent || '';
        var hasPrice = /\$\s?\d/.test(txt);
        var hasLink = node.querySelector('a[href*="amazon"],a[href*="/dp/"],a[href*="asin"],a[href*="/go/"],a[href*="redirect"],a[href*="goto"]');
        var w = node.getBoundingClientRect().width;
        if (hasPrice && hasLink && w > 120 && w < window.innerWidth * 0.5) return node;
      }
      node = node.parentNode; depth++;
    }
    return null;
  }

  function extract(card) {
    var out = { code: '', price: '', link: '' };
    var text = card.textContent || '', html = card.innerHTML || '';
    var pm = text.match(/\$\s?(\d{1,4}(?:\.\d{1,2})?)/); if (pm) out.price = pm[1];
    var asin = '';
    var links = card.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var h = links[i].getAttribute('href') || '';
      var m = h.match(/(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|%2Fdp%2F|[?&]asin=)([A-Z0-9]{10})/i);
      if (m) { asin = m[1].toUpperCase(); break; }
    }
    if (!asin) { var mm = html.match(/(?:\/dp\/)([A-Z0-9]{10})/i) || html.match(/\b(B0[A-Z0-9]{8})\b/); if (mm) asin = mm[1].toUpperCase(); }
    if (asin) out.link = 'https://www.amazon.com/dp/' + asin;
    var els = card.querySelectorAll('div,span,b,strong,code,p,button');
    for (var j = 0; j < els.length; j++) {
      var t = (els[j].textContent || '').trim();
      if (/^[A-Z0-9]{6,14}$/.test(t) && /[A-Z]/.test(t) && /[0-9]/.test(t) && !/^B0[A-Z0-9]{8}$/.test(t)) { out.code = t; break; }
    }
    return out;
  }

  document.addEventListener('mouseover', function (e) {
    if (e.target === btn) return;
    var card = findCard(e.target);
    if (card) {
      currentCard = card;
      var r = card.getBoundingClientRect();
      btn.style.top = (window.scrollY + r.top + 6) + 'px';
      btn.style.left = (window.scrollX + r.left + 6) + 'px';
      btn.style.display = 'block';
    }
  }, true);

  btn.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    if (!currentCard) return;
    var d = extract(currentCard);
    var grabbed = 'link: ' + (d.link || '— none —') + '\ncode: ' + (d.code || '— none —') + '\nprice: ' + (d.price || '— none —');
    if (!d.link) { toast('No Amazon link found on this card.\n' + grabbed, true, true); return; }
    btn.disabled = true; var old = btn.textContent; btn.textContent = 'Adding…';
    chrome.runtime.sendMessage({ type: 'ficAdd', link: d.link, code: d.code, price: d.price }, function (resp) {
      btn.disabled = false; btn.textContent = old;
      if (chrome.runtime.lastError) { toast('Extension error: ' + chrome.runtime.lastError.message + '\n' + grabbed, true, true); return; }
      if (resp && resp.ok) toast('✓ Added' + (resp.instant ? ' (live now)' : ' (will appear shortly)') + '\n' + grabbed, false, true);
      else toast('Server said NO: ' + ((resp && resp.error) || 'no response from background worker') + '\n' + grabbed, true, true);
    });
  });

  toast('Scan on — hover a deal, click the gold button.', false);
})();
