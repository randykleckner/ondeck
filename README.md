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
- `card-market.csv`: Bowman 1st Auto sales comps, buy zones, market signal, and eBay sold-search links

The app merges rows by `player_id`.

## Card market data

`data/card-market.csv` powers the Card Market Edge board, each player card's buy-zone panel, and the exported score CSV. These are manual/imported comps unless a live market-data job is wired in. Treat rows marked `Seed comp` as placeholders that need verification before making buy/sell decisions.

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

For reliable live data, export sold/completed Bowman auto comps into this CSV from a trusted source such as Sports Card Investor, Card Ladder, Market Movers, or an eBay API job that writes the same columns.

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
