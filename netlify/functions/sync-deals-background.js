// Amazon deal discovery — BACKGROUND function (runs up to 15 min, vs 26s for a
// normal function). Triggered by the scheduled `sync-deals` kickoff. Sweeps a
// large keyword list via the Creators API searchItems (sequential, ~1.5s apart
// to respect the ~1 req/sec rate limit), keeps deals 10%+ off, dedupes, and
// replaces the auto-pulled Amazon grid (preserving Top Picks + coded deals).

const AFFILIATE_TAG = 'founditchea09-20';
const MIN_DISCOUNT  = 10;       // % off floor — inflated deals are filtered on the SITE, not at pull-in
const MIN_PRICE     = 5;        // skip sub-$5 junk
const MIN_RATING    = 3.0;      // only cut clearly-bad rated items; 0/unknown is KEPT
const TIME_CAP_MS   = 780000;   // 13 min — stay safely under the 15-min background limit
const MAX_PAGES     = 3;        // pages per keyword (deeper results); stops early if dry

// Broad category sweep — the more terms, the more deals (the API has no
// "browse all deals" endpoint, so coverage = how many keywords we search).
const SEARCH_TERMS = [
  'cordless drill','power tools','tool set','impact driver','wrench set','socket set','tool box','work light','shop vac','air compressor','generator','pressure washer','ladder','tool bag','multimeter','nail gun','angle grinder','work boots','tape measure','utility knife',
  'bluetooth headphones','bluetooth speaker','wireless earbuds','gaming headset','smart tv','monitor','laptop','tablet','smartwatch','security camera','dash cam','power bank','phone charger','usb c cable','keyboard','mouse','webcam','wifi router','ssd','microsd card','projector','soundbar','streaming device','smart watch',
  'air fryer','coffee maker','blender','espresso machine','cookware set','knife set','instant pot','toaster oven','food processor','stand mixer','water bottle','cast iron skillet','kitchen utensils','rice cooker',
  'vacuum cleaner','robot vacuum','air purifier','space heater','humidifier','dehumidifier','tower fan','led strip lights','mattress','pillow','bedding set','smart plug','video doorbell','storage bins','area rug','sheets',
  'camping gear','tent','sleeping bag','cooler','fishing rod','backpack','hiking boots','dumbbells','yoga mat','resistance bands','exercise bike','grill','flashlight','massage gun',
  'car accessories','car vacuum','jump starter','tire inflator','floor mats','motor oil','phone mount','car cover',
  'garden tools','lawn mower','string trimmer','leaf blower','garden hose','planter',
  'office chair','standing desk','electric toothbrush','hair dryer','beard trimmer','sunglasses','watch','backpack cooler',
];

const BRANDS = [
  'dewalt','milwaukee','makita','ryobi','craftsman','black+decker','black & decker','bosch',
  'stanley','ridgid','kobalt','skil','porter-cable','metabo','hart','greenworks','ego',
  'ninja','kitchenaid','cuisinart','keurig','instant pot','crock-pot','hamilton beach','oster',
  'vitamix','nespresso','breville','pyrex','rubbermaid',
  'sony','samsung','lg','bose','jbl','apple','beats','anker','logitech','razer','hp','dell','asus','acer','lenovo','tcl','hisense','roku','amazon','google','garmin','gopro',
  'dyson','shark','bissell','hoover','irobot','roomba',
  'yeti','coleman','igloo','carhartt','dickies','nike','adidas','under armour','columbia','the north face',
];

function isBrand(name, brandName) {
  // Judge by the real brand FIELD only — scanning the product title falsely flags no-name
  // accessories that merely say "for Apple / iPhone / Samsung / Google" as branded.
  const hay = ` ${(brandName || '').toLowerCase()} `;
  return BRANDS.some(b => hay.includes(b));
}

function baseNameKey(name) {
  return (name || '').toLowerCase()
    .replace(/[\s,\-|]+(?:black|white|blue|red|green|grey|gray|silver|gold|pink|purple|midnight|charcoal|cream|navy|teal|rose|ivory|titanium|sage|natural|espresso|walnut|oak|brown|beige|tan|coral|yellow|orange|lavender|violet|maroon|olive|mint|turquoise|multicolor|multi.color|\d+[\s-]?pack|\d+\s*oz|\d+\s*lbs?|\d+\s*ft|\d+\s*in(?:ch)?|\d+\s*count)\b.*$/i, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').slice(0, 7).join(' ');
}

// Maps a product title (or Walmart category path) to an Amazon-department-style
// category. Order matters — most specific / least ambiguous checks come first.
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

let _creatorsToken = null, _creatorsTokenExp = 0;
async function getCreatorsToken() {
  if (_creatorsToken && Date.now() < _creatorsTokenExp - 60000) return _creatorsToken;
  const clientId = process.env.AMAZON_CREATORS_CLIENT_ID, clientSecret = process.env.AMAZON_CREATORS_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Creators API not configured');
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'creatorsapi::default' }).toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Creators token failed: ' + JSON.stringify(data));
  _creatorsToken = data.access_token; _creatorsTokenExp = Date.now() + (data.expires_in || 3600) * 1000;
  return _creatorsToken;
}

