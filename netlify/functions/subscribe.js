// Adds a subscriber to the Beehiiv newsletter.
// POST { email, source } — source is just a label (e.g. "grid", "menu") for tracking.
// Requires Netlify env vars: BEEHIIV_API_KEY, BEEHIIV_PUBLICATION_ID
//
// (Previously wrote to a Supabase email_subscribers table; Beehiiv is now the
// source of truth for the email list.)

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let email, source;
  try {
    ({ email, source } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  email = (email || '').toLowerCase().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Valid email required' }) };
  }

  const apiKey = process.env.BEEHIIV_API_KEY;
  const pubId  = process.env.BEEHIIV_PUBLICATION_ID;
  if (!apiKey || !pubId) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Newsletter not configured (missing Beehiiv keys)' }) };
  }

  try {
    const res = await fetch(`https://api.beehiiv.com/v2/publications/${pubId}/subscriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        reactivate_existing: true,     // re-subscribe someone who previously unsubscribed
        send_welcome_email: true,
        utm_source: 'founditcheaper',
        utm_medium: 'website',
        referring_site: source ? ('founditcheaper.net/' + source) : 'founditcheaper.net',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { statusCode: 200, body: JSON.stringify({ ok: true }) };

    const msg = (data && (data.message || (data.errors && JSON.stringify(data.errors)))) || ('Beehiiv HTTP ' + res.status);
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: msg }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(e) }) };
  }
};
