// Scheduled Walmart deal sync (daily, see netlify.toml).
//
// Pulls discounted Walmart products via the Walmart Affiliate Marketing API
// (signed requests; searches a set of category terms), keeps items with a real
// markdown >= MIN_DISCOUNT, dedupes by Walmart itemId, and inserts them into the
// Supabase `deals` table with store='Walmart'. The affiliate link is the
// API-provided productTrackingUrl (publisher id baked in — already monetized).
const crypto = require('crypto');

const BASE         = 'https://developer.api.walmart.com/api-proxy/service/affil/product/v2';
const MIN_DISCOUNT = 10;   // % off — wide net per Erik
const MAX_DISCOUNT = 80;   // cap fake/inflated-MSRP deals
const MIN_PRICE    = 5;    // skip sub-$5 junk
const MIN_RATING   = 3.0;  // only cut clearly-bad rated items; 0/unknown is KEPT
const MIN_REVIEWS  = 0;    // KEEP no-name / low-review products (promo-code sources)
const BRAND_MAX    = 90;   // hard sanity ceiling even for brands (above = likely a price error)

// Recognized brands: a >MAX_DISCOUNT deal is trustworthy if it's a real brand
// (real brands rarely fake-inflate MSRP). Per Erik: brand + big discount = great deal.
const BRANDS = [
  'dewalt','milwaukee','makita','ryobi','craftsman','black+decker','black & decker','bosch',
  'stanley','ridgid','kobalt','skil','porter-cable','metabo','hart','greenworks','ego',
  'ninja','kitchenaid','cuisinart','keurig','instant pot','crock-pot','hamilton beach','oster',
  'vitamix','nespresso','breville','pyrex','rubbermaid','tupperware',
  'sony','samsung','lg','bose','jbl','apple','beats','anker','logitech','razer','hp','dell','asus','acer','lenovo','tcl','hisense','roku','amazon','google','garmin','gopro',
  'dyson','shark','bissell','hoover','irobot','roomba',
  'yeti','coleman','igloo','stanley','carhartt','dickies','nike','adidas','under armour','columbia','the north face',
  'graco','fisher-price','lego','nerf','hot wheels','barbie',
  'gillette','olay','cerave','colgate','crest',
];

function isBrand(name, brandName) {
  const hay = `${(brandName || '')} ${(name || '')}`.toLowerCase();
  return BRANDS.some(b => hay.includes(b));
}

// Strip trailing color/size/variant words → dedup key (avoids the same item twice)
function baseNameKey(name) {
  return (name || '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').slice(0, 8).join(' ');
}

// Blue-collar / male-skewed category terms (mirrors the old auto-picker intent)
const SEARCH_TERMS = [
  'cordless drill', 'power tools', 'tool set', 'impact driver', 'work boots', 'wrench set', 'socket set', 'tool box', 'air compressor', 'generator', 'pressure washer', 'shop vac', 'work light', 'ladder',
  'air fryer', 'coffee maker', 'blender', 'instant pot', 'cookware set', 'knife set', 'toaster oven', 'stand mixer', 'kitchen appliances', 'water bottle',
  'bluetooth headphones', 'bluetooth speaker', 'wireless earbuds', 'gaming headset', 'smart tv', 'monitor', 'laptop', 'tablet', 'smartwatch', 'security camera', 'power bank', 'phone charger', 'keyboard', 'router', 'soundbar', 'streaming device',
  'vacuum cleaner', 'robot vacuum', 'air purifier', 'space heater', 'humidifier', 'tower fan', 'led lights', 'mattress', 'pillow', 'bedding set', 'storage bins', 'area rug',
  'camping gear', 'tent', 'sleeping bag', 'cooler', 'fishing rod', 'backpack', 'dumbbells', 'yoga mat', 'exercise bike', 'grill', 'flashlight',
  'car accessories', 'car vacuum', 'jump starter', 'tire inflator', 'floor mats', 'phone mount',
  'garden tools', 'lawn mower', 'string trimmer', 'leaf blower', 'garden hose',
  'office chair', 'standing desk', 'hair dryer', 'beard trimmer', 'electric toothbrush',
];

