// Scheduled: matches active `deal_requests` against the live deals feed and emails the
// requester when their item is on sale. Runs on a cron (see netlify.toml).
//
// Matching: exact ASIN (for pasted-link requests) OR all keywords present in a deal's
// title (for typed requests), same store if they specified one. Quality gate: only a
// real deal fires — under their target price if set, else >= MIN_OFF% off (coded deals
// always qualify). Dedupe: never alert the same request about the same product (ASIN)
// twice, and at most one alert per request per RATE_LIMIT window (no nagging).
//
// EMAIL LINK IS THE ON-SITE SHARE LINK (founditcheaper.net/?deal=<id>) — Amazon bans
// affiliate/direct links in email, so we send to the deal card and they click through
// from the site.
//
// Sends via the site's Private Email SMTP mailbox (same as game-end-notify).
// REQUIRED env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PRIVATE_EMAIL_PASS.

const nodemailer = require('nodemailer');

const SMTP_HOST = 'mail.privateemail.com';
const SMTP_PORT = 465;
const FROM = process.env.PRIVATE_EMAIL_USER || 'deals@founditcheaper.net';
const SITE = 'https://founditcheaper.net';
const MIN_OFF = 20;                    // quality gate when no target price is set
const RATE_LIMIT_MS = 12 * 3600000;    // at most one alert per request per 12h
const MAX_SENDS = 200;                 // safety cap per run

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
function asinOf(url) { var m = String(url || '').match(/\/dp\/([A-Z0-9]{10})/i) || String(url || '').match(/\b(B0[A-Z0-9]{8})\b/i); return m ? m[1].toUpperCase() : null; }
function shortName(n) { n = String(n || '').trim(); return n.length > 60 ? n.slice(0, 57) + '…' : n; }

async function loadDeals(sbUrl, H) {
  var out = [], from = 0;
  while (from < 6000) {
    var r = await fetch(`${sbUrl}/rest/v1/deals?select=id,name,url,price,was,off,code,store,img,category,review_status,ends_at&limit=1000&offset=${from}`, { headers: H });
    var rows = await r.json().catch(function () { return []; });
    if (!Array.isArray(rows) || !rows.length) break;
    out = out.concat(rows);
    if (rows.length < 1000) break;
    from += 1000;
  }
  var now = Date.now();
  return out.filter(function (d) {
    if (!String(d.img || '').trim()) return false;
    if (d.review_status === 'pending' || d.review_status === 'flagged') return false;
    if (d.ends_at && new Date(d.ends_at).getTime() < now) return false;
    return true;
  }).map(function (d) { d._asin = asinOf(d.url); d._ln = String(d.name || '').toLowerCase(); return d; });
}

function matchDeal(req, deals) {
  var cands = deals.filter(function (d) {
    if (req.store && req.store !== 'any' && d.store !== req.store) return false;
    if (req.asin) return d._asin === req.asin;
    var kws = req.keywords || [];
    if (!kws.length) return false;
    for (var i = 0; i < kws.length; i++) { if (d._ln.indexOf(String(kws[i]).toLowerCase()) === -1) return false; }
    return true;
  }).filter(function (d) {
    if (req.target_price != null) return Number(d.price) <= Number(req.target_price);
    return (Number(d.off) || 0) >= MIN_OFF || !!(d.code && String(d.code).trim());
  });
  if (!cands.length) return null;
  cands.sort(function (a, b) { return req.target_price != null ? (a.price - b.price) : ((b.off || 0) - (a.off || 0)); });
  return cands[0];
}

