// Scan mode: injected into a deal page on demand. Hovering a deal card shows a
// gold "Add" button; clicking it opens a small REVIEW panel pre-filled with the
// code + price + Amazon link it grabbed, so you can fix anything (e.g. a wrong
// price) before saving. Save submits via the background worker. Heuristic — it
// finds, for the card under the cursor, a price + an Amazon link + a code token.

(function () {
  if (window.__ficScanOn) { window.__ficToast && window.__ficToast('Scan already on — hover a deal.'); return; }
  window.__ficScanOn = true;

  var btn = document.createElement('button');
  btn.textContent = '➕ Add to founditcheaper';
  btn.style.cssText = 'position:absolute;z-index:2147483647;display:none;background:#f5c842;color:#0a1f33;font:800 12px Inter,Arial,sans-serif;border:none;border-radius:6px;padding:6px 10px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.35)';
  document.documentElement.appendChild(btn);

  // Brief auto-hiding status (for "scan on" / "already on")
  var toastEl = document.createElement('div');
  toastEl.style.cssText = 'position:fixed;bottom:14px;right:14px;z-index:2147483647;display:none;background:#0a1f33;color:#fff;font:600 12px Inter,Arial,sans-serif;border:1px solid #4ade80;border-radius:8px;padding:9px 12px;max-width:300px;line-height:1.4;box-shadow:0 4px 16px rgba(0,0,0,.4)';
  document.documentElement.appendChild(toastEl);
  function toast(m) { toastEl.textContent = m; toastEl.style.display = 'block'; clearTimeout(toast._t); toast._t = setTimeout(function () { toastEl.style.display = 'none'; }, 2600); }
  window.__ficToast = toast;

  // Review panel
  var inS = 'width:100%;padding:7px 8px;margin-top:3px;border-radius:6px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:#fff;font-size:12px;box-sizing:border-box;outline:none';
  var lbS = 'display:block;font-size:10px;font-weight:700;color:#8aa0b4;text-transform:uppercase;letter-spacing:.4px;margin-top:9px';
  var panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;top:14px;right:14px;z-index:2147483647;display:none;background:#0a1f33;color:#fff;font-family:Inter,Arial,sans-serif;border:1px solid #f5c842;border-radius:10px;padding:14px;width:300px;box-shadow:0 6px 26px rgba(0,0,0,.55)';
  panel.innerHTML =
    '<div style="font-weight:800;color:#f5c842;font-size:13px;margin-bottom:2px">Review this deal</div>' +
    '<div style="font-size:11px;color:#8aa0b4">Fix anything, then Save.</div>' +
    '<label style="' + lbS + '">Amazon link</label><input id="ficLink" style="' + inS + '">' +
    '<label style="' + lbS + '">Promo code</label><input id="ficCode" style="' + inS + '" placeholder="(none)">' +
    '<label style="' + lbS + '">After-code price</label><input id="ficPrice" style="' + inS + '" placeholder="19.99">' +
    '<div id="ficHint" style="font-size:10px;color:#f5c842;margin-top:5px;line-height:1.4"></div>' +
    '<div style="display:flex;gap:8px;margin-top:11px">' +
      '<button id="ficSave" style="flex:1;padding:9px;border:none;border-radius:7px;background:#f5c842;color:#0a1f33;font-weight:800;font-size:12px;cursor:pointer">Save to site</button>' +
      '<button id="ficCancel" style="padding:9px 12px;border:1px solid rgba(255,255,255,.2);border-radius:7px;background:transparent;color:#8aa0b4;font-weight:700;font-size:12px;cursor:pointer">Cancel</button>' +
    '</div>' +
    '<div id="ficResult" style="font-size:11px;margin-top:9px;min-height:13px;line-height:1.4"></div>';
  document.documentElement.appendChild(panel);
  var $ = function (id) { return panel.querySelector('#' + id); };

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
    var out = { code: '', price: '', link: '', allPrices: [] };
    var text = card.textContent || '', html = card.innerHTML || '';
    out.allPrices = (text.match(/\$\s?\d{1,4}(?:\.\d{1,2})?/g) || []).map(function (s) { return s.replace(/[^0-9.]/g, ''); }).filter(function (n) { return parseFloat(n) > 0; });
    if (out.allPrices.length) out.price = out.allPrices[0];
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

  function openReview(d) {
    $('ficLink').value = d.link || '';
    $('ficCode').value = d.code || '';
    $('ficPrice').value = d.price || '';
    $('ficHint').textContent = (d.allPrices && d.allPrices.length > 1) ? 'Prices found on this card: $' + d.allPrices.join(', $') + ' — make sure the after-code price is right.' : '';
    $('ficResult').textContent = '';
    btn.style.display = 'none';
    panel.style.display = 'block';
  }

  document.addEventListener('mouseover', function (e) {
    if (panel.style.display === 'block') return;
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
    openReview(extract(currentCard));
  });

  $('ficCancel').addEventListener('click', function () { panel.style.display = 'none'; });

  $('ficSave').addEventListener('click', function () {
    var link = ($('ficLink').value || '').trim();
    var code = ($('ficCode').value || '').trim();
    var price = ($('ficPrice').value || '').trim();
    var resEl = $('ficResult');
    if (!/\/dp\/[A-Z0-9]{10}|\/gp\/product\/[A-Z0-9]{10}|[?&]asin=[A-Z0-9]{10}|\bB0[A-Z0-9]{8}\b/i.test(link)) {
      resEl.style.color = '#f87171'; resEl.textContent = 'Need a valid Amazon product link.'; return;
    }
    var sv = $('ficSave'); sv.disabled = true; sv.textContent = 'Saving…';
    chrome.runtime.sendMessage({ type: 'ficAdd', link: link, code: code, price: price }, function (resp) {
      sv.disabled = false; sv.textContent = 'Save to site';
      if (chrome.runtime.lastError) { resEl.style.color = '#f87171'; resEl.textContent = 'Error: ' + chrome.runtime.lastError.message; return; }
      if (resp && resp.ok) {
        resEl.style.color = '#4ade80';
        resEl.textContent = '✓ Added' + (resp.instant ? ' — live on the site now' : ' — will appear shortly');
        setTimeout(function () { panel.style.display = 'none'; }, 1500);
      } else {
        resEl.style.color = '#f87171';
        resEl.textContent = 'Failed: ' + ((resp && resp.error) || 'no response from worker');
      }
    });
  });

  toast('Scan on — hover a deal, click the gold button.');
})();
