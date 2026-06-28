-- Click tracking for the self-hosted deep linker (netlify/functions/go.js).
-- Run this once in the Supabase SQL editor to enable your own click stats.
-- Until this table exists, the deep linker still works — clicks just aren't logged.

create table if not exists clicks (
  id         uuid primary key default gen_random_uuid(),
  asin       text not null,
  store      text not null default 'Amazon',
  source     text,                 -- optional channel tag (?s= on the /go link)
  referer    text,                 -- page the click came from
  ua         text,                 -- browser user-agent
  clicked_at timestamptz not null default now()
);

-- Fast lookups when you want per-product or per-day click counts.
create index if not exists clicks_asin_idx       on clicks (asin);
create index if not exists clicks_clicked_at_idx on clicks (clicked_at);

-- Example: top 20 clicked products in the last 7 days
--   select asin, count(*) as clicks
--   from clicks
--   where clicked_at > now() - interval '7 days'
--   group by asin
--   order by clicks desc
--   limit 20;