async function searchAmazon(keywords, token, page = 1, retry = true) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch('https://creatorsapi.amazon/catalog/v1/searchItems', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-marketplace': 'www.amazon.com' },
      body: JSON.stringify({
        keywords, searchIndex: 'All', itemCount: 10, itemPage: page, minSavingPercent: MIN_DISCOUNT,
        resources: ['images.primary.large', 'itemInfo.title', 'itemInfo.byLineInfo', 'offersV2.listings.price', 'offersV2.listings.dealDetails', 'customerReviews.starRating', 'customerReviews.count'],
        partnerTag: AFFILIATE_TAG, partnerType: 'Associates', marketplace: 'www.amazon.com',
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.status === 429 && retry) { await new Promise(r => setTimeout(r, 2500)); return searchAmazon(keywords, token, page, false); }
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch {}
    if (res.status !== 200) { console.error(`[sync-deals-bg] "${keywords}" p${page} -> HTTP ${res.status}: ${text.slice(0, 120)}`); return { items: [], status: res.status }; }
    return { items: (data && (data.searchResult?.items || data.itemsResult?.items || data.items)) || [], status: 200 };
  } catch (e) { clearTimeout(timer); return { items: [], status: 0 }; }
}

async function discoverDeals() {
  let token;
  try { token = await getCreatorsToken(); }
  catch (e) { console.error('[sync-deals-bg] token failed:', e.message); return { deals: [], stats: {} }; }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const start = Date.now();
  const found = {};
  const stats = { terms: 0, s200: 0, s429: 0, sErr: 0, itemsSeen: 0 };

  for (const term of SEARCH_TERMS) {
    if (Date.now() - start > TIME_CAP_MS) { stats.timeCap = true; break; }
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { items, status } = await searchAmazon(term, token, page);
      stats.terms++;
      if (status === 200) stats.s200++; else if (status === 429) stats.s429++; else stats.sErr++;
      stats.itemsSeen += items.length;
      let newOnPage = 0;
      for (const it of items) {
        const asin = it.asin || it.ASIN;
        if (!asin || found[asin]) continue;
        const listings = it.offersV2?.listings || [];
        const listing = listings.find(l => l.isBuyBoxWinner) || listings[0];
        const price = Number(listing?.price?.money?.amount) || 0;
        const was = Number(listing?.price?.savingBasis?.money?.amount) || 0;
        const pct = listing?.price?.savings?.percentage;
        if (price < MIN_PRICE || was <= price) continue;
        const off = (typeof pct === 'number' && pct > 0) ? Math.round(pct) : Math.round((1 - price / was) * 100);
        if (off < MIN_DISCOUNT) continue;   // floor only; inflated ones are hidden on the site, not dropped here
        const name = it.itemInfo?.title?.displayValue || '';
        const brandName = it.itemInfo?.byLineInfo?.brand?.displayValue || '';
        const brand = isBrand(name, brandName);
        const rating = it.customerReviews?.starRating?.value || 0;
        if (rating > 0 && rating < MIN_RATING) continue;
        newOnPage++;
        found[asin] = {
          asin, name: name.slice(0, 250), price, was, off,
          img: it.images?.primary?.large?.url || '',
          rating, reviews: it.customerReviews?.count || 0, brand,
          brandName: brand ? brandName : '',
          category: inferCategory(name),
          url: `https://www.amazon.com/dp/${asin}?tag=${AFFILIATE_TAG}`,
        };
      }
      await sleep(1500);
      if (items.length < 10) break;            // last page for this term
      if (page > 1 && newOnPage === 0) break;  // pagination not yielding anything new
      if (Date.now() - start > TIME_CAP_MS) { stats.timeCap = true; break; }
    }
  }
  stats.found = Object.keys(found).length;
  console.log('[sync-deals-bg] discovery stats:', JSON.stringify(stats));
  return { deals: Object.values(found), stats };
}

