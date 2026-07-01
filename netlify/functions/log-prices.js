// Scheduled kickoff — fires the long-running price logger in the background
// (background functions get up to 15 min vs. the 26s scheduled limit).
exports.handler = async function () {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://founditcheaper.netlify.app';
  try {
    await fetch(`${base}/.netlify/functions/log-prices-background`, { method: 'POST' });
  } catch (e) { /* fire and forget */ }
  return { statusCode: 202, body: 'log-prices kicked off' };
};
