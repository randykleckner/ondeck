CREATE TABLE IF NOT EXISTS market_sold_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  player_name TEXT NOT NULL,
  benchmark_card_code TEXT,
  canonical_query TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'SoldComps API',
  title TEXT,
  sold_price REAL NOT NULL,
  sold_at TEXT NOT NULL,
  item_url TEXT,
  item_id TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  raw_json TEXT,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_market_sold_records_player_sold_at
  ON market_sold_records(player_id, sold_at);

CREATE TABLE IF NOT EXISTS active_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  player_name TEXT NOT NULL,
  benchmark_card_code TEXT,
  canonical_query TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'SoldComps API',
  title TEXT,
  asking_price REAL,
  shipping_price REAL,
  total_ask_price REAL,
  listing_type TEXT,
  item_url TEXT,
  item_id TEXT,
  seller_username TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  raw_json TEXT,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_active_listings_player_observed
  ON active_listings(player_id, observed_at);

CREATE TABLE IF NOT EXISTS market_player_snapshots (
  player_id TEXT PRIMARY KEY,
  player_name TEXT NOT NULL,
  team TEXT,
  rank INTEGER,
  benchmark_card_code TEXT,
  canonical_query TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'SoldComps API',

  sales_count_30d INTEGER,
  sales_count_90d INTEGER,
  avg_sold_price_30d REAL,
  avg_sold_price_90d REAL,
  median_sold_price_30d REAL,
  median_sold_price_90d REAL,
  low_sold_price_30d REAL,
  high_sold_price_30d REAL,
  low_sold_price_90d REAL,
  high_sold_price_90d REAL,
  last_sold_price REAL,
  last_sold_at TEXT,

  active_listing_count INTEGER,
  active_lowest_ask REAL,
  active_median_ask REAL,
  active_highest_ask REAL,
  active_auction_count INTEGER,
  active_buy_it_now_count INTEGER,
  active_data_updated_at TEXT,
  active_listing_supported INTEGER NOT NULL DEFAULT 0,

  sell_thru_rate_30d REAL,
  sell_thru_rate_90d REAL,
  sold_refreshed_at TEXT,
  checked_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  raw_summary_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_market_player_snapshots_checked
  ON market_player_snapshots(checked_at);
