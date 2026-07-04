// Per-item "stop alerting me about this item" — the tokenized link in every deal-alert
// email. Flips that ONE deal_request to inactive. Does NOT touch the newsletter (Beehiiv
// handles the whole-list unsubscribe separately).
// GET /stop-alert/<token>  (redirect) or /.netlify/functions/stop-deal-alert?t=<token>

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

function page(title, msg) {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">'
    + '<title>' + esc(title) + ' — founditcheaper</title><style>'
    + 'body{background:linear-gradient(180deg,#0a1f33,#0c2136);color:#fff;font-family:Inter,system-ui,-apple-system,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;margin:0;padding:24px}'
    + '.box{max-width:440px;text-align:center;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:34px 26px}'
    + 'h1{font-size:22px;margin:0 0 12px;color:#f5c842}p{color:rgba(255,255,255,0.82);line-height:1.6;font-size:14px;margin:0 0 8px}a{color:#f5c842;text-decoration:none}'
    + '</style></head><body><div class="box"><h1>' + esc(title) + '</h1><p>' + msg + '</p>'
    + '<p style="margin-top:18px"><a href="https://founditcheaper.net/">← Back to deals</a></p></div></body></html>';
}

exports.handler = async function (event) {
  const HTML = { 'Content-Type': 'text/html; charset=utf-8' };
  const p = event.queryStringParameters || {};
  const token = String(p.t || p.token || '').trim();
  if (!/^[a-f0-9]{16,40}$/i.test(token)) {
    return { statusCode: 400, headers: HTML, body: page('Invalid link', 'That alert link looks broken. If you meant to stop an alert, just reply to the email and we will sort it out.') };
  }

  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, headers: HTML, body: page('Something went wrong', 'Try again in a bit.') };
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  try {
    const r = await fetch(`${sbUrl}/rest/v1/deal_requests?alert_token=eq.${encodeURIComponent(token)}`, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify({ active: false }),
    });
    const rows = await r.json().catch(function () { return []; });
    if (!r.ok) return { statusCode: 502, headers: HTML, body: page('Something went wrong', 'Could not update that alert — try again.') };
    if (!Array.isArray(rows) || !rows.length) {
      return { statusCode: 200, headers: HTML, body: page('Already off', 'That alert is already stopped (or the link expired). You are still on the list — nothing else changed.') };
    }
    const item = esc(rows[0].query_text || 'that item');
    return { statusCode: 200, headers: HTML, body: page('Alert stopped', 'You will no longer get alerts for <strong>' + item + '</strong>. You are still subscribed to founditcheaper — this only turned off this one item.') };
  } catch (e) {
    return { statusCode: 500, headers: HTML, body: page('Something went wrong', 'Try again in a bit.') };
  }
};
