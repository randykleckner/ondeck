# OnDeck Prospect

Dark prospect forecasting dashboard for MLB Top 100 call-up signals, performance trends, organization pathway reads, and Bowman 1st Auto market edge.

## Run locally

This first version is static and dependency-free.

```sh
cd mlb-prospects
python3 -m http.server 5173
```

Then open `http://localhost:5173`.

The dashboard loads `data/mlb-top100-2026.csv` by default. That file was seeded from the official MLB/MiLB Top 100 Prospects page on June 26, 2026:

https://www.mlb.com/milb/prospects/top100/

Players are removed from the active watchlist once they have already been called up. The current first-pass rule excludes rows with `level = MLB`; imported files can also mark a player as called up with `called_up = true` or an `mlb_debut_date`.

## Import files

Use CSV files matching the templates in `data/`:

- `prospects-template.csv`: top prospect list and player profile fields
- `stats-template.csv`: current season and recent-form stats
- `depth-chart-template.csv`: organization opportunity and MLB-pathway inputs
- `card-market.csv`: eBay sold-comp output for Bowman Chrome Prospect Auto CPA cards shown inside player profiles

The app merges rows by `player_id`.

## Card market data

The homepage card-market section is a top-10 next call-up board. `data/card-market.csv` is only used inside the selected player profile's buy-zone panel and the exported score CSV. It should be generated from eBay sold-comp data, not manually seeded guesses.

The card target is the Bowman Chrome Prospect Auto code, for example Jesús Made is `CPA-JM`. Add exact code overrides to `data/card-targets.csv` when the generated initials are not enough.

Generate eBay sold comps with:

```sh
cd mlb-prospects
EBAY_ACCESS_TOKEN=your_oauth_token node scripts/update-ebay-comps.mjs
```

The updater searches eBay sold item sales for the CPA code, player name, `Chrome`, `Prospect`, and `Auto`, filters out bad title matches, then writes only players with returned sold comps. If no real eBay sold comps are returned, the script does not write a price for that player.

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

The script uses eBay API access rather than public sold-page scraping. Public eBay sold-search pages are frequently blocked or rate-limited in automated environments and should not be treated as a reliable data source.

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
