// Background function — 15-minute runtime limit, returns 202 immediately.
// Fetches Rainforest product images for every deal row where images is null/empty
// and writes them back to Supabase so drawer thumbnails load instantly.
// Invoke: POST /.netlify/functions/backfill-images-background {"password":"<ADMIN_PASSWORD>"}

const BATCH_SIZE = 15; // parallel Rainforest calls per batch

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

  // Fetch all deal rows (both picks and grid)
  const listRes = await fetch(
    `${sbUrl}/rest/v1/deals?select=id,url,images&limit=5000`,
    { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, Range: '0-4999', 'Range-Unit': 'items' } }
  );
  const rows = await listRes.json();

  // Filter to only rows that are missing usable images
  const toFill = (Array.isArray(rows) ? rows : []).filter(r => {
    if (!r.url || !/\/dp\/([A-Z0-9]{10})/i.test(r.url)) return false;
    try {
      const imgs = JSON.parse(r.images || '[]');
      return !Array.isArray(imgs) || imgs.length < 2;
    } catch { return true; }
  });

  console.log(`[backfill] ${(rows || []).length} total rows, ${toFill.length} need images`);

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
        const images = (rfData.product?.images || []).map(img => img.link).filter(Boolean);

        if (images.length < 2) { skipped++; return; }

        await fetch(`${sbUrl}/rest/v1/deals?id=eq.${row.id}`, {
          method:  'PATCH',
          headers: {
            apikey:         sbKey,
            Authorization:  `Bearer ${sbKey}`,
            'Content-Type': 'application/json',
            Prefer:         'return=minimal',
          },
          body: JSON.stringify({ images: JSON.stringify(images) }),
        });
        filled++;
      } catch (e) {
        console.error(`[backfill] ASIN ${asin} error:`, e.message);
        skipped++;
      }
    }));

    console.log(`[backfill] Batch ${Math.ceil((b + 1) / BATCH_SIZE)}/${Math.ceil(toFill.length / BATCH_SIZE)} done — filled: ${filled}, skipped: ${skipped}`);

    // Brief pause between batches to avoid hammering Rainforest
    if (b + BATCH_SIZE < toFill.length) await new Promise(r => setTimeout(r, 400));
  }

  console.log(`[backfill] Complete — ${filled} images stored, ${skipped} skipped/failed`);
  return { statusCode: 200, body: JSON.stringify({ ok: true, filled, skipped }) };
};
