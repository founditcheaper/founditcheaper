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

  // Minify every top-level .html file into dist/
  const htmlFiles = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
  let minified = 0, copied = 0;
  for (const file of htmlFiles) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
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
