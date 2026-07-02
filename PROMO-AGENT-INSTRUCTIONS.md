# Promo Agent — direct deal import (no Chrome extension needed)

You are an AI agent with browser control (Playwright). Your job: pull promo-code deals
from **Erik's JoyLink Product Catalog** and post them to founditcheaper. You do **not** need the
"Quick Add" Chrome extension — it was just a UI wrapper around one API call. You scrape the deal
and POST it yourself, and you get the exact same server-side safety checks the extension got.

> **Source changed:** the old default was DealSeek. It is now **JoyLink** (Erik's own catalog) —
> no cooldown, no anti-bot poison, and it exposes clean Amazon links. Deals go INTO founditcheaper.
> They must **never** go into JoyLink — JoyLink is read-only, it is only where you read deals FROM.

## Your browser
- Use **your own dedicated browser**, the MCP server named **`browser-promo`**. Tools are
  `mcp__browser-promo__browser_*` (load via ToolSearch:
  `select:mcp__browser-promo__browser_navigate,mcp__browser-promo__browser_snapshot,mcp__browser-promo__browser_click,mcp__browser-promo__browser_evaluate`).
  If you don't see a `browser-promo` server, restart your Claude Code session.
- **First read the general rulebook:** `C:\Users\emsil\playwright-mcp\AGENT-INSTRUCTIONS.md`
  (don't turn on Chrome Sync, don't touch the finance blocklist, never move money, etc.).
- Your browser already has **Erik's Google and JoyLink logged in** — sessions persist.
- It's your own browser, so you can run at the same time as other agents.

## Your login / identity
- **Username:** `promo-agent`
- **Password:** the one Erik set in Netlify as `AGENT_PASSWORD` (he'll give it to you).
- You post with that password. Every deal you add is auto-tagged **"by Promo Agent"** so Erik
  can see which deals came from you. Use ONLY your own password — don't use Erik's or Kuldeep's.
- Your role is restricted (same as the VA): you can manage **Top Deal Picks** and **Imported
  Promo Code Deals** only. That's all you need.

## The one API call that adds a deal
POST JSON to: `https://founditcheaper.netlify.app/.netlify/functions/manage-code`

```json
{
  "password": "<AGENT_PASSWORD>",
  "action": "add",
  "amazon_link": "https://www.amazon.com/dp/<ASIN>",
  "promo_code": "SAVE20",
  "discount_price": "17.99",
  "retail_price": "29.99",
  "title": "Real product title from the JoyLink catalog card"
}
```
- `amazon_link` (required) must contain a real 10-char ASIN (`/dp/XXXXXXXXXX`).
- `promo_code`, `discount_price`, `retail_price`, `title` — optional but send them when you have them.
- **Response:** `{"ok":true,"instant":true}` = accepted. `{"ok":false,"skipped":true,...}` = the
  server rejected it (see safety below). `401` = wrong password.
- **Make this POST as a plain HTTP request** (your own HTTP tool / curl), NOT a browser `fetch`
  from the JoyLink page — that would be cross-origin and get CORS-blocked. Read in the browser,
  post over HTTP.

## Where to get deals — JoyLink Product Catalog
1. In `browser-promo`, go to: `https://joylink.io/dashboard/recommendations`
2. Make sure the **Full Catalog** tab is selected (complete list of all products).
3. Open **Advanced Filters** and set:
   - **Min discount = 10%**
   - **Promo Code** filter ON (promo-code deals only)
4. For each product tile, extract:
   - **amazon_link** — the tile links to a real Amazon URL; pull the ASIN from the
     `/dp/XXXXXXXXXX` in that link and build `https://www.amazon.com/dp/<ASIN>`.
     (JoyLink exposes the raw Amazon `/dp/` link directly — no `dealHash`, no redirect-following.)
   - **promo_code** — the code shown on the "Promo Code XXXX" chip.
   - **discount_price** — the after-code / lower price.
   - **retail_price** — the struck-through / higher price.
   - **title** — the product's real name (the product heading), never JoyLink marketing text.

Tip: `browser_snapshot` gives you the tile text + refs; or use `browser_evaluate` to read the
`a[href]` Amazon links and the price/code/title from each tile in one pass.

## Safety — what the server does automatically (so you don't have to)
- Deals come in **hidden (`pending`) for ~10 minutes**, then a scanner re-checks each one and
  either **publishes** it or **flags** it. Junk gets caught — don't stress about perfection.
- **Placeholder/junk titles are auto-rejected.** Banned title keywords (rejected everywhere):
  dealseek, joylink, koupon, coupert, slickdeals, dealnews, couponbirds, "capital one shopping",
  "we're building", "for smarter shopping". JoyLink shows real Amazon product titles, so just
  send the actual product name and you're fine.

## Good manners / don'ts
- JoyLink is Erik's own account with no anti-bot limits, so there's no cooldown — but stay
  reasonable. One deal at a time is fine.
- Don't re-add the same ASIN repeatedly — the server replaces an existing row for that ASIN, so a
  duplicate just refreshes it; there's no point spamming.
- Send the real after-code price as `discount_price` and the struck-through price as `retail_price`
  so the discount % is correct.

## Verify your work
- Log into the admin panel at `https://founditcheaper.netlify.app/founditcheaper-admin.html`
  with username `promo-agent` + your password to see the **All Imported Promo Code Deals** tab.
  Your deals show **"by Promo Agent"**. Use the **Live / Pending / Flagged** chips to see status.
- Deals you added appear on the live site under the **"Promo Codes Only"** filter once they clear
  the pending window and pass the scan.

That's it — read the JoyLink catalog, POST each deal with your password, done. The server handles the rest.
