// Scan mode: injected on demand. As your mouse moves over deals, it scans the
// card under the cursor. The moment it detects a promo code (revealed on hover
// on sites like DealSeek), it captures the code + the real product price + the
// "View deal" link, then pops an "add this deal" prompt over that deal.
//
// DealSeek specifics handled here:
//  - The top banner shows COMMISSION ("$2.16/sale", "+ $0.46/click") — those $
//    amounts are ignored so the real product price ($17.99 / $29.99) is used.
//  - The Amazon link isn't on the card; only a "View deal" redirect is. We send
//    that to the background worker, which follows it to the real Amazon page.

(function () {
  if (window.__ficScanOn) { window.__ficToast && window.__ficToast('Scan already on — hover a deal.'); return; }
  window.__ficScanOn = true;

  var prompt = document.createElement('button');
  prompt.style.cssText = 'position:absolute;z-index:2147483647;display:none;background:#f5c842;color:#0a1f33;font:800 12px Inter,Arial,sans-serif;border:none;border-radius:6px;padding:7px 11px;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,.4);white-space:nowrap';
  document.documentElement.appendChild(prompt);

  // Keep the prompt on screen long enough to move to it and click (the code on
  // the card disappears the moment you move off it, but we already captured it).
  var hideTimer = null;
  function scheduleHide(ms) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function check() {
      // Never hide while the cursor is actually on the button — keep it up.
      if (prompt.matches(':hover')) { hideTimer = setTimeout(check, 1000); return; }
      prompt.style.display = 'none'; lastCard = null;
    }, ms);
  }
  prompt.addEventListener('mouseenter', function () { clearTimeout(hideTimer); });
  prompt.addEventListener('mouseleave', function () { scheduleHide(10000); });

  function cleanCode(c) { return (c || '').toUpperCase().replace(/COPY$/, ''); }

  // DealSeek encodes ASIN + retail + deal price + code in the deal URL's
  // dealHash — far more reliable than reading the rendered card.
  function parseDealHash(url) {
    var out = {};
    var m = (url || '').match(/dealHash=([^&#]+)/i);
    if (!m) return out;
    var h; try { h = decodeURIComponent(m[1]); } catch (e) { h = m[1]; }
    var a = h.match(/^([A-Z0-9]{10})/i) || h.match(/\b(B0[A-Z0-9]{8})\b/i);
    if (a) out.asin = a[1].toUpperCase();
    var nums = (h.match(/\d+\.\d{2}/g) || []).map(parseFloat).filter(function (n) { return n > 0; });
    if (nums.length) out.price = String(Math.min.apply(null, nums)); // deal price = the lower
    var c = h.match(/-{2,}([A-Za-z0-9]{5,14})(?:-{2,}|$)/);
    if (c && /[A-Za-z]/.test(c[1]) && /[0-9]/.test(c[1]) && !/^B0[A-Z0-9]{8}$/.test(c[1].toUpperCase())) out.code = c[1].toUpperCase();
    return out;
  }

  var toastEl = document.createElement('div');
  toastEl.style.cssText = 'position:fixed;bottom:14px;right:14px;z-index:2147483647;display:none;background:#0a1f33;color:#fff;font:600 12px Inter,Arial,sans-serif;border:1px solid #4ade80;border-radius:8px;padding:9px 12px;max-width:320px;line-height:1.4;box-shadow:0 4px 16px rgba(0,0,0,.4)';
  document.documentElement.appendChild(toastEl);
  function toast(m) { toastEl.textContent = m; toastEl.style.display = 'block'; clearTimeout(toast._t); toast._t = setTimeout(function () { toastEl.style.display = 'none'; }, 2800); }
  window.__ficToast = toast;

  var inS = 'width:100%;padding:7px 8px;margin-top:3px;border-radius:6px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:#fff;font-size:12px;box-sizing:border-box;outline:none';
  var lbS = 'display:block;font-size:10px;font-weight:700;color:#8aa0b4;text-transform:uppercase;letter-spacing:.4px;margin-top:9px';
  var panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;top:14px;right:14px;z-index:2147483647;display:none;background:#0a1f33;color:#fff;font-family:Inter,Arial,sans-serif;border:1px solid #f5c842;border-radius:10px;padding:14px;width:300px;box-shadow:0 6px 26px rgba(0,0,0,.55)';
  panel.innerHTML =
    '<div style="font-weight:800;color:#f5c842;font-size:13px;margin-bottom:2px">Review this deal</div>' +
    '<div style="font-size:11px;color:#8aa0b4">Fix anything, then Save.</div>' +
    '<label style="' + lbS + '">Amazon link</label><input id="ficLink" style="' + inS + '" placeholder="(resolved from the deal link)">' +
    '<label style="' + lbS + '">Promo code</label><input id="ficCode" style="' + inS + '" placeholder="(none)">' +
    '<label style="' + lbS + '">After-code price</label><input id="ficPrice" style="' + inS + '" placeholder="19.99">' +
    '<label style="' + lbS + '">Retail price (was)</label><input id="ficWas" style="' + inS + '" placeholder="optional">' +
    '<div id="ficHint" style="font-size:10px;color:#f5c842;margin-top:5px;line-height:1.4"></div>' +
    '<div style="display:flex;gap:8px;margin-top:11px">' +
      '<button id="ficSave" style="flex:1;padding:9px;border:none;border-radius:7px;background:#f5c842;color:#0a1f33;font-weight:800;font-size:12px;cursor:pointer">Save to site</button>' +
      '<button id="ficCancel" style="padding:9px 12px;border:1px solid rgba(255,255,255,.2);border-radius:7px;background:transparent;color:#8aa0b4;font-weight:700;font-size:12px;cursor:pointer">Cancel</button>' +
    '</div>' +
    '<div id="ficResult" style="font-size:11px;margin-top:9px;min-height:13px;line-height:1.4"></div>';
  document.documentElement.appendChild(panel);
  var $ = function (id) { return panel.querySelector('#' + id); };

  // On a DealSeek deal page (URL carries a dealHash with all the info), show a
  // PERMANENT Add button — no hovering needed, so it can never vanish on you.
  var detailBtn = document.createElement('button');
  detailBtn.textContent = '➕ Add this deal to founditcheaper';
  detailBtn.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;display:none;background:#f5c842;color:#0a1f33;font:800 13px Inter,Arial,sans-serif;border:none;border-radius:8px;padding:10px 16px;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.45)';
  document.documentElement.appendChild(detailBtn);
  detailBtn.addEventListener('click', function () {
    var dh = parseDealHash(location.href);
    if (!dh.asin) { toast('No deal found in this page link.'); return; }
    openReview({ link: 'https://www.amazon.com/dp/' + dh.asin, code: dh.code || '', price: dh.price || '', was: scrapeRetail(), title: scrapeTitle(), dealUrl: location.href, prices: dh.price ? [dh.price] : [] });
  });
  // Re-check as you move between deals (DealSeek swaps the URL without reloading).
  setInterval(function () {
    if (panel.style.display === 'block') return;
    if (/dealHash=/i.test(location.href)) {
      var dh = parseDealHash(location.href);
      detailBtn.textContent = '➕ Add this deal' + (dh.code ? ' — code ' + dh.code : '');
      detailBtn.style.display = 'block';
    } else { detailBtn.style.display = 'none'; }
  }, 700);

  // Best-effort scrapes for the detail page (fill the review panel + give the
  // server a retail price and title even when the Amazon API is unavailable).
  function scrapeRetail() {
    var els = document.querySelectorAll('s,del,[style*="line-through"]');
    for (var i = 0; i < els.length; i++) { var m = (els[i].textContent || '').match(/\$\s?(\d{1,4}(?:\.\d{1,2})?)/); if (m) return m[1]; }
    return '';
  }
  function scrapeTitle() {
    var els = document.querySelectorAll('h1,h2,h3');
    for (var i = 0; i < els.length; i++) { var t = (els[i].textContent || '').replace(/\s+/g, ' ').trim(); if (t.length >= 20 && t.length <= 250 && !/\$/.test(t)) return t; }
    return '';
  }

  var lastCard = null;
  var hoverDeal = null;
  var reviewDealUrl = '';
  var reviewTitle = '';

  function findCard(el) {
    var node = el, depth = 0;
    while (node && node !== document.body && depth < 16) {
      if (node.nodeType === 1 && node.querySelector) {
        var txt = node.textContent || '';
        var hasPrice = /\$\s?\d/.test(txt);
        var isPromo = /promo\s*code/i.test(txt);
        var w = node.getBoundingClientRect().width;
        var pc = productPrices(txt).length; // one card ≈ 1–2 prices; a multi-card wrapper has more
        if (hasPrice && isPromo && pc >= 1 && pc <= 3 && w > 120 && w < window.innerWidth * 0.45) return node;
      }
      node = node.parentNode; depth++;
    }
    return null;
  }

  // Product prices only — drop commission amounts ("$2.16/sale", "+ $0.46/click")
  // and percent figures ("(12.0%)").
  function productPrices(text) {
    var cleaned = text
      .replace(/\$\s?\d+(?:\.\d+)?\s*\/\s*(?:sale|click)/gi, ' ')
      .replace(/\(\s*\d+(?:\.\d+)?\s*%\s*\)/g, ' ');
    return (cleaned.match(/\$\s?\d{1,4}(?:\.\d{1,2})?/g) || [])
      .map(function (s) { return s.replace(/[^0-9.]/g, ''); })
      .filter(function (n) { return parseFloat(n) > 0; });
  }

  function extract(card) {
    var out = { code: '', price: '', link: '', dealUrl: '', prices: [] };
    var text = card.textContent || '', html = card.innerHTML || '';

    var p = productPrices(text);
    out.prices = p;
    if (p.length) {
      var nums = p.map(parseFloat);
      out.price = String(Math.min.apply(null, nums)); // deal price = the lower one
    }

    // Promo code: prefer the "Promo Code XXXX" text revealed on hover.
    // Read the code from the dedicated "Promo Code XXXX" box ONLY — scanning the
    // whole card merges the store name + rating and grabs the wrong thing.
    var boxRe = /^promo\s*code\s*:?\s*([A-Za-z0-9]{5,14})(?:\s*copy)?$/i;
    var els = card.querySelectorAll('div,span,p,b,strong,code,button');
    for (var j = 0; j < els.length; j++) {
      var raw = (els[j].textContent || '').replace(/\s+/g, ' ').trim();
      var bm = raw.match(boxRe);
      if (bm) {
        var cc = cleanCode(bm[1]);
        if (cc.length >= 5 && /[0-9]/.test(cc) && /[A-Z]/.test(cc) && !/^B0[A-Z0-9]{8}$/.test(cc)) { out.code = cc; break; }
      }
    }
    if (!out.code) { // fallback: an element that is just the bare code token
      for (var k = 0; k < els.length; k++) {
        var t = cleanCode((els[k].textContent || '').trim());
        if (/^[A-Z0-9]{6,14}$/.test(t) && /[A-Z]/.test(t) && /[0-9]/.test(t) && !/^B0[A-Z0-9]{8}$/.test(t)) { out.code = t; break; }
      }
    }

    // Direct Amazon link if the card happens to have one.
    var asin = '';
    var links = card.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var h = links[i].getAttribute('href') || '';
      var m = h.match(/(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|%2Fdp%2F|[?&]asin=)([A-Z0-9]{10})/i);
      if (m) { asin = m[1].toUpperCase(); break; }
    }
    if (!asin) { var hm = html.match(/(?:\/dp\/)([A-Z0-9]{10})/i) || html.match(/\b(B0[A-Z0-9]{8})\b/); if (hm) asin = hm[1].toUpperCase(); }
    if (asin) out.link = 'https://www.amazon.com/dp/' + asin;

    // Otherwise capture the "View deal" redirect for the background to follow.
    for (var k = 0; k < links.length; k++) {
      var lt = (links[k].textContent || '').toLowerCase();
      var lh = links[k].getAttribute('href') || '';
      if (lt.indexOf('view deal') >= 0 || /amazon|amzn|\/out|\/go|\/r\/|redirect|deeplink|geni\.us|joylink/i.test(lh)) { out.dealUrl = links[k].href; break; }
    }
    if (!out.dealUrl && links.length) out.dealUrl = links[0].href;

    // If the deal link carries a DealSeek dealHash, trust it over the scraped card.
    var dh = parseDealHash(out.dealUrl);
    if (dh.asin) out.link = 'https://www.amazon.com/dp/' + dh.asin;
    if (dh.price) out.price = dh.price;
    if (dh.code) out.code = dh.code;

    // Retail (was) = highest price on the card; title = longest leaf text.
    if (out.prices.length > 1) out.was = String(Math.max.apply(null, out.prices.map(parseFloat)));
    var best = '';
    var tels = card.querySelectorAll('a,span,div,p,h1,h2,h3,strong,b');
    for (var ti = 0; ti < tels.length; ti++) {
      if (tels[ti].children.length) continue; // leaf nodes only
      var tt = (tels[ti].textContent || '').replace(/\s+/g, ' ').trim();
      if (tt.length > best.length && tt.length <= 250 && !/\$/.test(tt) && !/promo\s*code|view deal|view variants|share deal|budget/i.test(tt)) best = tt;
    }
    if (best.length >= 15) out.title = best;
    return out;
  }

  function showPrompt(card, d) {
    hoverDeal = d;
    prompt.textContent = '➕ Add — code ' + d.code;
    prompt.style.display = 'block';
    var r = card.getBoundingClientRect();
    var pw = prompt.offsetWidth || 160;
    var left = window.scrollX + r.left + (r.width - pw) / 2;
    if (left < window.scrollX + 4) left = window.scrollX + 4;
    prompt.style.top = (window.scrollY + r.top + 8) + 'px';
    prompt.style.left = left + 'px';
    clearTimeout(hideTimer); // stays while you're on the card; countdown starts on leave
  }

  function tryCapture(card, attempt) {
    if (lastCard !== card || panel.style.display === 'block') return;
    var d = extract(card);
    if (d.code && (d.link || d.dealUrl)) { showPrompt(card, d); return; }
    if (attempt < 6) setTimeout(function () { tryCapture(card, attempt + 1); }, 160);
    else { hoverDeal = d; prompt.style.display = 'none'; }
  }

  document.addEventListener('mouseover', function (e) {
    if (panel.style.display === 'block') return;
    if (e.target === prompt) return;
    var card = findCard(e.target);
    if (!card) {                              // moved off the card → start the countdown
      if (prompt.style.display === 'block') scheduleHide(10000);
      return;
    }
    if (card === lastCard) { clearTimeout(hideTimer); return; } // still on it → keep showing
    lastCard = card;
    clearTimeout(hideTimer);
    tryCapture(card, 0);
  }, true);

  function openReview(d) {
    reviewDealUrl = d.dealUrl || '';
    reviewTitle = d.title || '';
    $('ficLink').value = d.link || '';
    $('ficCode').value = d.code || '';
    $('ficPrice').value = d.price || '';
    $('ficWas').value = d.was || '';
    $('ficHint').textContent = (d.prices && d.prices.length > 1)
      ? 'Prices on card: $' + d.prices.join(', $') + ' — lowest is used as the deal price.'
      : (d.link ? '' : 'Link will be resolved by following the deal link.');
    $('ficResult').textContent = '';
    prompt.style.display = 'none';
    detailBtn.style.display = 'none';
    panel.style.display = 'block';
  }

  prompt.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    if (hoverDeal) openReview(hoverDeal);
  });

  $('ficCancel').addEventListener('click', function () { panel.style.display = 'none'; lastCard = null; });

  $('ficSave').addEventListener('click', function () {
    var link = ($('ficLink').value || '').trim();
    var code = ($('ficCode').value || '').trim();
    var price = ($('ficPrice').value || '').trim();
    var was = ($('ficWas').value || '').trim();
    var resEl = $('ficResult');
    var hasLink = /\/dp\/[A-Z0-9]{10}|\/gp\/product\/[A-Z0-9]{10}|[?&]asin=[A-Z0-9]{10}|\bB0[A-Z0-9]{8}\b/i.test(link);
    if (!hasLink && !reviewDealUrl) {
      resEl.style.color = '#f87171'; resEl.textContent = 'No Amazon link and no deal link to follow.'; return;
    }
    var sv = $('ficSave'); sv.disabled = true; sv.textContent = 'Saving…';
    resEl.style.color = '#8aa0b4'; resEl.textContent = hasLink ? 'Adding…' : 'Following the deal link to Amazon…';
    chrome.runtime.sendMessage({ type: 'ficAdd', link: hasLink ? link : '', dealUrl: reviewDealUrl, code: code, price: price, retail: was, title: reviewTitle }, function (resp) {
      sv.disabled = false; sv.textContent = 'Save to site';
      if (chrome.runtime.lastError) { resEl.style.color = '#f87171'; resEl.textContent = 'Error: ' + chrome.runtime.lastError.message; return; }
      if (resp && resp.ok) {
        resEl.style.color = '#4ade80';
        resEl.textContent = '✓ Added' + (resp.instant ? ' — live now' : ' — will appear shortly') + (resp.resolved ? ' (' + resp.resolved + ')' : '');
        setTimeout(function () { panel.style.display = 'none'; lastCard = null; }, 1700);
      } else {
        resEl.style.color = '#f87171';
        resEl.textContent = 'Failed: ' + ((resp && resp.error) || 'no response from worker');
      }
    });
  });

  // Only announce when manually started; auto-scan runs silently in the background.
  chrome.storage.local.get(['ficAutoScan'], function (r) {
    if (!r.ficAutoScan) toast('Scan on — move your mouse over deals; a prompt appears when a code is found.');
  });
})();
