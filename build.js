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

// ── Crawlable / AI-citable editorial block ──────────────────────────────────────
// The site renders deals client-side, so a non-JS crawler/AI sees an empty shell. We bake a
// small STATIC editorial block into index.html so crawlers/AI have real, citable text about
// what the site is.
//
// COMPLIANCE (important — do not reintroduce product data here):
// This block contains ONLY founditcheaper's own words. It bakes NO retailer product data at
// all — no Amazon or Walmart titles, images, prices, or ratings. Amazon's Product Advertising
// API license forbids (a) caching image content, or caching titles/text beyond 24h, and
// (b) "allow[ing] any third party to use Program Content to develop or improve large language
// or multimodal models" or "repurposing any Product Advertising Content." Since robots.txt
// intentionally lets AI crawlers (GPTBot, ClaudeBot, Perplexity, CCBot) read this page, putting
// Amazon product data into the static/crawlable HTML would hand Amazon's content to those
// models — a direct violation. So retailer deals stay CLIENT-SIDE and live, for human shoppers
// only; they are never baked into HTML. The page JS removes this block once the live grid renders.
function seoBlock() {
  const style = '<style>#seoDeals{max-width:1100px;margin:0 auto;padding:0 16px 26px;'
    + 'font-family:Inter,system-ui,sans-serif}#seoDeals h2{font-size:17px;color:#e8eef7;margin:0 0 12px}'
    + '#seoDeals p{color:#9fb3cc;font-size:13px;line-height:1.6;margin:0 0 10px}'
    + '#seoDeals a{color:#f5c842;text-decoration:none}</style>';
  return style + '<section id="seoDeals">'
    + '<h2>founditcheaper: real Amazon and Walmart deals, updated daily</h2>'
    + '<p>founditcheaper finds genuine discounts on Amazon and Walmart and puts them in one place, '
    + 'updated every day, with no hype. Categories include tools, electronics, home, kitchen, outdoor, '
    + 'automotive, and more. Every deal is checked before it goes up, and prices are shown live on each '
    + 'deal, never stored, so they stay current.</p>'
    + '<p>Learn who we are and how we find deals on our <a href="' + SITE + '/about.html">About and FAQ</a> '
    + 'page. Browse the live deals below.</p>'
    + '</section>';
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

  // Build the crawlable/AI editorial block (founditcheaper's own words only, no retailer
  // product data — see the COMPLIANCE note on seoBlock) and inject it into index.html.
  const seoHtml = seoBlock();
  console.log('[build] SEO editorial block baked into index.html (no retailer product data)');

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
