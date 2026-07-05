# founditcheaper — Home Depot Deal Finder

## Your job
Pull good Home Depot deals and add them to founditcheaper.net **by hand** through the admin's manual-add form. Home Depot has no API, so there's no auto-import — you find the deal, generate its affiliate link, and type it in.

## Your browser
You have your own dedicated Chrome: MCP server **`browser-homedepot`** (tools `mcp__browser-homedepot__browser_*`; load via ToolSearch: `select:mcp__browser-homedepot__browser_navigate,mcp__browser-homedepot__browser_snapshot,mcp__browser-homedepot__browser_click,mcp__browser-homedepot__browser_evaluate`). If you don't see the server, restart your session — it was just added. It reaches homedepot.com, the founditcheaper admin, GitHub, and Mavely's web dashboard, and starts with Erik's Google login. Erik logs into anything gated by hand; never type or store a password.

**First read the general rulebook:** `C:\Users\emsil\playwright-mcp\AGENT-INSTRUCTIONS.md` (no Chrome Sync, don't touch the finance blocklist, never move money, ask before saving a login).

## Generating the Mavely affiliate link — READ THIS
Your automated browser **cannot run the Mavely Chrome extension** — Playwright's Chrome ignores extensions (same wall we hit with the old founditcheaper Quick-Add extension). So do NOT rely on the extension. Instead:
1. **Preferred — Mavely web dashboard:** log into Mavely on the web (Erik signs in once, by hand), paste the Home Depot product URL into Mavely's "create link" / link-generator tool, and copy the generated Mavely link. That copied link is the buy link.
2. **If Mavely turns out to be extension-only (no web or API link generator):** you can't mint the link yourself — collect the product details and have Erik generate the Mavely links (or set up a workable path), then paste them in. Flag this to Erik early; don't post un-monetized raw Home Depot links as a workaround.

The Mavely link is how Erik gets paid, so never substitute a plain Home Depot URL when a Mavely link is available.

## Where the deals come from
Primary source — Home Depot **Special Values** page:
`https://www.homedepot.com/b/Special-Values/N-5yc1vZ7`
That's Home Depot's curated sale/clearance page. Work from there.

## Quality rules — DO NOT break these
1. **Minimum 20% off.** Skip anything under 20% off (compute it from deal price vs. list/original price). Under 20% never goes up.
2. **No duplicates or near-duplicates.** If two deals are the same or a very similar product (e.g. two similar drills, two similar contractor-bag packs), add **only ONE** — the better pick (better price/discount, higher rating, or the more useful size/version). Never post both.
3. **Variety across categories.** Spread your picks across Home Depot's departments — tools, appliances, patio / lawn & garden, home, storage/organization, etc. Don't load up on one category. Home Depot's range is limited, so consciously vary it.

Only add real, in-stock deals. Skip anything that looks mispriced, out of stock, or store-pickup-only if it can't ship.

## How to add each deal
1. On the Special Values page, open a qualifying product (>= 20% off, not a near-dupe of one you already added).
2. Collect:
   - **Product title**
   - **Image URL** — right-click the product image → *Copy image address* (a `thdstatic.com` URL)
   - **Deal price** and **List price (was)**
   - **Category** (best-fit department)
3. Generate the **Mavely affiliate link** via Mavely's web dashboard (see "Generating the Mavely affiliate link" above) — NOT the browser extension, which won't run in your automated browser. That Mavely link is the buy link.
4. Go to the admin: `founditcheaper.net/founditcheaper-admin.html` → **Promo & Seller Deals** tab → the blue **"Add a deal manually (Home Depot, Best Buy, Lowe's)"** box.
5. Fill it in: **Store** = Home Depot, **Category**, **Product title**, **Product link** = the Mavely link, **Image URL**, **Deal price**, **List price (was)**, **Promo code** (only if there is one). Click **+ Add Manual Deal**.
6. It goes live on the site immediately, tagged Home Depot, and shows under the Home Depot filter. The buy button uses your Mavely link exactly, so you get the commission.

## Rules of the road
- **Never handle passwords / logins.** If the admin or Home Depot asks you to log in, ask Erik. Never put a password in chat, a file, or the repo.
- Your browser is `browser-homedepot` (see "Your browser" above). If Mavely can't make a link for a product, skip it or flag Erik.
- Brand voice is deadpan and plain: no hype words, no exclamation points, no em dashes. Keep titles as they read on Home Depot.

## The bar, in one line
Every deal you add is **20%+ off, not a repeat of something already up, and adds category variety** — otherwise skip it.