function getPrivateKeyPem() {
  return Buffer.from(process.env.WALMART_PRIVATE_KEY || '', 'base64').toString('utf8');
}

function sign(consumerId, keyVersion, timestamp, pem) {
  const s = crypto.createSign('RSA-SHA256');
  s.update(`${consumerId}\n${timestamp}\n${keyVersion}\n`);
  s.end();
  return s.sign(pem, 'base64');
}

async function wmSearch(term, pub) {
  const consumerId = process.env.WALMART_CONSUMER_ID;
  const keyVersion = process.env.WALMART_KEY_VERSION || '1';
  const pem        = getPrivateKeyPem();
  const ts         = Date.now().toString();
  const sig        = sign(consumerId, keyVersion, ts, pem);
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${BASE}/search?publisherId=${pub}&query=${encodeURIComponent(term)}&numItems=25`, {
      headers: {
        'WM_CONSUMER.ID':          consumerId,
        'WM_CONSUMER.INTIMESTAMP': ts,
        'WM_SEC.KEY_VERSION':      keyVersion,
        'WM_SEC.AUTH_SIGNATURE':   sig,
        'Accept':                  'application/json',
      },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) { console.error(`[sync-walmart] search "${term}" -> HTTP ${res.status}`); return []; }
    const data = await res.json();
    return data.items || [];
  } catch (e) {
    clearTimeout(timer);
    console.error(`[sync-walmart] search "${term}" failed: ${e.message}`);
    return [];
  }
}

// Maps a product name + Walmart category path to an Amazon-department-style
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
  if (/electronic|headphone|earbud|\bspeaker\b|\btv\b|television|laptop|\btablet\b|smart ?watch|\bcamera\b|\bconsole\b|keyboard|\bmouse\b|monitor|projector|\bssd\b|hard drive|webcam|soundbar|\brouter\b|\bmodem\b|\bcharger\b|\bhdmi\b|\bdrone\b|smart home|computer/.test(t)) return 'Electronics';
  if (/clothing|apparel|footwear|\bshirt\b|t-?shirt|\bshoes\b|sneaker|\bboots\b|\bjacket\b|\bjeans\b|\bdress\b|\bwatch\b|\bsocks\b|hoodie|\bhat\b|\bcap\b|sunglasses|jewelry|necklace|bracelet|\bring\b|earrings|\bbra\b|leggings|sandals|\bbelt\b|\bwallet\b|\bpurse\b|handbag|\bcoat\b|sweater|underwear/.test(t)) return 'Clothing, Shoes & Jewelry';
  if (/sports|outdoor|dumbbell|barbell|workout|\byoga\b|exercise|fitness|treadmill|\bgym\b|weight set|resistance band|massage gun|camping|hiking|\btent\b|sleeping bag|backpack|\bcooler\b|fishing|kayak|\bpaddle|hammock|\bgolf\b|basketball|bicycle|\bbike\b|\bhelmet\b|skateboard|football/.test(t)) return 'Sports & Outdoors';
  if (/arts.{0,4}crafts|sewing|\byarn\b|knitting|crochet|paint brush|\bcanvas\b|\bcraft|\bbeads\b|embroidery|scrapbook|\bsticker|acrylic paint|glue gun|\bfabric\b|quilting/.test(t)) return 'Arts, Crafts & Sewing';
  if (/industrial|microscope|\blab\b|safety glasses|work gloves|\btarp\b|generator|multimeter|hand truck|\bdolly\b|\bcaster|telescope/.test(t)) return 'Industrial & Scientific';
  return 'Everything Else';
}

exports.handler = async function () {
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const pub   = process.env.WALMART_PUBLISHER_ID || '4077610';

  if (!process.env.WALMART_CONSUMER_ID || !process.env.WALMART_PRIVATE_KEY || !sbUrl || !sbKey) {
    console.error('[sync-walmart] Missing required environment variables');
    return { statusCode: 500, body: 'Configuration error' };
  }
  const sbHeaders = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  // 1. Search across terms IN PARALLEL (stays within the function time limit).
  //    REPLACE-style sync: pull the current best deals, then swap out the old
  //    auto-pulled Walmart set below — so deals stay fresh and never accumulate
  //    duplicates or stale prices.
  const termResults = await Promise.all(SEARCH_TERMS.map(t => wmSearch(t, pub)));

  // One-time: reveal the real field names on the first live item
  const probe = termResults.flat().find(Boolean);
  if (probe) {
    console.log('[sync-walmart] sample item keys:', Object.keys(probe).join(','));
    console.log('[sync-walmart] sample item:', JSON.stringify(probe).slice(0, 600));
  }

  const found = {};
  for (const items of termResults) {
    for (const it of items) {
      const id = String(it.itemId || '');
      if (!id || found[id]) continue;
      const price = Number(it.salePrice) || 0;
      const was   = Number(it.msrp) || 0;
      if (price < MIN_PRICE || was <= price) continue;     // real markdown + skip sub-$5 junk
      const off = Math.round((1 - price / was) * 100);
      if (off < MIN_DISCOUNT) continue;
      // Cap everything at MAX_DISCOUNT (80%) — above that is usually an inflated MSRP.
      const brand = isBrand(it.name, it.brandName);
      if (off > MAX_DISCOUNT) continue;
      const rating  = parseFloat(it.customerRating) || 0;
      const reviews = Number(it.numReviews) || 0;
      if (rating > 0 && rating < MIN_RATING) continue;
      if (reviews < MIN_REVIEWS) continue;
      const url = it.productTrackingUrl || (it.affiliateAddToCartUrl) || '';
      if (!url) continue;                                  // no affiliate link = no commission, skip
      found[id] = {
        name:     (it.name || '').slice(0, 250),
        price, was, off,
        img:      it.largeImage || it.mediumImage || it.thumbnailImage || '',
        url,
        rating, reviews,
        brand,
        brandName: brand ? (it.brandName || '') : '',
        category: inferCategory((it.name || '') + ' ' + (it.categoryPath || '')),
      };
    }
  }

  // Dedup variants: same base product name → keep the highest-discount one only
  const bestByKey = {};
  for (const d of Object.values(found)) {
    const k = baseNameKey(d.name);
    if (!bestByKey[k] || d.off > bestByKey[k].off) bestByKey[k] = d;
  }
  const deals = Object.values(bestByKey);
  console.log(`[sync-walmart] ${deals.length} new qualifying Walmart deals (after variant dedup)`);
  if (deals.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, added: 0 }) };
  }

  // 2. Swap: remove the previous auto-pulled Walmart deals (keep any marked as top
  //    picks), then insert the fresh set. Only runs when we actually have new deals,
  //    so an API hiccup never leaves the grid empty.
  try {
    const del = await fetch(`${sbUrl}/rest/v1/deals?store=eq.Walmart&is_top_pick=eq.false`, {
      method: 'DELETE', headers: { ...sbHeaders, Prefer: 'return=minimal' },
    });
    console.log(`[sync-walmart] cleared previous Walmart deals -> HTTP ${del.status}`);
  } catch (e) { console.error('[sync-walmart] clear failed:', e.message); }

  // 3. Insert into Supabase
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const rows  = deals.map((d, i) => ({
    rank:         i + 1,
    name:         d.name,
    store:        'Walmart',
    category:     d.category,
    price:        d.price,
    was:          d.was,
    off:          d.off,
    rating:       d.rating  || 0,
    reviews:      d.reviews || 0,
    img:          d.img,
    images:       null,
    url:          d.url,
    code:         null,
    use_code_url: false,
    creator:      d.brand,
    brand:        d.brand,
    brand_name:   d.brandName || null,
    active_date:  today,
    is_top_pick:  false,
  }));

  const CHUNK  = 100;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const ins   = await fetch(`${sbUrl}/rest/v1/deals`, {
      method: 'POST', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify(chunk),
    });
    if (!ins.ok) { console.error(`[sync-walmart] insert chunk ${i} failed:`, await ins.text()); }
    else inserted += chunk.length;
  }

  console.log(`[sync-walmart] ✓ Inserted ${inserted} Walmart deals`);
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, added: inserted }),
  };
};
