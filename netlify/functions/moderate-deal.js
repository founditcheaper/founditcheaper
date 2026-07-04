// Admin moderation of a single deal BY ITS ROW ID (not by ASIN).
//
// The older manage-code 'approve'/'remove' actions key off the ASIN parsed from the
// deal URL. Seller-submitted promo-code links (and some agent imports) have NO ASIN in
// the URL, so those deals had no working Approve button and no checkbox — they sat
// Pending forever. This function acts on the deal's unique `id`, which every row has,
// so ANY pending/flagged deal can be approved or deleted.
//
// On APPROVE, if the deal was seller-submitted and we have the submitter's email, we
// send them a short "your deal is live" note over the site's Private Email mailbox.
// The link in that email is the compliant on-site share link (founditcheaper.net/?deal=<id>),
// never a raw Amazon/affiliate link (Amazon bans affiliate links in email).
//
// POST { password, id, action:'approve'|'delete' }

const nodemailer = require('nodemailer');

const SMTP_HOST = 'mail.privateemail.com';
const SMTP_PORT = 465;                                     // SSL
const FROM = process.env.PRIVATE_EMAIL_USER || 'deals@founditcheaper.net';
const SITE = 'https://founditcheaper.net';
const SELLER_TAG = 'Seller Submission';

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

// Notify a seller their submitted deal passed review and is live. Best-effort:
// any failure is swallowed so it never blocks the approval itself.
async function emailSeller(deal) {
  try {
    if (!process.env.PRIVATE_EMAIL_PASS) return { sent: false, reason: 'no mailbox password' };
    const to = String(deal.submitter_email || '').trim();
    if (!to || !to.includes('@')) return { sent: false, reason: 'no email on file' };

    const name = deal.name || 'your deal';
    const link = SITE + '/?deal=' + deal.id;
    const priceLine = (deal.price != null) ? ('$' + deal.price + (deal.code ? ' with code ' + esc(deal.code) : '')) : '';

    const html =
      '<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:520px">' +
        '<p style="font-size:15px;margin:0 0 12px">Your deal passed review and is live on founditcheaper.</p>' +
        '<p style="font-size:15px;margin:0 0 4px;font-weight:700">' + esc(name) + '</p>' +
        (priceLine ? '<p style="font-size:14px;color:#333;margin:0 0 12px">' + priceLine + '</p>' : '') +
        '<p style="margin:0 0 16px"><a href="' + link + '" style="background:#f5c842;color:#0a1a2f;text-decoration:none;font-weight:700;padding:10px 16px;border-radius:6px;display:inline-block">See it on the site</a></p>' +
        '<p style="font-size:13px;color:#555;margin:0 0 4px">Send us more when you have them. Same place you submitted this one.</p>' +
        '<p style="font-size:12px;color:#999;margin:14px 0 0">You are getting this because you submitted this deal at founditcheaper.net.</p>' +
      '</div>';

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST, port: SMTP_PORT, secure: true,
      auth: { user: FROM, pass: process.env.PRIVATE_EMAIL_PASS },
    });
    await transporter.sendMail({
      from: `founditcheaper <${FROM}>`, to,
      subject: 'Your deal is live on founditcheaper',
      html,
    });
    return { sent: true };
  } catch (e) {
    console.error('[moderate-deal] seller email failed:', e.message);
    return { sent: false, reason: String(e.message).slice(0, 160) };
  }
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { password, id, action } = body;

  // Owner (Erik), the VA (Kuldeep), or the promo agent may moderate deals.
  const role = (process.env.ADMIN_PASSWORD && password === process.env.ADMIN_PASSWORD) ? 'owner'
             : ((process.env.VA_PASSWORD && password === process.env.VA_PASSWORD) ||
                (process.env.AGENT_PASSWORD && password === process.env.AGENT_PASSWORD)) ? 'va'
             : null;
  if (!role) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };

  // id is a Supabase uuid.
  if (!/^[0-9a-f-]{16,40}$/i.test(String(id || ''))) return { statusCode: 400, body: JSON.stringify({ error: 'Invalid id' }) };

  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, body: JSON.stringify({ error: 'Config error' }) };
  const sb = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };
  const idQ = `${sbUrl}/rest/v1/deals?id=eq.${encodeURIComponent(id)}`;

  try {
    if (action === 'approve') {
      // Flip to live and clear any flag; return the row so we can notify the seller.
      const r = await fetch(idQ, {
        method: 'PATCH',
        headers: { ...sb, Prefer: 'return=representation' },
        body: JSON.stringify({ review_status: 'live', flag_reason: null }),
      });
      if (!r.ok) return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'update failed' }) };
      const rows = await r.json().catch(() => []);
      const deal = Array.isArray(rows) ? rows[0] : null;
      if (!deal) return { statusCode: 404, body: JSON.stringify({ ok: false, error: 'not found' }) };

      let email = { sent: false, reason: 'not a seller deal' };
      if (deal.uploaded_by === SELLER_TAG) email = await emailSeller(deal);

      return { statusCode: 200, body: JSON.stringify({ ok: true, action: 'approve', id, emailed: email.sent, emailReason: email.reason || null }) };
    }

    if (action === 'delete') {
      const r = await fetch(idQ, { method: 'DELETE', headers: { ...sb, Prefer: 'return=minimal' } });
      return { statusCode: r.ok ? 200 : 502, body: JSON.stringify({ ok: r.ok, action: 'delete', id }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'moderate-deal failed', detail: String(e).slice(0, 200) }) };
  }
};
