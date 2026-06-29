// TEMPORARY diagnostic — verifies the Impact (Walmart affiliate) API credentials
// and discovers the Walmart Program/Campaign/Catalog IDs we need to build the
// real Walmart integration. Read-only. No secrets are returned. Safe to delete.

const BASE = 'https://api.impact.com';

function authHeader(sid, token) {
  return 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
}

async function getJson(path, sid, token) {
  try {
    const res  = await fetch(`${BASE}${path}`, {
      headers: { Authorization: authHeader(sid, token), Accept: 'application/json' },
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, raw: text.slice(0, 400) };
  } catch (e) {
    return { status: 0, json: null, raw: String(e).slice(0, 200) };
  }
}

exports.handler = async function () {
  const sid   = process.env.IMPACT_ACCOUNT_SID;
  const token = process.env.IMPACT_AUTH_TOKEN;
  const out = { hasSid: !!sid, hasToken: !!token };
  if (!sid || !token) { out.verdict = 'Missing IMPACT_ACCOUNT_SID / IMPACT_AUTH_TOKEN env vars'; return resp(out); }

  // 1. Campaigns — the advertiser programs this partner is approved for (incl. Walmart)
  const camp = await getJson(`/Mediapartners/${sid}/Campaigns?PageSize=100`, sid, token);
  out.campaignsHttpStatus = camp.status;
  const campaignArr = camp.json && (camp.json.Campaigns || camp.json.campaigns);
  if (Array.isArray(campaignArr)) {
    out.campaigns = campaignArr.map(c => ({
      campaignId:     c.CampaignId || c.CampaignID,
      campaignName:   c.CampaignName,
      advertiserId:   c.AdvertiserId || c.AdvertiserID,
      advertiserName: c.AdvertiserName,
    }));
    out.walmartCampaigns = out.campaigns.filter(c =>
      /walmart/i.test(`${c.campaignName || ''} ${c.advertiserName || ''}`));
  } else {
    out.campaignsRaw = camp.raw;
  }

  // 2. Catalogs — product feeds (find the Walmart catalog id)
  const cat = await getJson(`/Mediapartners/${sid}/Catalogs?PageSize=100`, sid, token);
  out.catalogsHttpStatus = cat.status;
  const catArr = cat.json && (cat.json.Catalogs || cat.json.catalogs);
  if (Array.isArray(catArr)) {
    out.catalogs = catArr.map(c => ({
      id:           c.Id || c.CatalogId,
      name:         c.Name,
      advertiserId: c.AdvertiserId,
      numItems:     c.NumberOfItems || c.ItemCount,
    }));
  } else {
    out.catalogsRaw = cat.raw;
  }

  out.authOk = camp.status === 200;

  // 3. Probe the actual data endpoints for the Walmart campaign to see what's available.
  const walmart = (out.walmartCampaigns || [])[0];
  if (walmart && walmart.campaignId) {
    const cid = walmart.campaignId;
    out.walmartCampaignId = cid;

    const deals  = await getJson(`/Mediapartners/${sid}/Campaigns/${cid}/Deals?PageSize=20`, sid, token);
    out.walmartDeals = summarize(deals);

    const promos = await getJson(`/Mediapartners/${sid}/Promotions?CampaignId=${cid}&PageSize=20`, sid, token);
    out.walmartPromotions = summarize(promos);

    const codes  = await getJson(`/Mediapartners/${sid}/PromoCodes?CampaignId=${cid}&PageSize=20`, sid, token);
    out.walmartPromoCodes = summarize(codes);
  }

  // 4. Marketplace products — full first item (to see price fields), plus a Walmart-filtered try
  const prods = await getJson(`/Mediapartners/${sid}/Marketplace/Products?PageSize=5`, sid, token);
  out.marketplaceProducts = summarize(prods, 2500);
  // Try to narrow the marketplace to Walmart via campaign and advertiser filters
  const prodsCid = await getJson(`/Mediapartners/${sid}/Marketplace/Products?CampaignId=16662&PageSize=5`, sid, token);
  out.marketplaceWalmartByCampaign = summarize(prodsCid, 1200);
  const prodsAdv = await getJson(`/Mediapartners/${sid}/Marketplace/Products?AdvertiserId=3530262&PageSize=5`, sid, token);
  out.marketplaceWalmartByAdvertiser = summarize(prodsAdv, 1200);

  out.verdict = out.authOk
    ? 'AUTH OK — see walmartDeals / walmartPromotions / marketplaceProducts for what Walmart data is available.'
    : `AUTH issue on campaigns (${camp.status})`;
  return resp(out);
};

// Summarize a list response without assuming exact field names: find the first
// array in the JSON, report its length and a truncated first item.
function summarize(r, chars) {
  const cap = chars || 800;
  if (r.status !== 200) return { status: r.status, raw: r.raw };
  if (!r.json) return { status: r.status, note: 'non-JSON', raw: r.raw };
  let arr = null, key = null;
  for (const k of Object.keys(r.json)) {
    if (Array.isArray(r.json[k])) { arr = r.json[k]; key = k; break; }
  }
  if (!arr) return { status: r.status, keys: Object.keys(r.json), sample: JSON.stringify(r.json).slice(0, 500) };
  return { status: r.status, arrayKey: key, count: arr.length, firstItem: JSON.stringify(arr[0] || null).slice(0, cap) };
}

function resp(o) {
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o, null, 2) };
}
