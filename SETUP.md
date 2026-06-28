# Supabase + Rainforest API Setup

## Step 1 — Create Supabase tables

1. Go to your Supabase project → SQL Editor
2. Paste the entire contents of `supabase-schema.sql` and click Run
3. This creates three tables: `deals`, `email_subscribers`, `game_scores`

## Step 2 — Set environment variables in Netlify

Go to your Netlify site → Site Settings → Environment variables and add:

| Variable                  | Where to find it                                          |
|---------------------------|-----------------------------------------------------------|
| `SUPABASE_URL`            | Supabase → Settings → API → Project URL                  |
| `SUPABASE_ANON_KEY`       | Supabase → Settings → API → anon public key              |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → service_role key (secret) |
| `RAINFOREST_API_KEY`      | Your Rainforest API dashboard                             |
| `ADMIN_PASSWORD`          | Choose any strong password — this replaces the old one    |

After saving, trigger a new deploy (Deploys → Trigger deploy).

## Step 3 — Add your Supabase public keys to the HTML files

In **both** `founditcheaper-demo.html` and `founditcheaper-game.html`, find these two lines near the top of the `<script>` block and replace the placeholders:

```js
const SUPABASE_URL      = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
```

Use your **Project URL** and **anon public** key (NOT the service role key — that stays server-side only).

## Step 4 — Publish your first deals

1. Go to `founditcheaper-admin.html`
2. Sign in with the password you set in `ADMIN_PASSWORD`
3. Edit deals as needed, or paste an Amazon URL and click **Fetch** to auto-fill from Rainforest API
4. Click **🚀 Publish to Site** — deals save to Supabase and go live instantly

## How it works

- **Main page** loads deals from Supabase on every visit (falls back to hardcoded data if Supabase is unreachable)
- **Admin → Fetch** calls `/.netlify/functions/fetch-product` (Rainforest API key stays server-side)
- **Admin → Publish** calls `/.netlify/functions/save-deals` (validates your password server-side)
- **Email signups** (menu, game, grid) call `/.netlify/functions/subscribe` → stored in `email_subscribers`
- **Dice game leaderboard** is now shared across all users via Supabase `game_scores` table
