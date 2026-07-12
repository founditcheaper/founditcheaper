# founditcheaper.net — Project Context for Claude Code

## Who I Am
- **Name:** Erik
- **Business:** founditcheaper.net (operated under MiscMore LLC)
- **Location:** Rio Grande Valley (RGV), South Texas
- **Brand voice:** Deadpan, blue-collar, no hype words, no exclamation points
- **Audience:** Male, ~30–45, blue-collar, deal-hunters
- **Social:** ~855K Instagram followers, ~2,900 Beehiiv email subscribers
- **Monetization:** Amazon affiliate commissions (tag: `founditchea09-20`), Creator Connections, Mavely

## What This Project Is
A fully automated deals aggregation website that pulls real deals via APIs, stores them in Supabase, and displays them on a dark navy/gold branded frontend. The goal is **zero manual deal uploading** except for manually curated "Top Picks."

---

## Tech Stack

| Layer | Tool |
|---|---|
| Frontend | Single HTML file (`index.html`) — vanilla JS, no framework |
| Hosting | Netlify (connected to GitHub, auto-deploys on push) |
| Database | Supabase (PostgreSQL) |
| Deal Data | Amazon Creators API (PA-API) — sole source. Account eligible on sales, awaiting the post-credential review window (created 2026-06-28). Deal-discovery still needs building on the Amazon search endpoint. |
| Deal Data (removed) | Rainforest API — REMOVED 2026-06-29 for Amazon Associates compliance. Do not re-add. |
| Deep Linking | Self-hosted: `/go/<ASIN>` Netlify function adds the affiliate tag and redirects. (Joylink retired for Amazon.) |
| Email | Beehiiv (~2,900 subscribers) |
| Repo | GitHub: `founditcheaper/founditcheaper` |
| Functions | Netlify Functions (`netlify/functions/sync-deals.js`) |

---

## Repository Structure

```
founditcheaper/
├── index.html                  # Main site (dark navy/gold, vanilla JS)
├── founditcheaper-game.html    # Daily Dice Roll game page
├── founditcheaper-admin.html   # Admin panel for managing top picks
├── netlify.toml                # Netlify config (functions dir, hourly cron)
├── CLAUDE.md                   # This file
└── netlify/
    └── functions/
        └── sync-deals.js       # Deal sync function (runs hourly)
```

---

## Live Site
`https://founditcheaper.netlify.app`

## GitHub Repo
`https://github.com/founditcheaper/founditcheaper`

---

## Environment Variables (stored in Netlify)

```
SUPABASE_URL=https://kvscvenwhdfwiswcfmxq.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<secret>
SUPABASE_ANON_KEY=<public — also in frontend HTML>
# RAINFOREST_API_KEY — REMOVED 2026-06-29 (delete this env var in Netlify; cancel the subscription)
AMAZON_CREATORS_CLIENT_ID=<secret>
AMAZON_CREATORS_CLIENT_SECRET=<secret>
ADMIN_PASSWORD=<secret>
```

---

## Supabase Database

**Project:** `founditcheaper amazon api`
**URL:** `https://kvscvenwhdfwiswcfmxq.supabase.co`
**RLS:** ON for `deals` — policy "Public reads" allows SELECT only; no public write policy, so the anon key can read but not insert/update/delete. Writes happen via Netlify Functions using the service_role key, which bypasses RLS. (Verified live 2026-06-28.)
**Using:** legacy `service_role` key for server-side writes

**Table: `deals`**

```sql
id uuid default gen_random_uuid() primary key
asin text unique not null
title text not null
image text
price numeric not null
was numeric
percent_off integer
deal_type text
deal_badge text
ends_at timestamptz
amazon_url text
affiliate_url text        -- currently Joylink, will be self-hosted
category text
store text default 'Amazon'
is_active boolean default true
created_at timestamptz default now()
updated_at timestamptz default now()
```

---

## What's Already Done

### Frontend (`index.html`) — COMPLETE
- Dark navy/gold branding, banana mascot logo
- Header: logo + search bar + hamburger menu (centered, max-width 1200px)
- Search bar: fully wired and filtering deals
- Top Deal Picks carousel (horizontal swipe, grouped by date, collapsible)
- All Deals grid with infinite scroll
- Filters: discount % chips, price range slider (fires on mouse release only), min rating, store, category, promo code toggle, brand toggle — all working
- Sort: Top Rated, Biggest Discount, Lowest Price, Newest
- Product drawer: full details, promo code copy, share deal, buy button
- Hamburger menu: Contact Us modal, Report a Bug modal, Legal & Disclaimer modal, Dice game link, Newsletter signup
- Cards: pricing pinned to bottom, promo code above % off, no "Tap for details"
- Share Deal / Copy Code: clipboard fallback for non-HTTPS
- Frontend wired to Supabase (live data, not dummy data)

### Admin Panel (`founditcheaper-admin.html`) — COMPLETE
- Wired to Supabase
- Manage Top Deal Picks (drag to reorder, undo history)
- Auto-Picker settings, brand list, category filters, schedule
- Password: stored ONLY in the Netlify env var `ADMIN_PASSWORD` — never write it in any committed file.

