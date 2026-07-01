# OnDeck Prospect

Dark prospect catalyst dashboard for MLB Top 100 prospects, organization prospects, performance trends, pathway reads, and Bowman 1st Auto market context.

## Run locally

This first version is static and dependency-free.

```sh
cd mlb-prospects
python3 -m http.server 5173
```

Then open `http://localhost:5173`.

The dashboard loads `data/mlb-top100-2026.csv` by default, then optionally merges `data/org-prospects.csv` for organization Top 30, breakout, or catalyst prospects outside the Top 100. The Top 100 file was seeded from the official MLB/MiLB Top 100 Prospects page on June 26, 2026:

https://www.mlb.com/milb/prospects/top100/

Players are removed from the active watchlist once they have already been called up. The current first-pass rule excludes rows with `level = MLB`; imported files can also mark a player as called up with `called_up = true` or an `mlb_debut_date`.

## Import files

Use CSV files matching the templates in `data/`:

- `prospects-template.csv`: top prospect list and player profile fields
- `stats-template.csv`: current season and recent-form stats
- `depth-chart-template.csv`: organization opportunity and MLB-pathway inputs
- `org-prospects.csv`: optional non-Top-100 prospect universe for War Rooms and On Deck evaluation
- `card-market.csv`: generated eBay sold-comp output for Bowman Chrome Prospect Auto CPA cards shown inside player profiles
- `card-market-manual.csv`: weekly manual comps that override generated rows

The app merges rows by `player_id`.

## Team war room

Break Board and Team War Room are secondary top-nav tools, not default landing-page sections. Open the Break Board tab to choose a team, or use the compact Team War Room panel inside a player profile. The war room renders a depth-chart board by role, stacks named MLB blockers above the prospects up next, highlights injury/opening context, and lets you click a prospect card to jump into that player's full profile.

## Card market data

The homepage card-market section is the On Deck Board. Selected On Deck player profiles load card-market pricing from the secure SoldComps API proxy. Stale manual comp rows are not shown as current market data.

`data/card-targets.csv` stores only search targets and card-code hints for the API. It does not store prices. The card target is the Bowman Chrome Prospect Auto code, for example Jesús Made is `CPA-JM`. Add exact code overrides to `data/card-targets.csv` when the generated initials are not enough.

## Secure SoldComps API proxy

The browser calls our own endpoint:

```sh
GET /api/market-data?player=Felnin%20Celesten
```

The repo includes both supported serverless entry points:

- `worker/index.js` plus `wrangler.jsonc` for Cloudflare Workers with Static Assets
- `api/market-data.js` for Vercel
- `functions/api/market-data.js` for Cloudflare Pages
- `netlify/functions/market-data.js` plus `netlify.toml` for Netlify

Set this environment variable in the deployment host:

```sh
SOLD_COMPS_API_KEY=your_soldcomps_key
```

For Cloudflare Workers with Static Assets, this repo must deploy with `wrangler.jsonc` and `worker/index.js`; that Worker intercepts `/api/market-data` and serves all other static files from `env.ASSETS`. Add `SOLD_COMPS_API_KEY` as a Worker variable/secret after the Worker entrypoint is active. For Cloudflare Pages, add it in Project Settings -> Environment variables. For Vercel, add it in Project Settings -> Environment Variables. For Netlify, add it in Site configuration -> Environment variables. The local `.env` file is useful for local tooling, but the hosted site cannot read a root `.env` file unless the host imports it into deployment environment variables.

The function sends `Authorization: Bearer <key>` to SoldComps and calls:

```sh
https://api.sold-comps.com/v1/scrape?keyword=[Player Name]+Bowman+Chrome+1st+Auto
```

The frontend sends only the player name to `/api/market-data`. Backend code builds the canonical search query, URL-encodes it, filters out non-benchmark card titles such as refractors, color, numbered cards, paper, lots, breaks, digital, reprints, and custom cards, then summarizes last sale, 7/14/30-day averages, sales counts, optional active listings, buy zone, and recommendation. The API key is never included in browser code.

Market-data responses are cached server-side for one week per player/search keyword. On Cloudflare Workers, the first request for a player in a weekly cache window may call SoldComps; repeat clicks and visitors should reuse the cached JSON and avoid spending additional SoldComps quota.

When running as a plain static site with `python3 -m http.server`, `/api/market-data` will not exist. The profile will show that SoldComps is unavailable instead of falling back to older manual comps. Run through Vercel or `vercel dev` to test live market data.

Generate cleaner eBay sold comps with API access:

```sh
cd mlb-prospects
EBAY_ACCESS_TOKEN=your_oauth_token node scripts/update-ebay-comps.mjs
```

Or run a best-effort public web scrape when you do not have an API token:

```sh
cd mlb-prospects
CARD_COMP_SOURCE=web node scripts/update-ebay-comps.mjs
```

For a smaller scrape test:

```sh
cd mlb-prospects
CARD_COMP_SOURCE=web CARD_COMP_TARGET_IDS=mlb-top100-1 node scripts/update-ebay-comps.mjs
```

The updater searches eBay sold item sales for the CPA code, player name, `Chrome`, `Prospect`, and `Auto`, filters out bad title matches, then writes only players with returned sold comps. If no real sold comps are returned, the script does not write a price for that player.

Manual weekly comps should be entered in `data/card-market-manual.csv` using the same fields below. Keep `data_source` descriptive, such as `Manual weekly comps`, so profile cards show where the market read came from.

To write `data/card-market.csv` only from your manual weekly file:

```sh
cd mlb-prospects
CARD_COMP_SOURCE=manual node scripts/update-ebay-comps.mjs
```

The current fields are:

- `card_name`
- `card_code`
- `last_sale`
- `last_sale_date`
- `avg_7`, `avg_30`, `avg_90`
- `sales_30`
- `active_listings`
- `sell_through`
- `buy_low`, `buy_high`
- `market_signal`
- `market_note`
- `data_source`
- `source_url`
- `last_updated`

`CARD_COMP_SOURCE=auto` is the default. It uses the API when `EBAY_ACCESS_TOKEN` is present and falls back to public web scraping when it is not. Public eBay sold-search pages are frequently blocked or rate-limited in automated environments, so scraped rows are useful directional comps but should not be treated as perfect market data.

## Enrich data

Generate current stat and pathway overlays from MLB's public Stats API:

```sh
cd mlb-prospects
node scripts/enrich-prospects.mjs
```

This writes:

- `data/player-enrichment.csv`
- `data/current-stats.csv`
- `data/depth-chart-current.csv`
- `data/enrichment-report.json`

The dashboard loads these overlays automatically when they exist.

## Current model

Call-up chance is a 0-100 blend of:

- performance: current production, recent form, level, and age-to-level
- opportunity: MLB roster need, organization depth, 40-man status, and active blockers
- readiness: top-100 rank signal, level proximity, and whether the org has incentive to promote

Color bands:

- green: 60% or better
- yellow: 50-59%
- red: 49% or below

The model is not meant to be final. It is meant to be readable, tunable, and good enough for the first version of player cards.
