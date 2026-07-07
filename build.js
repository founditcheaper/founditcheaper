// Build step: minify each top-level *.html into dist/ and copy static assets.
//
// "Light" minification — it collapses whitespace and compresses inline JS/CSS so
// the page source reads as a dense blob (a deterrent to casual copycats), but it
// deliberately does NOT rename top-level functions/variables:
//   - mangle.toplevel = false and compress.toplevel = false
//   - so global function names survive, and inline onclick="..." handlers in the
//     HTML keep pointing at functions that still exist. This is the key safety
//     measure for this site, which uses inline handlers heavily.
//
// If a file fails to minify for ANY reason, the original is copied through
// unchanged. A working site always beats a minified one — minification never
// gets to break the page.

const fs   = require('fs');
const path = require('path');
const { minify } = require('html-minifier-terser');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const SITE = 'https://founditcheaper.net';

// ── Crawlable / AI-citable snapshot ─────────────────────────────────────────────
// The site renders deals client-side, so a crawler/AI that doesn't run JS sees an empty
// shell. We bake a static list of the top deals into index.html at build time so AI engines
// and search can actually see and cite the deals. COMPLIANCE: only non-volatile fields go in
// (title, category, brand, image, on-site /?deal= link). Amazon price/availability are NEVER
// baked in (Associates/PA-API rule: no cached/stale prices) — they stay client-side-fresh.
// Walmart prices are OK (separate agreement). The JS on the page removes this block once the
// live grid renders, so shoppers only ever see the interactive grid.
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function readSupabaseCreds() {
  try {
    const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const url = (idx.match(/SUPABASE_URL\s*=\s*'([^']+)'/) || [])[1];
    const key = (idx.match(/SUPABASE_ANON_KEY\s*=\s*'([^']+)'/) || [])[1];
    return (url && key) ? { url, key } : null;
  } catch (e) { return null; }
}

async function fetchSeoDeals() {
  if (typeof fetch !== 'function') return null;
  const sb = readSupabaseCreds();
  if (!sb) return null;
  try {
    const q = sb.url + '/rest/v1/deals?select=id,name,category,brand_name,img,store,price'
      + '&review_status=eq.live&img=not.is.null&order=active_date.desc,rank&limit=200';
    const r = await fetch(q, { headers: { apikey: sb.key, Authorization: 'Bearer ' + sb.key } });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows)) return null;
    const seen = new Set(), out = [];
    for (const d of rows) {
      if (!d.img || !d.name) continue;
      const k = String(d.name).toLowerCase().slice(0, 60);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(d);
      if (out.length >= 100) break;
    }
    return out.length ? out : null;
  } catch (e) { console.warn('[build] SEO deals fetch failed:', e.message); return null; }
}

function seoBlock(deals) {
  const style = '<style>#seoDeals{max-width:1100px;margin:0 auto;padding:0 16px 26px;'
    + 'font-family:Inter,system-ui,sans-serif}#seoDeals h2{font-size:17px;color:#e8eef7;margin:0 0 12px}'
    + '#seoDeals ul{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}'
    + '#seoDeals li{background:rgba(255,255,255,.04);border-radius:10px;padding:10px}'
    + '#seoDeals a{display:flex;gap:10px;align-items:center;color:#e8eef7;text-decoration:none;font-size:13px;line-height:1.35}'
    + '#seoDeals img{width:52px;height:52px;object-fit:contain;background:#fff;border-radius:6px;flex-shrink:0}'
    + '#seoDeals .sd-m{display:block;font-size:11px;color:#9fb3cc;margin-top:6px}</style>';
  if (!deals || !deals.length) {
    return style + '<section id="seoDeals"><h2>Amazon and Walmart deals, updated daily</h2>'
      + '<p style="color:#9fb3cc;font-size:13px">Hundreds of hand-checked deals across tools, electronics, home, kitchen, and more. Browse the latest below.</p></section>';
  }
  const items = deals.map(function (d) {
    const url = SITE + '/?deal=' + encodeURIComponent(d.id);
    let priceTxt = '';
    if (d.store && d.store !== 'Amazon' && d.price != null && !isNaN(Number(d.price))) priceTxt = ' &middot; Walmart $' + Math.round(Number(d.price));
    const meta = [esc(d.category || ''), esc(d.brand_name || '')].filter(Boolean).join(' &middot; ') + priceTxt;
    return '<li><a href="' + url + '"><img src="' + esc(d.img) + '" alt="' + esc(d.name) + '" width="52" height="52" loading="lazy">'
      + '<span class="sd-t">' + esc(d.name) + '</span></a>' + (meta ? '<span class="sd-m">' + meta + '</span>' : '') + '</li>';
  }).join('');
  const ld = {
    '@context': 'https://schema.org', '@type': 'ItemList', name: 'founditcheaper deals',
    itemListElement: deals.map(function (d, i) {
      const p = { '@type': 'Product', name: String(d.name).slice(0, 150), url: SITE + '/?deal=' + d.id };
      if (d.img) p.image = d.img;
      if (d.category) p.category = d.category;
      if (d.brand_name) p.brand = { '@type': 'Brand', name: d.brand_name };
      return { '@type': 'ListItem', position: i + 1, item: p };
    }),
  };
  return style + '<section id="seoDeals"><h2>Today’s Amazon and Walmart deals on founditcheaper</h2><ul>'
    + items + '</ul></section>\n<script type="application/ld+json">' + JSON.stringify(ld) + '</script>';
}

const MINIFY_OPTS = {
  collapseWhitespace:  true,
  conservativeCollapse: true,  // collapse runs of whitespace to a single space — preserves inline layout
  removeComments:      true,
  minifyCSS:           true,
  minifyJS: {
    compress: { toplevel: false }, // never drop or move top-level (global) declarations
    mangle:   { toplevel: false }, // keep global names — inline HTML handlers depend on them
  },
};

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function run() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  // Copy static asset folders through unchanged (e.g. assets/logo.png)
  if (fs.existsSync(path.join(ROOT, 'assets'))) {
    copyDir(path.join(ROOT, 'assets'), path.join(DIST, 'assets'));
  }

  // Copy root-level static files (served verbatim at the site root, e.g. /robots.txt)
  for (const f of ['robots.txt', 'sitemap.xml']) {
    if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(DIST, f));
  }

  // Build the crawlable/AI deal snapshot once, inject it into index.html's placeholder.
  const seoDeals = await fetchSeoDeals();
  const seoHtml = seoBlock(seoDeals);
  console.log(`[build] SEO snapshot: ${seoDeals ? seoDeals.length : 0} deals baked into index.html`);

  // Minify every top-level .html file into dist/
  const htmlFiles = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
  let minified = 0, copied = 0;
  for (const file of htmlFiles) {
    let src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (file === 'index.html') src = src.replace('<!--SEO_DEALS-->', seoHtml);
    let out;
    try {
      out = await minify(src, MINIFY_OPTS);
      minified++;
    } catch (e) {
      console.warn(`[build] minify failed for ${file} (${e.message}) — copying original unchanged`);
      out = src;
      copied++;
    }
    fs.writeFileSync(path.join(DIST, file), out);
  }

  console.log(`[build] done: ${minified} minified, ${copied} copied as-is -> dist/`);
}

run().catch(e => { console.error('[build] fatal:', e); process.exit(1); });
