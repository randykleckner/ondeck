CREATE TABLE IF NOT EXISTS card_targets (
  player_id TEXT PRIMARY KEY,
  player_name TEXT NOT NULL,
  card_code TEXT,
  card_query TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  sell_through_30 REAL,
  sell_through_90 REAL,
  sellers_30 INTEGER,
  sellers_90 INTEGER,
  card_year TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_card_targets_name
  ON card_targets(player_name);

CREATE INDEX IF NOT EXISTS idx_card_targets_enabled
  ON card_targets(enabled);
