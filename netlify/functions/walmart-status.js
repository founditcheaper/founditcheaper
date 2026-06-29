// TEMPORARY diagnostic — verifies the Walmart Affiliate Marketing API works with
// our RSA-signed requests, and probes the Rollback/Clearance deal feeds. Read-only.
// No secrets returned. Safe to delete once the real Walmart integration is built.
const crypto = require('crypto');

const BASE = 'https://developer.api.walmart.com/api-proxy/service/affil/product/v2';

function getPrivateKeyPem() {
  // WALMART_PRIVATE_KEY is stored base64-encoded (a PKCS#8 PEM). Decode it back.
  return Buffer.from(process.env.WALMART_PRIVATE_KEY || '', 'base64').toString('utf8');
}

function sign(consumerId, keyVersion, timestamp, privateKeyPem) {
  const data   = `${consumerId}\n${timestamp}\n${keyVersion}\n`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(data);
  signer.end();
  return signer.sign(privateKeyPem, 'base64');
}

async function wmGet(path) {
  const consumerId = process.env.WALMART_CONSUMER_ID;
  const keyVersion = process.env.WALMART_KEY_VERSION || '1';
  const pem        = getPrivateKeyPem();
  const timestamp  = Date.now().toString();
  const signature  = sign(consumerId, keyVersion, timestamp, pem);
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: {
        'WM_CONSUMER.ID':          consumerId,
        'WM_CONSUMER.INTIMESTAMP': timestamp,
        'WM_SEC.KEY_VERSION':      keyVersion,
        'WM_SEC.AUTH_SIGNATURE':   signature,
        'Accept':                  'application/json',
      },
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, raw: text.slice(0, 500) };
  } catch (e) {
    return { status: 0, json: null, raw: String(e).slice(0, 200) };
  }
}

function summarize(r, cap) {
  if (r.status !== 200) return { status: r.status, raw: r.raw };
  if (!r.json) return { status: r.status, note: 'non-JSON', raw: r.raw };
  let arr = null, key = null;
  for (const k of Object.keys(r.json)) {
    if (Array.isArray(r.json[k])) { arr = r.json[k]; key = k; break; }
  }
  if (!arr) return { status: r.status, keys: Object.keys(r.json) };
  return { status: r.status, arrayKey: key, count: arr.length, firstItem: JSON.stringify(arr[0] || null).slice(0, cap || 900) };
}

function resp(o) {
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o, null, 2) };
}

exports.handler = async function () {
  const out = {
    hasConsumerId: !!process.env.WALMART_CONSUMER_ID,
    hasKeyVersion: !!process.env.WALMART_KEY_VERSION,
    hasPrivateKey: !!process.env.WALMART_PRIVATE_KEY,
  };
  if (!process.env.WALMART_CONSUMER_ID || !process.env.WALMART_PRIVATE_KEY) {
    out.verdict = 'Missing WALMART_CONSUMER_ID / WALMART_PRIVATE_KEY';
    return resp(out);
  }
  // Confirm the private key decodes to a valid PEM
  const pem = getPrivateKeyPem();
  out.privateKeyLooksValid = pem.includes('BEGIN') && pem.includes('PRIVATE KEY');

  // 1. Taxonomy — the Quick Start auth check
  const tax = await wmGet('/taxonomy');
  out.taxonomyStatus = tax.status;
  if (tax.status !== 200) out.taxonomyRaw = tax.raw;

  // Pull a few REAL category ids from the taxonomy
  const cats = (tax.json && tax.json.categories) || [];
  out.sampleCategories = cats.slice(0, 6).map(c => ({ id: c.id, name: c.name }));
  const PUB    = process.env.WALMART_PUBLISHER_ID || '4077610';
  const realId = cats.find(c => /electronic|home|tool/i.test(c.name || ''))?.id || (cats[0] && cats[0].id);
  out.testCategoryId = realId;

  // 2a. paginated/items filtered to a real category (looking for non-sample data)
  if (realId) {
    const byCat = await wmGet(`/paginated/items?publisherId=${PUB}&category=${encodeURIComponent(realId)}`);
    out.itemsByCategory = summarize(byCat, 900);
  }

  // 2b. search for a real product term — most reliable source of live data + prices
  const srch = await wmGet(`/search?publisherId=${PUB}&query=${encodeURIComponent('cordless drill')}`);
  out.searchStatus = srch.status;
  out.searchSample = summarize(srch, 1200);

  out.verdict = tax.status === 200
    ? 'AUTH OK. Compare itemsByCategory / searchSample — looking for REAL (non-sample) items with msrp>salePrice.'
    : `AUTH issue (${tax.status}) — see taxonomyRaw`;
  return resp(out);
};
