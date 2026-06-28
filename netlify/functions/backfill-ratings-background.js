// Background function — 15-minute runtime limit, returns 202 immediately.
// Fetches Rainforest rating+reviews for every deal row where rating=0
// and writes them back to Supabase so star filters and card display work.
// Invoke: POST /.netlify/functions/backfill-ratings-background {"password":"<ADMIN_PASSWORD>"}

const BATCH_SIZE = 10;

exports.handler = async function(event) {
  let password;
  try { ({ password } = JSON.parse(event.body || '{}')); } catch {}
  if (password !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const apiKey = process.env.RAINFOREST_API_KEY;
  const sbUrl  = process.env.SUPABASE_URL;
  const sbKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!apiKey || !sbUrl || !sbKey) {
    return { statusCode: 500, body: 'Missing env vars' };
  }

  // Fetch all rows where rating = 0
  const listRes = await fetch(
    `${sbUrl}/rest/v1/deals?select=id,url&rating=eq.0&limit=5000`,
    { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, Range: '0-4999', 'Range-Unit': 'items' } }
  );
  const rows = await listRes.json();

  // Keep only rows with an extractable Amazon ASIN
  const toFill = (Array.isArray(rows) ? rows : []).filter(r =>
    r.url && /\/dp\/([A-Z0-9]{10})/i.test(r.url)
  );

  console.log(`[backfill-ratings] ${(rows || []).length} rows with rating=0, ${toFill.length} have Amazon ASINs`);

  let filled = 0, skipped = 0;

  for (let b = 0; b < toFill.length; b += BATCH_SIZE) {
    const batch = toFill.slice(b, b + BATCH_SIZE);

    await Promise.all(batch.map(async row => {
      const asin = (row.url.match(/\/dp\/([A-Z0-9]{10})/i) || [])[1];
      if (!asin) { skipped++; return; }

      try {
        const rfRes  = await fetch(
          `https://api.rainforestapi.com/request?api_key=${apiKey}&type=product&asin=${asin}&amazon_domain=amazon.com`
        );
        const rfData = await rfRes.json();
        const p      = rfData.product;
        if (!p) { skipped++; return; }

        const rating  = p.rating        ?? 0;
        const reviews = p.ratings_total ?? 0;
        if (!rating) { skipped++; return; }

        await fetch(`${sbUrl}/rest/v1/deals?id=eq.${row.id}`, {
          method:  'PATCH',
          headers: {
            apikey:         sbKey,
            Authorization:  `Bearer ${sbKey}`,
            'Content-Type': 'application/json',
            Prefer:         'return=minimal',
          },
          body: JSON.stringify({ rating, reviews }),
        });
        filled++;
      } catch (e) {
        console.error(`[backfill-ratings] ASIN ${asin} error:`, e.message);
        skipped++;
      }
    }));

    console.log(`[backfill-ratings] Batch ${Math.ceil((b + 1) / BATCH_SIZE)}/${Math.ceil(toFill.length / BATCH_SIZE)} — filled: ${filled}, skipped: ${skipped}`);

    if (b + BATCH_SIZE < toFill.length) await new Promise(r => setTimeout(r, 500));
  }

  console.log(`[backfill-ratings] Complete — ${filled} updated, ${skipped} skipped/failed`);
  return { statusCode: 200, body: JSON.stringify({ ok: true, filled, skipped }) };
};
