// Admin-gated add/remove of promo-code deals via the Google Sheet gateway.
// The sheet is the source of truth, so adding/removing here edits the sheet
// (Apps Script web app); sync-codes then mirrors it onto the site.
//
// POST { password, action:'add'|'remove', amazon_link, promo_code, discount_price, asin }

function asinFromUrl(url) {
  const s = String(url || '');
  const m = s.match(/(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/product\/|[?&]asin=)([A-Z0-9]{10})/i);
  if (m) return m[1].toUpperCase();
  const b = s.match(/\b(B0[A-Z0-9]{8})\b/i);
  return b ? b[1].toUpperCase() : '';
}

// ── Amazon Creators API (for instant insert on add) ───────────────────────
const TOKEN_ENDPOINT = 'https://api.amazon.com/auth/o2/token';
const ITEMS_ENDPOINT = 'https://creatorsapi.amazon/catalog/v1/getItems';
const MARKETPLACE    = 'www.amazon.com';
const AFFILIATE_TAG  = 'founditchea09-20';
const RESOURCES = ['images.primary.large', 'itemInfo.title', 'itemInfo.byLineInfo', 'offersV2.listings.price', 'customerReviews.starRating', 'customerReviews.count'];

// Maps a product title to an Amazon-department-style category.
// Order matters — most specific / least ambiguous checks come first.
function inferCategory(text) {
  const t = (text || '').toLowerCase();
  if (/\bbaby\b|infant|newborn|toddler|diaper|stroller|\bcrib\b|pacifier|nursing|breast ?pump|baby monitor|onesie|sippy/.test(t)) return 'Baby Products';
  if (/\bdog\b|\bcat\b|puppy|kitten|\bpet\b|\bleash\b|litter box|aquarium|fish tank|chew toy|pet bed|\bflea\b|\bkennel\b|dog food|cat food|pet supplies/.test(t)) return 'Pet Supplies';
  if (/\btoys?\b|\blego\b|jigsaw|puzzle|board game|\bdoll\b|action figure|\bnerf\b|building blocks|play ?set|stuffed animal|rc car|remote control car|play kitchen/.test(t)) return 'Toys & Games';
  if (/automotive|\bcar\b|\btruck\b|\btire\b|dash ?cam|motor oil|windshield|\bvehicle\b|jump starter|\bbrake|headlight|\bwiper|\bobd\b|\bsuv\b|\batv\b|car cover|seat cover|car wash/.test(t)) return 'Automotive';
  if (/alexa|echo dot|echo show|fire tv|fire stick|fire tablet|ring doorbell|blink (camera|mini)|\becho\b/.test(t)) return 'Amazon Devices & Accessories';
  if (/phone case|screen protector|iphone|galaxy s\d|pixel \d|charging cable|phone (holder|mount|grip)|airpods|wireless charger|power bank|usb-?c cable|lightning cable/.test(t)) return 'Cell Phones & Accessories';
  if (/\bps5\b|\bps4\b|\bxbox\b|nintendo switch|playstation|video game|game controller|gaming controller|joy-?con|dualsense/.test(t)) return 'Video Games';
  if (/musical instrument|\bguitar\b|\bpiano\b|drum (set|kit)|\bviolin\b|ukulele|amplifier|midi keyboard|saxophone|trumpet|bass guitar/.test(t)) return 'Musical Instruments';
  if (/\btools?\b|hardware|\bdrill\b|\bsaw\b|wrench|screwdriver|power tool|cordless|nail(er| gun)|\bsander\b|grinder|\bsocket|pliers|\bladder\b|air compressor|\bhammer\b|tool ?box|tool ?set|workbench|drill bit|tape measure|utility knife|caulk|\bfaucet\b|plumbing|stud finder/.test(t)) return 'Tools & Home Improvement';
  if (/garden|\blawn\b|\bplant\b|\bseed|\bsoil\b|fertilizer|\bhose\b|sprinkler|greenhouse|pruner|\bmower\b|hedge|leaf blower|\bpatio\b|\bgrill\b|fire pit|gazebo|wheelbarrow|\bweed\b|string trimmer|outdoor furniture|raised bed/.test(t)) return 'Patio, Lawn & Garden';
  if (/appliance|refrigerator|washing machine|\bwasher\b|\bdryer\b|dishwasher|microwave|\bfreezer\b|mini fridge|ice maker|range hood|cooktop|\bstove\b|dehumidifier/.test(t)) return 'Appliances';
  if (/kitchen|air fryer|coffee maker|\bblender\b|instant pot|cookware|knife set|cutting board|toaster|bakeware|skillet|espresso|keurig|food processor|pressure cooker|\bpot\b|\bpan\b|dish (rack|set)|mattress|\bpillow\b|bedding|sheet set|\btowel|curtain|\brug\b|\blamp\b|furniture|\bsofa\b|\bcouch\b|organizer|storage (bin|box)|\bvacuum\b|\bmop\b|comforter|blanket|dinnerware|flatware|spatula|\bhome\b/.test(t)) return 'Home & Kitchen';
  if (/grocery|\bfood\b|\bsnack|\bcandy\b|chocolate|coffee beans|ground coffee|\btea\b|protein bar|\bsauce\b|\bspice|seasoning|beverage|drink mix|gummies|\bhoney\b|olive oil|\bjerky\b|\bcereal\b|\bcoffee\b/.test(t)) return 'Grocery & Gourmet Food';
  if (/\bhealth\b|vitamin|supplement|protein powder|first aid|thermometer|toilet paper|paper towel|\bcleaning|detergent|sanitizer|face mask|probiotic|pain relief|bandage|ibuprofen|collagen|melatonin|disinfect/.test(t)) return 'Health & Household';
  if (/beauty|makeup|skincare|\bserum\b|shampoo|conditioner|\blotion\b|perfume|cologne|\brazor\b|beard trimmer|hair (trimmer|clipper|dryer)|nail (polish|kit)|lipstick|moisturizer|electric shaver|sunscreen|foundation|mascara|cosmetic/.test(t)) return 'Beauty & Personal Care';
  if (/office|printer|ink cartridge|\btoner\b|\bpens?\b|notebook|\bdesk\b|office chair|stapler|label maker|planner|\bbinder\b|shredder|calculator|sticky notes|file cabinet/.test(t)) return 'Office Products';
  if (/electronic|headphone|earbud|\bspeaker\b|\btv\b|television|laptop|\btablet\b|smart ?watch|\bcamera\b|\bconsole\b|keyboard|\bmouse\b|monitor|projector|\bssd\b|hard drive|webcam|soundbar|\brouter\b|\bmodem\b|\bcharger\b|\bhdmi\b|\bdrone\b|smart home/.test(t)) return 'Electronics';
  if (/clothing|apparel|footwear|\bshirt\b|t-?shirt|\bshoes\b|sneaker|\bboots\b|\bjacket\b|\bjeans\b|\bdress\b|\bwatch\b|\bsocks\b|hoodie|\bhat\b|\bcap\b|sunglasses|jewelry|necklace|bracelet|\bring\b|earrings|\bbra\b|leggings|sandals|\bbelt\b|\bwallet\b|\bpurse\b|handbag|\bcoat\b|sweater|underwear/.test(t)) return 'Clothing, Shoes & Jewelry';
  if (/sports|outdoor|dumbbell|barbell|workout|\byoga\b|exercise|fitness|treadmill|\bgym\b|weight set|resistance band|massage gun|camping|hiking|\btent\b|sleeping bag|backpack|\bcooler\b|fishing|kayak|\bpaddle|hammock|\bgolf\b|basketball|bicycle|\bbike\b|\bhelmet\b|skateboard|football/.test(t)) return 'Sports & Outdoors';
  if (/arts.{0,4}crafts|sewing|\byarn\b|knitting|crochet|paint brush|\bcanvas\b|\bcraft|\bbeads\b|embroidery|scrapbook|\bsticker|acrylic paint|glue gun|\bfabric\b|quilting/.test(t)) return 'Arts, Crafts & Sewing';
  if (/industrial|microscope|\blab\b|safety glasses|work gloves|\btarp\b|generator|multimeter|hand truck|\bdolly\b|\bcaster|telescope/.test(t)) return 'Industrial & Scientific';
  return 'Everything Else';
}

