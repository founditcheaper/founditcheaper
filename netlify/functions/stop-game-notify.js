// One-tap opt-out for dice-game "notify me when it's live" alerts. The alert email's
// "Turn off game alerts" link points here with the subscriber's token. Sets
// game_notify.active = false and shows a plain confirmation page.
// GET /stop-game-notify/<token>  (redirect) or /.netlify/functions/stop-game-notify?t=<token>

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
  // Token normally arrives as ?t= (via the /stop-game-notify/* rewrite). Fall back to
  // reading it from the path in case the rewrite's :splat doesn't populate the query.
  let token = String(p.t || p.token || '').trim();
  if (!token) {
    const mm = String(event.path || event.rawUrl || '').match(/stop-game-notify\/([A-Za-z0-9]+)/i);
    if (mm) token = mm[1].trim();
  }
  if (!/^[a-f0-9]{16,40}$/i.test(token)) {
    return { statusCode: 400, headers: HTML, body: page('Invalid link', 'That opt-out link looks broken. Reply to the email and we will take you off the list.') };
  }

  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, headers: HTML, body: page('Something went wrong', 'Try again in a bit.') };
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  try {
    const r = await fetch(`${sbUrl}/rest/v1/game_notify?token=eq.${encodeURIComponent(token)}`, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=representation' },
      body: JSON.stringify({ active: false }),
    });
    const rows = await r.json().catch(function () { return []; });
    if (!Array.isArray(rows) || !rows.length) {
      return { statusCode: 200, headers: HTML, body: page('Link not found', 'We could not find that alert. You may already be off the list.') };
    }
    return { statusCode: 200, headers: HTML, body: page('Alerts off', 'Done. We will not email you about new dice games. You can sign up again anytime from the game.') };
  } catch (e) {
    return { statusCode: 500, headers: HTML, body: page('Something went wrong', 'Try again in a bit, or reply to the email we sent you.') };
  }
};
