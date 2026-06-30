// One-time backfill: re-tag every deal's `category` from its title using the
// current Amazon-department category logic. Admin-gated, runs in the background
// (up to 15 min). Triggered by the "Re-categorize all" button in the admin panel.

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

exports.handler = async function (event) {
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}
  if (!process.env.ADMIN_PASSWORD || body.password !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, body: 'Unauthorized' };
  }
  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, body: 'Supabase not configured' };
  const sb = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  const start = Date.now();
  let offset = 0, pageSize = 1000, scanned = 0, updated = 0, done = false;
  while (!done) {
    if (Date.now() - start > 13 * 60 * 1000) { console.log('[recategorize] time cap'); break; }
    const res = await fetch(`${sbUrl}/rest/v1/deals?select=id,name,category&order=id.asc&limit=${pageSize}&offset=${offset}`, { headers: sb });
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      scanned++;
      const newCat = inferCategory(r.name || '');
      if (newCat && newCat !== r.category) {
        await fetch(`${sbUrl}/rest/v1/deals?id=eq.${encodeURIComponent(r.id)}`, {
          method: 'PATCH', headers: { ...sb, Prefer: 'return=minimal' }, body: JSON.stringify({ category: newCat }),
        }).catch(() => {});
        updated++;
      }
    }
    if (rows.length < pageSize) done = true; else offset += pageSize;
  }
  console.log(`[recategorize] scanned=${scanned} updated=${updated}`);
  return { statusCode: 200, body: JSON.stringify({ ok: true, scanned, updated }) };
};
