// Public "Deal Alert" intake (from deal-alert.html). A visitor tells us an item they
// want and we store it in `deal_requests`. A separate scheduled job
// (match-deal-requests) watches the deals feed and emails them when a matching deal
// lands. Two-level opt-out: each request gets an `alert_token` for a per-item "stop
// alerting me about this" link; the newsletter unsubscribe is separate (Beehiiv).
//
// POST { email, query, targetPrice? }
//   query = either a pasted Amazon/Walmart product link OR a typed item name/keywords.
//   We auto-detect a link and pull the ASIN; otherwise we store lowercased keywords.

const crypto = require('crypto');
const nodemailer = require('nodemailer');

const AFFILIATE_TAG = 'founditchea09-20';
const SMTP_HOST = 'mail.privateemail.com';
const SMTP_PORT = 465;                                     // SSL
const FROM = process.env.PRIVATE_EMAIL_USER || 'deals@founditcheaper.net';
const SITE = 'https://founditcheaper.net';

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

// Immediately confirm the alert is on and hand them the one-tap off switch. Best-effort:
// any failure is swallowed so it never blocks saving the request. The off link is the
// SAME per-item token the match emails use, so "turn it off from that email" works from
// the very first message. No affiliate/Amazon link here (email compliance).
async function sendConfirmation(to, label, stopUrl, targetPrice) {
  try {
    if (!process.env.PRIVATE_EMAIL_PASS) return false;
    if (!to || !to.includes('@')) return false;
    const priceLine = targetPrice
      ? '<p style="font-size:14px;color:#333;margin:0 0 12px">We will email you when it is at or under $' + Math.round(targetPrice) + '.</p>'
      : '<p style="font-size:14px;color:#333;margin:0 0 12px">We will email you when it drops to a good price.</p>';
    const html =
      '<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:520px">' +
        '<p style="font-size:15px;margin:0 0 6px">Your alert is on.</p>' +
        '<p style="font-size:15px;margin:0 0 4px">We are watching for <strong>' + esc(label) + '</strong> as deals come in.</p>' +
        priceLine +
        '<p style="font-size:13px;color:#555;margin:0 0 16px">You can turn this alert off at any time:</p>' +
        '<p style="margin:0 0 18px"><a href="' + stopUrl + '" style="background:#f5c842;color:#0a1a2f;text-decoration:none;font-weight:700;padding:10px 16px;border-radius:6px;display:inline-block">Turn off this alert</a></p>' +
        '<p style="font-size:12px;color:#999;margin:0">This only turns off this one item. It does not unsubscribe you from anything else. You are getting this because you set an alert at founditcheaper.net.</p>' +
      '</div>';
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST, port: SMTP_PORT, secure: true,
      auth: { user: FROM, pass: process.env.PRIVATE_EMAIL_PASS },
    });
    await transporter.sendMail({
      from: `founditcheaper <${FROM}>`, to,
      subject: 'Your alert is on: ' + label,
      html,
    });
    return true;
  } catch (e) {
    console.error('[save-deal-request] confirmation email failed:', e.message);
    return false;
  }
}