let _token = null, _tokenExp = 0;
async function getToken() {
  if (_token && Date.now() < _tokenExp - 60000) return _token;
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: process.env.AMAZON_CREATORS_CLIENT_ID, client_secret: process.env.AMAZON_CREATORS_CLIENT_SECRET, scope: 'creatorsapi::default' }).toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('token failed');
  _token = data.access_token; _tokenExp = Date.now() + (data.expires_in || 3600) * 1000;
  return _token;
}
async function fetchProduct(asin, token) {
  const res = await fetch(ITEMS_ENDPOINT, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-marketplace': MARKETPLACE },
    body: JSON.stringify({ itemIds: [asin], itemIdType: 'ASIN', resources: RESOURCES, partnerTag: AFFILIATE_TAG, partnerType: 'Associates', marketplace: MARKETPLACE }),
  });
  const data = await res.json();
  const item = data.itemsResult?.items?.[0];
  if (!item) return null;
  const listing = item.offersV2?.listings?.[0];
  const apiPrice = Number(listing?.price?.money?.amount ?? listing?.price?.amount) || 0;
  return {
    name: item.itemInfo?.title?.displayValue || '',
    apiPrice,
    img: item.images?.primary?.large?.url || '',
    rating: item.customerReviews?.starRating?.value || 0,
    reviews: item.customerReviews?.count || 0,
    brandName: item.itemInfo?.byLineInfo?.brand?.displayValue || '',
  };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { password, action, amazon_link, promo_code, discount_price } = body;
  // Owner (Erik) and the VA (Kuldeep) may both manage promo deals. Which one is
  // acting is derived from the password, so uploads get tagged reliably and can't
  // be spoofed by the client.
  const role = (process.env.ADMIN_PASSWORD && password === process.env.ADMIN_PASSWORD) ? 'owner'
             : ((process.env.VA_PASSWORD && password === process.env.VA_PASSWORD) ||
                (process.env.AGENT_PASSWORD && password === process.env.AGENT_PASSWORD)) ? 'va'
             : null;
  if (!role) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  // Attribution: the password identifies who's adding, so uploads get tagged reliably.
  const uploader = (process.env.VA_PASSWORD && password === process.env.VA_PASSWORD) ? 'Kuldeep'
                 : (process.env.AGENT_PASSWORD && password === process.env.AGENT_PASSWORD) ? 'Promo Agent'
                 : 'Erik';

  const gwUrl = process.env.SHEET_API_URL;
  const gwTok = process.env.SHEET_API_TOKEN;
  if (!gwUrl || !gwTok) return { statusCode: 500, body: JSON.stringify({ error: 'Sheet gateway not configured' }) };

  const callGateway = async (payload) => {
    const r = await fetch(gwUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: gwTok, ...payload }),
      redirect: 'follow',
    });
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { ok: false, error: 'gateway non-JSON: ' + text.slice(0, 120) }; }
  };

  try {
    if (action === 'add') {
      const asin = asinFromUrl(amazon_link);
      if (!asin) return { statusCode: 400, body: JSON.stringify({ error: 'No Amazon ASIN found in that link' }) };
      const retailIn = parseFloat(String(body.retail_price || '').replace(/[^0-9.]/g, '')) || 0;
      const titleIn = String(body.title || '').trim();
      const res = await callGateway({
        action: 'append',
        amazon_link: String(amazon_link || ''),
        promo_code: String(promo_code || ''),
        discount_price: String(discount_price || ''),
      });
      // Insert into the grid right away so it appears instantly. Use the Amazon
      // API for the best data, but fall back to the price/retail/title the caller
      // supplied so the deal still shows up even if the API lookup comes back empty.
      let instant = false;
      try {
        const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        let prod = null;
        try { prod = await fetchProduct(asin, await getToken()); } catch (e) { /* API may be unavailable */ }
        if (sbUrl && sbKey) {
          const dp = parseFloat(String(discount_price || '').replace(/[^0-9.]/g, '')) || 0;
          const apiPrice = (prod && prod.apiPrice) || 0;
          const price = dp > 0 ? dp : apiPrice;                                  // deal/after-code price
          let regular = Math.max(apiPrice, retailIn, price);                     // "was" = highest known price
          if (!(regular > 0)) regular = price;
          if (price > 0) {
            const off = regular > price ? Math.round((1 - price / regular) * 100) : 0;
            const name = (prod && prod.name) ? prod.name : (titleIn || ('Amazon deal ' + asin));
            const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
            const sb = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };
            await fetch(`${sbUrl}/rest/v1/deals?url=like.*${asin}*&is_top_pick=eq.false`, { method: 'DELETE', headers: { ...sb, Prefer: 'return=minimal' } }).catch(() => {});
            const row = {
              rank: 900, name: name.slice(0, 250), store: 'Amazon', category: inferCategory(name),
              price, was: regular, off, rating: (prod && prod.rating) || 0, reviews: (prod && prod.reviews) || 0,
              img: (prod && prod.img) || '', images: null, url: `https://www.amazon.com/dp/${asin}?tag=${AFFILIATE_TAG}`,
              code: String(promo_code || ''), use_code_url: false, creator: false, brand: false,
              brand_name: (prod && prod.brandName) || null, active_date: today, is_top_pick: false,
              uploaded_by: uploader,
              review_status: 'pending',   // held & hidden until review-deals scans it (~10 min)
            };
            let insRes = await fetch(`${sbUrl}/rest/v1/deals`, { method: 'POST', headers: { ...sb, Prefer: 'return=minimal' }, body: JSON.stringify(row) });
            if (!insRes.ok) {
              // review_status column may not exist yet (SQL not run) — retry without it.
              const rowNoStatus = { ...row }; delete rowNoStatus.review_status;
              insRes = await fetch(`${sbUrl}/rest/v1/deals`, { method: 'POST', headers: { ...sb, Prefer: 'return=minimal' }, body: JSON.stringify(rowNoStatus) });
            }
            instant = insRes.ok;
          }
        }
      } catch (e) { /* sheet has it; the scheduled sync will pull it in even if this failed */ }
      // Success if EITHER the sheet append or the instant insert worked. The deal is
      // held (pending) and hidden until review-deals scans it, so report 'queued'.
      return { statusCode: (res.ok || instant) ? 200 : 502, body: JSON.stringify({ ok: !!(res.ok || instant), asin, instant, queued: true }) };
    }

    if (action === 'remove') {
      const asin = (body.asin ? String(body.asin) : asinFromUrl(amazon_link)).toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(asin)) return { statusCode: 400, body: JSON.stringify({ error: 'Invalid ASIN' }) };
      // 1) remove the row from the sheet (so the sync won't re-add it)
      const res = await callGateway({ action: 'remove', asin });
      // 2) delete it from the site now (both the grid row AND any Top-Pick row)
      const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (sbUrl && sbKey) {
        await fetch(`${sbUrl}/rest/v1/deals?url=like.*${asin}*`, {
          method: 'DELETE',
          headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, Prefer: 'return=minimal' },
        }).catch(() => {});
      }
      return { statusCode: res.ok ? 200 : 502, body: JSON.stringify({ ...res, asin }) };
    }

    if (action === 'addsheet') {
      // Append to the sheet only (no grid insert) — used to keep coded Top Picks
      // recorded in the promo sheet so the two stay in sync.
      const asin = asinFromUrl(amazon_link);
      if (!asin) return { statusCode: 400, body: JSON.stringify({ error: 'No ASIN' }) };
      const res = await callGateway({ action: 'append', amazon_link: String(amazon_link), promo_code: String(promo_code || ''), discount_price: String(discount_price || '') });
      return { statusCode: res.ok ? 200 : 502, body: JSON.stringify({ ...res, asin }) };
    }

    if (action === 'promote' || action === 'demote') {
      const asin = (body.asin ? String(body.asin) : asinFromUrl(amazon_link)).toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(asin)) return { statusCode: 400, body: JSON.stringify({ error: 'Invalid ASIN' }) };
      const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!sbUrl || !sbKey) return { statusCode: 500, body: JSON.stringify({ error: 'Config error' }) };
      const sb = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      // When sending a deal back to the grid, make sure it's in the sheet first,
      // so the promo sync keeps it instead of pruning it as "not in the sheet".
      if (action === 'demote' && amazon_link) {
        await callGateway({ action: 'append', amazon_link: String(amazon_link), promo_code: String(promo_code || ''), discount_price: String(discount_price || '') }).catch(() => {});
      }
      // Flip the existing row in place — no delete/insert, so no duplicate row.
      const from = action === 'promote' ? 'false' : 'true';
      const patch = action === 'promote' ? { is_top_pick: true, active_date: today } : { is_top_pick: false };
      const r = await fetch(`${sbUrl}/rest/v1/deals?url=like.*${asin}*&is_top_pick=eq.${from}`, {
        method: 'PATCH', headers: { ...sb, Prefer: 'return=minimal' }, body: JSON.stringify(patch),
      });
      return { statusCode: r.ok ? 200 : 502, body: JSON.stringify({ ok: r.ok, action, asin }) };
    }

    if (action === 'edit') {
      // Edit a deal in place (fix a wrong price, title, code, etc.). Matches by
      // row id so it touches exactly the one row. % off is recomputed here.
      const id = String(body.id || '');
      if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'Missing deal id' }) };
      const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!sbUrl || !sbKey) return { statusCode: 500, body: JSON.stringify({ error: 'Config error' }) };
      const sb = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };
      const patch = {};
      if (body.name != null) patch.name = String(body.name).slice(0, 250);
      if (body.code != null) patch.code = String(body.code);
      const price = parseFloat(String(body.price ?? '').replace(/[^0-9.]/g, ''));
      const was = parseFloat(String(body.was ?? '').replace(/[^0-9.]/g, ''));
      if (price > 0) patch.price = price;
      if (was > 0) patch.was = was;
      if (price > 0 && was > 0) patch.off = was > price ? Math.round((1 - price / was) * 100) : 0;
      if (!Object.keys(patch).length) return { statusCode: 400, body: JSON.stringify({ error: 'Nothing to update' }) };
      const r = await fetch(`${sbUrl}/rest/v1/deals?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { ...sb, Prefer: 'return=minimal' }, body: JSON.stringify(patch),
      });
      return { statusCode: r.ok ? 200 : 502, body: JSON.stringify({ ok: r.ok, action: 'edit', id }) };
    }

    if (action === 'approve') {
      // Manually publish a pending/flagged deal (from the admin review section).
      const asin = (body.asin ? String(body.asin) : asinFromUrl(amazon_link)).toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(asin)) return { statusCode: 400, body: JSON.stringify({ error: 'Invalid ASIN' }) };
      const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!sbUrl || !sbKey) return { statusCode: 500, body: JSON.stringify({ error: 'Config error' }) };
      const sb = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };
      const r = await fetch(`${sbUrl}/rest/v1/deals?url=like.*${asin}*`, {
        method: 'PATCH', headers: { ...sb, Prefer: 'return=minimal' }, body: JSON.stringify({ review_status: 'live', flag_reason: null }),
      });
      return { statusCode: r.ok ? 200 : 502, body: JSON.stringify({ ok: r.ok, action: 'approve', asin }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'manage-code failed', detail: String(e).slice(0, 200) }) };
  }
};