### Infrastructure — COMPLETE
- GitHub repo connected to Netlify (auto-deploy on push)
- Supabase `deals` table created
- Netlify environment variables set (Supabase, Amazon Creators)
- `sync-deals.js` Netlify Function deployed (daily cron, 6 AM UTC)

---

## What's Pending (Priority Order)

### 1. Amazon Creators API / PA-API (HIGHEST PRIORITY — sole deal source)
- Credential ACTIVE (created 2026-06-28). Token works; getItems returns `AssociateNotEligible` (HTTP 403).
- Account meets all criteria (17,602 sales/30d, Platinum) — only the post-credential review window (up to 48h) remains; expected to clear ~2026-06-30.
- Rainforest REMOVED 2026-06-29 (compliance). There is now NO fallback — the site rides entirely on Amazon.
- **Still to build:** Amazon-native deal *discovery* (search by min discount) to replace what Rainforest did — `discoverDeals()` stub in `sync-deals.js`. Without it, no new deals flow in even once eligible.
- Amazon affiliate tag: `founditchea09-20`

### 2. Self-Hosted Deep Linking (replace Joylink)
- Currently using Joylink (~$300/month) for affiliate deep linking
- Plan: build self-hosted solution at `deal.founditcheaper.net`
- All product links route through this instead of Joylink
- Priority: do this before adding more retailers

### 3. Walmart API
- Best route: `walmart.io` (Walmart's official developer portal)
- Free public API
- Add after Amazon PA-API is confirmed working

### 4. Additional Retailers (after Walmart)
- Best Buy → free public API
- Home Depot → BigBox API (available under Rainforest account's "More APIs")
- Target → RedCircle API (available under Rainforest account's "More APIs")
- All links route through self-hosted deep linker

### 5. Daily Dice Roll Game Backend
- Game page (`founditcheaper-game.html`) is built but has NO backend
- Needs Supabase tables: players, rolls, prizes, winners
- Player identification: localStorage UUID (no login required)
- Optional email registration tied to player ID
- Admin controls needed: set prize per date, view leaderboard, pick winner, export emails
- One roll per day enforced via Supabase check
- Back button in game still links to old filename — needs updating to `index.html`

### 6. Chrome Extension (Backlog)
- One-click deal adding from Amazon product pages
- Scrapes: ASIN, title, image, price, discount
- Posts directly to Supabase
- Generates deep link automatically
- Two buttons: Save to Drafts / Publish to Top Picks

---

## API Notes

### Amazon Creators API / PA-API (Sole deal source)
- Auth: OAuth client-credentials (`AMAZON_CREATORS_CLIENT_ID`/`_SECRET`) → token → `getItems`
- getItems endpoint: `https://creatorsapi.amazon/catalog/v1/getItems`; token endpoint: `https://api.amazon.com/auth/o2/token`
- Returns: ASIN, title, image(s), price, discount/dealDetails, rating, reviews
- `AssociateNotEligible` arrives as a top-level `reason` on a 403 (NOT in `errors[]`) — handle both
- Used in: `fetch-product.js`, `save-deals.js`, `sync-deals.js` enrichment

### Rainforest API — REMOVED 2026-06-29
- Removed entirely for Amazon Associates compliance (third-party scraping of Amazon price/availability is a TOS risk). Do NOT re-add.
- Deleted: `backfill-images-background.js`, `backfill-ratings-background.js`. Stripped from all other functions.
- Action items: delete `RAINFOREST_API_KEY` from Netlify env vars; cancel the Rainforest subscription.

### Deep Linking — Self-hosted (Joylink retired for Amazon)
- `/go/<ASIN>` Netlify function (`go.js`) validates the ASIN, adds the `founditchea09-20` tag, logs the click, and 302-redirects to Amazon
- No Joylink for Amazon links

### Supabase
- RLS is ON for `deals` (public read only; no public write — verified live 2026-06-28)
- Public read on deals table is intentional
- `email_subscribers` and `game_scores` tables don't exist in Supabase yet; the correct RLS for them is already written in `supabase-schema.sql` and gets created when those features go live (subscribers currently live in Beehiiv)

---

## Brand & Content Rules
- No exclamation points ever
- No hype words (amazing, incredible, don't miss, etc.)
- Phrasing: "Amazon has a/these [item]"
- Prices rounded to whole dollars
- Promo codes: space between "code" and the code (e.g., "code SAVE20")
- Fonts: thin sans-serif
- Logo: circular, full color banana mascot
- Deadpan humor throughout
- Target demographic: male, blue-collar, ~30–45

---

## Notes for Claude Code
- Always push changes to GitHub — Netlify auto-deploys from main branch
- Never hardcode API keys — always use `process.env.VARIABLE_NAME`
- Site is a single HTML file — keep it that way unless there's a strong reason not to
- Erik is non-technical — explain what you're doing in plain language
- Ask before making any changes that affect the live site
