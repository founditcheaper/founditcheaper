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

  out.verdict = (camp.status === 200)
    ? 'AUTH OK — Impact credentials work. See campaigns/catalogs for Walmart IDs.'
    : (camp.status === 401 || camp.status === 403)
      ? `AUTH FAILED (${camp.status}) — check IMPACT_ACCOUNT_SID / IMPACT_AUTH_TOKEN`
      : `Unexpected status ${camp.status} — see *Raw fields`;
  return resp(out);
};

function resp(o) {
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o, null, 2) };
}
