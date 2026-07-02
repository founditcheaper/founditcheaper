# SEO Go-Live Checklist — run this when the custom domain is connected

Everything in this `seo/` folder is **staged and inert** — it does nothing until the
steps below are done. Purpose: make sure Google/AI only ever see **founditcheaper.net**,
never the temporary `founditcheaper.netlify.app` URL. Do NOT do any of this while you're
still testing on the netlify.app URL.

> Before starting, confirm two values used in the staged files:
> - Custom domain is **founditcheaper.net** (find/replace if different)
> - Instagram URL in `head-additions.html` is your exact handle

## Order of operations
1. **Connect the domain in Netlify** and set founditcheaper.net as the **primary** domain
   (Netlify → Domain management). Verify the live site loads on founditcheaper.net and works.

2. **Publish robots + sitemap** — move the two staged files to the site root so they serve
   at `/robots.txt` and `/sitemap.xml`:
   - `seo/robots.txt`  →  `robots.txt`
   - `seo/sitemap.xml` →  `sitemap.xml`

3. **Add the head tags** — paste both blocks from `seo/head-additions.html` into the
   `<head>` of `index.html`, and update the existing social tags from the netlify URL to
   the real domain:
   - `og:url` → `https://founditcheaper.net/`
   - `og:image` / `twitter:image` → `https://founditcheaper.net/assets/og-banner.png`

4. **Redirect the old netlify URL → the domain** (one canonical host). Add to `netlify.toml`.
   ⚠️ Do NOT add this until the domain is live — it would redirect the site you're currently
   testing on.
   ```toml
   [[redirects]]
     from = "https://founditcheaper.netlify.app/*"
     to = "https://founditcheaper.net/:splat"
     status = 301
     force = true
   ```

5. **Deploy** (push to main).

6. **Google Search Console** (https://search.google.com/search-console):
   - Add a property for **founditcheaper.net** and verify it.
   - Submit `https://founditcheaper.net/sitemap.xml`.
   - (Optional) Add the netlify.app property too and use "Change of Address" if it ever
     got indexed.

7. **Optional perf tidy:** remove the three `no-cache` / `Pragma` / `Expires` `<meta>` tags
   near the top of `index.html` (lines ~15–17) so browsers can cache the page. Skip if you
   prefer forcing fresh HTML on every deploy.

## What was intentionally left out (and why)
- **Per-product Product/Offer structured data with Amazon prices** — omitted on purpose.
  Amazon's Associates agreement restricts displaying/caching Amazon prices outside their
  live API, and Google caches structured-data prices. Safe to add a **Walmart-only** product
  feed later if we want richer results.
- **A sitemap/canonical pointing at the netlify.app URL** — never do this; it would get the
  temporary URL indexed and create a migration mess.

## Bigger SEO win for later (separate project)
The deals load via JavaScript, so crawlers/AI see an almost-empty page. The high-impact
(but larger) fix is **pre-rendering the deals into the HTML** so Google's first pass and
AI crawlers actually see them. Plus unique content (deal roundups, buying guides) is what
actually ranks for affiliate sites.
