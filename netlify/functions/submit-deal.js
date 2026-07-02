// Public "Submit Your Deals" intake (seller-facing form on submit-deal.html).
//
// PHASE 1 — capture only: stores each raw submission (email + pasted deal text +
// optional file text) in the `deal_submissions` table via the service-role key, so
// nothing is ever lost. Nothing is published to the site from here. The parser that
// turns these into `pending` promo deals (feeding the existing admin review tab) is a
// separate, tested step.
//
// POST { email, deals, fileName?, fileText? }

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) }; }

  const email    = String(body.email || '').trim().toLowerCase().slice(0, 200);
  const deals    = String(body.deals || '').trim().slice(0, 20000);   // cap the paste box
  const fileName = String(body.fileName || '').slice(0, 200);
  const fileText = String(body.fileText || '').slice(0, 200000);      // cap an attached file

  if (!email.includes('@')) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Please enter a valid email.' }) };
  if (!deals && !fileText)  return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Please paste at least one deal or attach a file.' }) };

  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Config error' }) };

  try {
    const r = await fetch(`${sbUrl}/rest/v1/deal_submissions`, {
      method: 'POST',
      headers: {
        apikey: sbKey, Authorization: `Bearer ${sbKey}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal',
      },
      body: JSON.stringify({ email, deals_text: deals, file_name: fileName || null, file_text: fileText || null }),
    });
    if (!r.ok) {
      const detail = await r.text();
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'Could not save — try again.', detail: detail.slice(0, 160) }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'submit-deal failed', detail: String(e).slice(0, 160) }) };
  }
};