function extractAsin(url) {
  const s = String(url || '');
  const m = s.match(/(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/product\/|[?&]asin=)([A-Z0-9]{10})/i);
  if (m) return m[1].toUpperCase();
  const b = s.match(/\b(B0[A-Z0-9]{8})\b/i);
  return b ? b[1].toUpperCase() : null;
}
function isUrl(s) { return /^https?:\/\//i.test(String(s || '').trim()); }
function isWalmart(s) { return /walmart\.com/i.test(String(s || '')); }

// Typed item -> lowercased keyword tokens (drop tiny words + common filler so matching
// keys on the real product words).
const STOP = new Set(['the','a','an','for','and','with','of','to','in','on','my','me','it','is','are','this','that','need','want','looking','deal','deals','cheap','under','any','some','good','best','new']);
function toKeywords(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter(function (w) { return w.length >= 3 && !STOP.has(w); }).slice(0, 8);
}

// Read the product out of a screenshot with a quick vision model, returning a short
// search phrase (brand + item). Needs ANTHROPIC_API_KEY; returns null if it's unset or
// the model can't tell, so the caller can fall back to asking for typed keywords.
async function identifyFromImage(dataUrl) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const m = String(dataUrl || '').match(/^data:(image\/[a-z]+);base64,(.+)$/i);
  if (!m) return null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 40,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
          { type: 'text', text: 'This is a screenshot of a product someone wants a deal on. Reply with ONLY the product as a short search phrase (brand and item, 3 to 8 words), lowercase, no punctuation, no extra words. If you cannot tell, reply exactly: unknown' },
        ] }],
      }),
    });
    const d = await r.json().catch(function () { return null; });
    const t = d && d.content && d.content[0] && d.content[0].text;
    if (!t) return null;
    const phrase = String(t).trim().toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!phrase || phrase === 'unknown' || phrase.length < 3) return null;
    return phrase.slice(0, 120);
  } catch (e) { return null; }
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) }; }

  const email = String(body.email || '').trim().toLowerCase();
  const query = String(body.query || '').trim();
  const hasImage = typeof body.image === 'string' && /^data:image\//i.test(body.image);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Enter a valid email' }) };
  }
  if (query.length < 2 && !hasImage) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Tell us the item you want, or add a screenshot' }) };
  }
  if (query.length > 300) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'That is a bit long, shorten the item' }) };
  }

  let targetPrice = null;
  const tp = parseFloat(body.targetPrice);
  if (!isNaN(tp) && tp > 0 && tp < 100000) targetPrice = Math.round(tp * 100) / 100;

  let type = 'keyword', asin = null, store = 'any', keywords = [], queryText = query;

  // Screenshot path: read the product from the image (vision). Only used when they
  // didn't also type an item — typed text is the more reliable signal when present.
  if (hasImage && query.length < 2) {
    const phrase = await identifyFromImage(body.image);
    if (phrase) {
      type = 'screenshot'; queryText = phrase; keywords = toKeywords(phrase); store = 'Amazon';
    } else {
      return { statusCode: 422, body: JSON.stringify({ ok: false, error: "Could not read that screenshot. Type a couple words describing the item too, then resend" }) };
    }
  } else if (isUrl(query)) {
    if (isWalmart(query)) { type = 'link'; store = 'Walmart'; }
    else { asin = extractAsin(query); type = asin ? 'asin' : 'link'; store = 'Amazon'; }
  } else {
    keywords = toKeywords(query);
    if (!keywords.length) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Add a few more words describing the item' }) };
    }
  }

  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Config error' }) };
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  // Per-item off token (matches stop-deal-alert's [a-f0-9]{16,40}). Generated here so the
  // very first confirmation email carries a working "turn off this alert" link.
  const alertToken = crypto.randomBytes(16).toString('hex');

  const row = {
    email: email,
    type: type,
    query_text: String(queryText).slice(0, 300),
    asin: asin,
    keywords: keywords,
    store: store,
    target_price: targetPrice,
    alert_token: alertToken,
    active: true,
  };

  try {
    let r = await fetch(`${sbUrl}/rest/v1/deal_requests`, {
      method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(row),
    });
    if (!r.ok) {
      // alert_token column may be missing on an older DB — retry without it (the stop link
      // just won't work until the column exists) rather than lose the request.
      const noTok = { ...row }; delete noTok.alert_token;
      r = await fetch(`${sbUrl}/rest/v1/deal_requests`, {
        method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(noTok),
      });
    }
    if (!r.ok) {
      const d = await r.text();
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'Could not save your alert', detail: d.slice(0, 160) }) };
    }
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(e).slice(0, 160) }) };
  }

  // Confirm the alert + give them the off switch (best-effort; never blocks the save).
  const label = (type === 'asin' || type === 'link') ? 'the item you linked' : (queryText || 'your item');
  const stopUrl = SITE + '/stop-alert/' + alertToken;
  const confirmed = await sendConfirmation(email, label, stopUrl, targetPrice);

  return { statusCode: 200, body: JSON.stringify({ ok: true, confirmed: confirmed }) };
};