exports.handler = async function () {
  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) { console.error('[match-deal-requests] missing supabase env'); return { statusCode: 500, body: 'config' }; }
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  let reqs = [];
  try {
    const rr = await fetch(`${sbUrl}/rest/v1/deal_requests?active=eq.true&select=id,email,type,asin,keywords,store,target_price,alert_token,last_asin,last_alerted_at,query_text&limit=3000`, { headers: H });
    reqs = await rr.json();
    if (!Array.isArray(reqs)) reqs = [];
  } catch (e) { console.error('[match] request read failed:', e.message); return { statusCode: 200, body: 'request read failed' }; }
  if (!reqs.length) return { statusCode: 200, body: JSON.stringify({ ok: true, matched: 0, note: 'no active requests' }) };

  if (!process.env.PRIVATE_EMAIL_PASS) { console.warn('[match] PRIVATE_EMAIL_PASS not set — cannot send'); return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'PRIVATE_EMAIL_PASS not set' }) }; }

  const deals = await loadDeals(sbUrl, H);
  if (!deals.length) return { statusCode: 200, body: JSON.stringify({ ok: true, matched: 0, note: 'no live deals' }) };

  const now = Date.now();
  const toSend = [];
  for (let i = 0; i < reqs.length && toSend.length < MAX_SENDS; i++) {
    const req = reqs[i];
    if (req.last_alerted_at && (now - new Date(req.last_alerted_at).getTime()) < RATE_LIMIT_MS) continue;
    const deal = matchDeal(req, deals);
    if (!deal) continue;
    if (req.last_asin && deal._asin && req.last_asin === deal._asin) continue;   // already told them about this product
    toSend.push({ req: req, deal: deal });
  }
  if (!toSend.length) return { statusCode: 200, body: JSON.stringify({ ok: true, matched: 0 }) };

  const transporter = nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: true, auth: { user: FROM, pass: process.env.PRIVATE_EMAIL_PASS } });
  let sent = 0;
  for (let j = 0; j < toSend.length; j++) {
    const d = toSend[j].deal, q = toSend[j].req;
    const want = q.query_text || (q.keywords && q.keywords.join(' ')) || 'this item';
    const shareUrl = SITE + '/?deal=' + encodeURIComponent(d.id);                  // COMPLIANT: on-site deal card, never a direct Amazon link
    const stopUrl = SITE + '/stop-alert/' + encodeURIComponent(q.alert_token);
    const price = Math.round(Number(d.price) || 0);
    const was = d.was ? Math.round(Number(d.was)) : 0;
    const off = Number(d.off) || 0;
    const subject = (d.store || 'A store') + ' has the ' + shortName(d.name) + ' for $' + price;
    const codeLine = d.code ? ('<p style="margin:6px 0 0;font-size:14px">Use code <strong style="color:#0a1f33;background:#f5c842;padding:2px 8px;border-radius:4px">' + esc(d.code) + '</strong> at checkout</p>') : '';
    const html = ''
      + '<div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;color:#111">'
      + '<p style="font-size:13px;color:#666;margin:0 0 10px">You asked us to watch for <strong>' + esc(want) + '</strong>. Here it is:</p>'
      + (d.img ? ('<img src="' + esc(d.img) + '" alt="" style="width:100%;max-width:320px;border-radius:10px;display:block;margin:0 0 12px">') : '')
      + '<p style="font-size:16px;font-weight:700;margin:0 0 6px;line-height:1.3">' + esc(d.name) + '</p>'
      + '<p style="margin:0;font-size:20px"><strong style="color:#0a7d2c">$' + price + '</strong>'
      + (was && was > price ? (' <span style="color:#999;text-decoration:line-through;font-size:15px">$' + was + '</span>') : '')
      + (off ? (' <span style="color:#c0392b;font-weight:700;font-size:14px"> ' + off + '% off</span>') : '') + '</p>'
      + codeLine
      + '<p style="margin:16px 0"><a href="' + shareUrl + '" style="display:inline-block;background:#f5c842;color:#0a1f33;font-weight:800;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:15px">See the deal &rarr;</a></p>'
      + '<hr style="border:none;border-top:1px solid #eee;margin:20px 0 12px">'
      + '<p style="font-size:12px;color:#888;line-height:1.6;margin:0 0 8px">Done watching this one? This only stops alerts for this item. It does not unsubscribe you from anything else.</p>'
      + '<p style="margin:0 0 4px"><a href="' + stopUrl + '" style="display:inline-block;background:#eef1f4;color:#333;font-weight:700;font-size:13px;text-decoration:none;padding:9px 16px;border-radius:6px;border:1px solid #d7dde3">Stop alerts for this item</a></p>'
      + '<p style="font-size:11px;color:#aaa;margin:12px 0 0">founditcheaper earns from qualifying purchases. Prices and codes can change.</p>'
      + '</div>';
    try {
      await transporter.sendMail({ from: 'founditcheaper <' + FROM + '>', to: q.email, subject: subject, html: html });
      sent++;
      await fetch(`${sbUrl}/rest/v1/deal_requests?id=eq.${q.id}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ last_asin: d._asin || null, last_deal_id: d.id, last_alerted_at: new Date().toISOString() }),
      });
    } catch (e) { console.error('[match] send failed for', q.email, e.message); }
  }
  console.log('[match-deal-requests] sent ' + sent + ' alert(s)');
  return { statusCode: 200, body: JSON.stringify({ ok: true, matched: toSend.length, sent: sent }) };
};
