// Admin login. Validates a username + password and returns the account's ROLE so
// the admin panel can show the right tabs:
//   owner (Erik)   → full access
//   va    (Kuldeep)→ Top Deal Picks + Imported Promo Code Deals only
//
// Passwords live ONLY in Netlify env vars (never in the committed code, which is a
// public repo): ADMIN_PASSWORD = owner, VA_PASSWORD = Kuldeep. Because the two
// passwords differ, the owner-only functions (settings, dice game, reset) reject
// the VA automatically — the role split is enforced server-side, not just in the UI.

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const pass = String(body.password || '');
  const user = String(body.username || '').trim().toLowerCase();
  const owner = process.env.ADMIN_PASSWORD;
  const va    = process.env.VA_PASSWORD;
  const agent = process.env.AGENT_PASSWORD;

  if (owner && pass === owner) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, role: 'owner', name: 'Erik' }) };
  }
  if (va && pass === va && user === 'kuldeep') {
    return { statusCode: 200, body: JSON.stringify({ ok: true, role: 'va', name: 'Kuldeep' }) };
  }
  // Promo-scraping agent — same restricted role as the VA (Picks + Promo only).
  if (agent && pass === agent && user === 'promo-agent') {
    return { statusCode: 200, body: JSON.stringify({ ok: true, role: 'va', name: 'Promo Agent' }) };
  }
  return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Invalid login' }) };
};
