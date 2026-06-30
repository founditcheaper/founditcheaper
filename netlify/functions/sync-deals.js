// Scheduled kickoff (see netlify.toml). Amazon discovery now needs more than the
// 26s a normal function gets, so the heavy work lives in `sync-deals-background`
// (a Netlify background function, up to 15 min). This just fires it and returns —
// the background job runs the full keyword sweep on its own.

exports.handler = async function () {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://founditcheaper.netlify.app';
  try {
    // Background functions return 202 immediately; this resolves fast.
    await fetch(`${base}/.netlify/functions/sync-deals-background`, { method: 'POST' });
    console.log('[sync-deals] kicked off background Amazon discovery');
  } catch (e) {
    console.error('[sync-deals] kickoff failed:', e.message);
  }
  return { statusCode: 200, body: JSON.stringify({ ok: true, kickedOff: true }) };
};
