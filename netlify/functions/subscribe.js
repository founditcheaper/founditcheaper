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

  // Publication ID isn't secret (it just identifies the publication); default it
  // so only the API key needs to be set in Netlify env.
  const apiKey = process.env.BEEHIIV_API_KEY;
  const pubId  = process.env.BEEHIIV_PUBLICATION_ID || 'pub_856c3204-96c1-430f-93d6-01d6dda858fc';
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Newsletter not configured (missing BEEHIIV_API_KEY)' }) };
  }

  // Map the on-site signup source into a clean, Beehiiv-filterable campaign tag, so
  // you can segment/target subscribers by where they came in (dice game vs the
  // newsletter menu vs a deal card, etc.). utm_campaign is a first-class filter in
  // Beehiiv, so these show up as ready-made segments. Unknown sources pass through
  // as-is; no source at all -> 'site'.
  const SOURCE_CAMPAIGN = { game: 'dice-game', menu: 'newsletter-menu', grid: 'deal-grid' };
  const srcKey = String(source || '').toLowerCase().trim();
  const campaign = SOURCE_CAMPAIGN[srcKey] || (srcKey || 'site');

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
        utm_campaign: campaign,        // <- where they signed up (dice-game, newsletter-menu, deal-grid, …)
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
