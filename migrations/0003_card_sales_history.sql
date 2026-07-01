CREATE TABLE IF NOT EXISTS card_sales_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_key TEXT NOT NULL,
  player_name TEXT NOT NULL,
  card_name TEXT,
  card_code TEXT,
  sale_date TEXT NOT NULL,
  sale_price REAL NOT NULL,
  sales_count INTEGER NOT NULL DEFAULT 1,
  listing_title TEXT,
  source_url TEXT,
  source_file TEXT,
  raw_json TEXT,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(player_key, card_code, sale_date, sale_price, listing_title)
);

CREATE INDEX IF NOT EXISTS idx_card_sales_history_player_date
  ON card_sales_history(player_key, sale_date);

CREATE INDEX IF NOT EXISTS idx_card_sales_history_card_date
  ON card_sales_history(card_code, sale_date);
