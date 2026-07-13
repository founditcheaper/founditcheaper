// Let trusted agents email Erik an alert, reusing the site's existing Private Email
// mailbox. No new API, no new credentials: the SMTP password stays in Netlify and
// never leaves the server, and agents authenticate with the AGENT_PASSWORD they
// already have.
//
// SAFETY: the recipient is NOT caller-controlled. It is always Erik's alert address.
// An agent can notify Erik; it cannot use this to email anyone else.
//
// POST { password, subject, body, source? }
//   subject : short line, e.g. "3 new freebies found"
//   body    : plain text. Newlines become line breaks. HTML is escaped, not rendered.
//   source  : optional agent name, e.g. "freebie guy tracker" -> subject is tagged
//             "[freebie guy tracker] 3 new freebies found" so you can filter in Gmail.

const nodemailer = require('nodemailer');

const SMTP_HOST = 'mail.privateemail.com';
const SMTP_PORT = 465;                                     // SSL
const FROM = process.env.PRIVATE_EMAIL_USER || 'deals@founditcheaper.net';
const TO   = process.env.GAME_ALERT_TO || 'deals@founditcheaper.net';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const pass = String(body.password || '');
  const owner = process.env.ADMIN_PASSWORD;
  const agent = process.env.AGENT_PASSWORD;
  if (!((owner && pass === owner) || (agent && pass === agent))) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  if (!process.env.PRIVATE_EMAIL_PASS) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Mailbox not configured' }) };
  }

  const subject = String(body.subject || '').trim().slice(0, 160);
  const text = String(body.body || '').trim().slice(0, 20000);
  const source = String(body.source || '').trim().slice(0, 40);
  if (!subject || !text) return { statusCode: 400, body: JSON.stringify({ error: 'Missing subject or body' }) };

  const subjectLine = source ? `[${source}] ${subject}` : subject;
  const html =
    '<div style="font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;color:#0f1b2d;line-height:1.55">'
    + '<p style="margin:0 0 14px">' + esc(text).replace(/\n/g, '<br>') + '</p>'
    + '<hr style="border:0;border-top:1px solid #e6e9ef;margin:20px 0">'
    + '<p style="margin:0;font-size:12px;color:#5b6b80">sent by ' + esc(source || 'an agent') + ' via founditcheaper.net</p>'
    + '</div>';

  try {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST, port: SMTP_PORT, secure: true,
      auth: { user: FROM, pass: process.env.PRIVATE_EMAIL_PASS },
    });
    await transporter.sendMail({
      from: `founditcheaper <${FROM}>`,
      to: TO,                       // hardcoded on purpose - see SAFETY note above
      subject: subjectLine,
      text: text,
      html: html,
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true, sent: subjectLine }) };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: 'send failed', detail: String(e).slice(0, 160) }) };
  }
};
