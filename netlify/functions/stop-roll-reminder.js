// One-click opt-out from dice-game roll reminders. GET ?token=<token> sets active=false
// for that player. Returns a small on-brand confirmation page. Does NOT touch the
// newsletter or anything else, just the hourly roll reminders.

exports.handler = async function (event) {
  const token = String((event.queryStringParameters && event.queryStringParameters.token) || '').trim();
  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  function page(title) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Roll reminders</title>
<body style="background:#0a1f33;color:#fff;font-family:Arial,Helvetica,sans-serif;text-align:center;padding:64px 20px;margin:0">
  <div style="max-width:420px;margin:0 auto">
    <h2 style="color:#f5c842;margin:0 0 10px">${title}</h2>
    <p style="color:rgba(255,255,255,0.72);line-height:1.6">You are still in the game and still on every other email. Nothing else changed.</p>
    <p style="margin-top:18px"><a href="/founditcheaper-game.html" style="color:#f5c842;font-weight:bold">Back to the game</a></p>
  </div>
</body>`,
    };
  }

  if (!token || !sbUrl || !sbKey) return page('Roll reminders are off');

  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };
  try {
    await fetch(`${sbUrl}/rest/v1/roll_reminders?token=eq.${encodeURIComponent(token)}`, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ active: false }),
    });
  } catch (e) { /* still show the friendly page */ }

  return page('Roll reminders turned off');
};