exports.handler = async function () {
  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) { console.error('[sync-deals-bg] missing env'); return { statusCode: 500, body: 'Configuration error' }; }
  const sbHeaders = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  const disc = await discoverDeals();
  let deals = disc.deals;
  const bestByKey = {};
  for (const d of deals) { const k = baseNameKey(d.name); if (!bestByKey[k] || d.off > bestByKey[k].off) bestByKey[k] = d; }
  deals = Object.values(bestByKey);
  // Safeguard: never let a deal-site placeholder title through (belt-and-suspenders).
  const BANNED = /dealseek|joylink|koupon|coupert|slickdeals|dealnews|couponbirds|capital one shopping|we'?re building|for smarter shopping/i;
  deals = deals.filter(d => !BANNED.test(d.name || ''));

  // Don't duplicate coded deals, blocked ASINs, or current Top Picks.
  const skipAsins = new Set();
  async function collectSkips(url, mapFn) {
    try { const r = await fetch(url, { headers: sbHeaders }); const j = await r.json(); if (Array.isArray(j)) j.forEach(x => { const a = mapFn(x); if (a) skipAsins.add(a); }); } catch (e) {}
  }
  await collectSkips(`${sbUrl}/rest/v1/deals?store=eq.Amazon&code=not.is.null&select=url`, d => (d.url.match(/\/dp\/([A-Z0-9]{10})/i) || [])[1]);
  await collectSkips(`${sbUrl}/rest/v1/blocked_deals?select=asin`, x => String(x.asin || '').toUpperCase());
  await collectSkips(`${sbUrl}/rest/v1/deals?is_top_pick=eq.true&select=url`, d => (d.url.match(/\/dp\/([A-Z0-9]{10})/i) || [])[1]);
  if (skipAsins.size) deals = deals.filter(d => !skipAsins.has(d.asin));

  console.log(`[sync-deals-bg] ${deals.length} qualifying Amazon deals`);
  if (deals.length === 0) return { statusCode: 200, body: JSON.stringify({ ok: true, added: 0, stats: disc.stats }) };

  // Preserve each deal's original "first seen" timestamp across the wipe-and-reinsert
  // below, so the site's "date added" filter reflects when a deal FIRST appeared —
  // not the last sync. Keyed by ASIN. Deals we've never seen before get now().
  const firstSeenByAsin = {};
  try {
    const ex = await fetch(`${sbUrl}/rest/v1/deals?store=eq.Amazon&is_top_pick=eq.false&code=is.null&select=url,first_seen`, { headers: sbHeaders });
    const exJson = await ex.json();
    if (Array.isArray(exJson)) exJson.forEach(r => {
      const a = (String(r.url || '').match(/\/dp\/([A-Z0-9]{10})/i) || [])[1];
      if (a && r.first_seen) firstSeenByAsin[a.toUpperCase()] = r.first_seen;
    });
  } catch (e) { console.error('[sync-deals-bg] first_seen read failed:', e.message); }

  try {
    await fetch(`${sbUrl}/rest/v1/deals?store=eq.Amazon&is_top_pick=eq.false&code=is.null`, { method: 'DELETE', headers: { ...sbHeaders, Prefer: 'return=minimal' } });
  } catch (e) { console.error('[sync-deals-bg] clear failed:', e.message); }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const nowIso = new Date().toISOString();
  const rows = deals.map((d, i) => {
    const asin = (String(d.url || '').match(/\/dp\/([A-Z0-9]{10})/i) || [])[1];
    return {
      rank: i + 1, name: d.name, store: 'Amazon', category: d.category,
      price: d.price, was: d.was, off: d.off, rating: d.rating || 0, reviews: d.reviews || 0,
      img: d.img, images: null, url: d.url, code: null, use_code_url: false,
      creator: d.brand, brand: d.brand, brand_name: d.brandName || null, active_date: today, is_top_pick: false,
      price_checked_at: nowIso,   // grid prices are freshly pulled from the API this run
      first_seen: (asin && firstSeenByAsin[asin.toUpperCase()]) || nowIso,
    };
  });

  const CHUNK = 100; let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const ins = await fetch(`${sbUrl}/rest/v1/deals`, { method: 'POST', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify(chunk) });
    if (ins.ok) inserted += chunk.length; else console.error(`[sync-deals-bg] insert chunk ${i} failed:`, await ins.text());
  }
  console.log(`[sync-deals-bg] ✓ Inserted ${inserted} Amazon deals`);
  return { statusCode: 200, body: JSON.stringify({ ok: true, added: inserted, stats: disc.stats }) };
};
