// Flappy Banana prize claim. The winner's email has a "Confirm it is me" button
// pointing here with their one-time token. Clicking it:
//   1) marks the win as claimed (flappy_scores.claimed_at),
//   2) emails Erik that a REAL person confirmed — so he can safely send the reward,
//   3) shows the winner a friendly "confirmed" page (the reward is revealed here).
// GET /claim-flappy/<token>  (redirect) or /.netlify/functions/flappy-claim?t=<token>

const nodemailer = require('nodemailer');

const SMTP_HOST = 'mail.privateemail.com';
const SMTP_PORT = 465;                                     // SSL
const FROM = process.env.PRIVATE_EMAIL_USER || 'deals@founditcheaper.net';
const OWNER_TO = process.env.GAME_ALERT_TO || 'deals@founditcheaper.net';

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

function page(title, msg) {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">'
    + '<title>' + esc(title) + ' — founditcheaper</title><style>'
    + 'body{background:linear-gradient(180deg,#0a1f33,#0c2136);color:#fff;font-family:Inter,system-ui,-apple-system,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;margin:0;padding:24px}'
    + '.box{max-width:460px;text-align:center;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:34px 26px}'
    + 'h1{font-size:23px;margin:0 0 12px;color:#f5c842}p{color:rgba(255,255,255,0.82);line-height:1.6;font-size:14px;margin:0 0 8px}a{color:#f5c842;text-decoration:none}'
    + '</style></head><body><div class="box"><h1>' + esc(title) + '</h1><p>' + msg + '</p>'
    + '<p style="margin-top:18px"><a href="https://founditcheaper.net/">← Back to founditcheaper</a></p></div></body></html>';
}

exports.handler = async function (event) {
  const HTML = { 'Content-Type': 'text/html; charset=utf-8' };
  const p = event.queryStringParameters || {};
  // Token normally arrives as ?t= (via the /claim-flappy/* rewrite). Fall back to
  // reading it from the path in case the rewrite's :splat doesn't populate the query.
  let token = String(p.t || p.token || '').trim();
  if (!token) {
    const mm = String(event.path || event.rawUrl || '').match(/claim-flappy\/([A-Za-z0-9]+)/i);
    if (mm) token = mm[1].trim();
  }
  if (!/^[a-f0-9]{16,40}$/i.test(token)) {
    return { statusCode: 400, headers: HTML, body: page('Invalid link', 'That claim link looks broken. If you won and want your reward, just reply to the email we sent you.') };
  }

  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, headers: HTML, body: page('Something went wrong', 'Try again in a bit.') };
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  try {
    const gr = await fetch(`${sbUrl}/rest/v1/flappy_scores?claim_token=eq.${encodeURIComponent(token)}&select=id,username,player_tag,email,best_score,period_start,claimed_at`, { headers: H });
    const rows = await gr.json().catch(function () { return []; });
    const win = Array.isArray(rows) && rows[0];
    if (!win) return { statusCode: 200, headers: HTML, body: page('Link not found', 'We could not find that claim. If you won and want your reward, reply to the email we sent you.') };

    const already = !!win.claimed_at;

    let prize = '';
    try {
      const sr = await fetch(`${sbUrl}/rest/v1/settings?key=eq.flappy_prize&select=value`, { headers: H });
      const srows = await sr.json().catch(function () { return []; });
      if (Array.isArray(srows) && srows[0]) prize = srows[0].value || '';
    } catch (e) { /* prize is optional */ }

    if (!already) {
      await fetch(`${sbUrl}/rest/v1/flappy_scores?id=eq.${encodeURIComponent(win.id)}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ claimed_at: new Date().toISOString() }),
      }).catch(function () {});

      if (process.env.PRIVATE_EMAIL_PASS) {
        try {
          const range = win.period_start || '';
          const html =
            '<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:520px">' +
              '<h2 style="margin:0 0 10px">Banana game winner confirmed</h2>' +
              '<p style="font-size:15px;margin:0 0 6px">A real person clicked to confirm their win. You can send the reward.</p>' +
              '<p style="font-size:15px;margin:0 0 4px"><strong>' + esc(win.username || 'Winner') + '</strong> <span style="color:#888">#' + esc(win.player_tag || '?') + '</span> — ' + (win.best_score != null ? esc(win.best_score) + ' pts' : '') + '</p>' +
              '<p style="font-size:15px;margin:0 0 4px">Send the reward to: <strong>' + esc(win.email || '(no email on file)') + '</strong></p>' +
              (prize ? '<p style="font-size:14px;color:#333;margin:0 0 4px">Prize: ' + esc(prize) + '</p>' : '') +
              (range ? '<p style="font-size:12px;color:#888;margin:8px 0 0">Competition: ' + esc(range) + '</p>' : '') +
              '<p style="font-size:12px;color:#888;margin:8px 0 0">They confirmed by clicking the button in their winner email, so someone real is on the other end.</p>' +
            '</div>';
          const transporter = nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: true, auth: { user: FROM, pass: process.env.PRIVATE_EMAIL_PASS } });
          await transporter.sendMail({
            from: `founditcheaper <${FROM}>`, to: OWNER_TO,
            subject: 'Banana game winner confirmed — send the reward' + (win.username ? ' (' + win.username + ')' : ''),
            html,
          });
        } catch (e) { console.error('[flappy-claim] owner email failed:', e.message); }
      }
    }

    const prizeLine = prize ? (' your <strong>' + esc(prize) + '</strong>') : ' your reward';
    const msg = already
      ? 'You already confirmed this one. We have your details and will send' + prizeLine + ' to ' + esc(win.email || 'your email') + '. Nothing else to do.'
      : 'Confirmed. We will send' + prizeLine + ' to <strong>' + esc(win.email || 'your email') + '</strong>. Give it a little time. A real human sends these out.';
    return { statusCode: 200, headers: HTML, body: page('You are confirmed', msg) };
  } catch (e) {
    return { statusCode: 500, headers: HTML, body: page('Something went wrong', 'Try again in a bit, or reply to the email we sent you.') };
  }
};
