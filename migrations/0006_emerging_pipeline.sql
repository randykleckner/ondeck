-- Emerging research board schema.
-- The existing card_targets table is the Top 100 card-code cache, so Emerging
-- uses emerging_card_targets to avoid breaking live market data reads.

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  mlbam_id INTEGER,
  current_team TEXT,
  current_org TEXT,
  position TEXT,
  bats TEXT,
  throws TEXT,
  birth_date TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS emerging_card_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER,
  year INTEGER,
  product TEXT,
  auto_set TEXT,
  auto_code TEXT,
  card_number TEXT,
  player_name_on_card TEXT,
  team_on_card TEXT,
  card_query_seed TEXT,
  source_url TEXT,
  include_in_emerging INTEGER DEFAULT 1,
  active INTEGER DEFAULT 1,
  notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_emerging_card_targets_player_card
  ON emerging_card_targets(player_id, year, product, auto_code);

CREATE INDEX IF NOT EXISTS idx_emerging_card_targets_active
  ON emerging_card_targets(include_in_emerging, active);

CREATE TABLE IF NOT EXISTS player_tracking_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER,
  tracking_group TEXT,
  priority_tier TEXT,
  status TEXT,
  last_reviewed_at TEXT,
  next_refresh_due TEXT,
  notes TEXT,
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_player_tracking_status_player
  ON player_tracking_status(player_id);

CREATE INDEX IF NOT EXISTS idx_player_tracking_status_board
  ON player_tracking_status(tracking_group, status, priority_tier);

CREATE TABLE IF NOT EXISTS player_stats_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER,
  season INTEGER,
  stats_role TEXT,
  level TEXT,
  team TEXT,
  age REAL,
  hitter_games INTEGER,
  hitter_pa INTEGER,
  hitter_ab INTEGER,
  hitter_avg REAL,
  hitter_obp REAL,
  hitter_slg REAL,
  hitter_ops REAL,
  hitter_hr INTEGER,
  hitter_sb INTEGER,
  hitter_bb INTEGER,
  hitter_so INTEGER,
  hitter_bb_pct REAL,
  hitter_k_pct REAL,
  pitcher_games INTEGER,
  pitcher_ip REAL,
  pitcher_era REAL,
  pitcher_whip REAL,
  pitcher_so INTEGER,
  pitcher_bb INTEGER,
  pitcher_bf INTEGER,
  pitcher_k_pct REAL,
  pitcher_bb_pct REAL,
  pitcher_k_minus_bb_pct REAL,
  stats_match_status TEXT,
  stats_source TEXT,
  snapshot_date TEXT,
  raw_payload_json TEXT,
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_player_stats_snapshots_unique
  ON player_stats_snapshots(player_id, season, stats_role, level, team, snapshot_date);

CREATE INDEX IF NOT EXISTS idx_player_stats_snapshots_latest
  ON player_stats_snapshots(player_id, snapshot_date);

CREATE TABLE IF NOT EXISTS emerging_prescore_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER,
  card_target_id INTEGER,
  emerging_pre_score REAL,
  performance_score REAL,
  age_level_score REAL,
  playing_time_score REAL,
  level_score REAL,
  trend_proxy_score REAL,
  pre_tier TEXT,
  pre_score_notes TEXT,
  snapshot_date TEXT,
  source_workbook TEXT,
  FOREIGN KEY (player_id) REFERENCES players(id),
  FOREIGN KEY (card_target_id) REFERENCES emerging_card_targets(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_emerging_prescore_unique
  ON emerging_prescore_snapshots(player_id, card_target_id, snapshot_date);

CREATE INDEX IF NOT EXISTS idx_emerging_prescore_score
  ON emerging_prescore_snapshots(pre_tier, emerging_pre_score);

CREATE TABLE IF NOT EXISTS card_market_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER,
  card_target_id INTEGER,
  source TEXT,
  sales_count_7d INTEGER,
  sales_count_30d INTEGER,
  sales_count_90d INTEGER,
  avg_price_7d REAL,
  avg_price_30d REAL,
  avg_price_90d REAL,
  median_price_30d REAL,
  median_price_90d REAL,
  low_sold_30d REAL,
  high_sold_30d REAL,
  last_sold_price REAL,
  last_sold_at TEXT,
  active_listing_count INTEGER,
  active_lowest_ask REAL,
  active_median_ask REAL,
  sell_through_30d REAL,
  sell_through_90d REAL,
  market_signal TEXT,
  snapshot_date TEXT,
  raw_payload_json TEXT,
  FOREIGN KEY (player_id) REFERENCES players(id),
  FOREIGN KEY (card_target_id) REFERENCES emerging_card_targets(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_card_market_snapshots_unique
  ON card_market_snapshots(player_id, card_target_id, source, snapshot_date);

CREATE INDEX IF NOT EXISTS idx_card_market_snapshots_latest
  ON card_market_snapshots(player_id, snapshot_date);

CREATE TABLE IF NOT EXISTS recommendation_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER,
  card_target_id INTEGER,
  board_type TEXT,
  grade TEXT,
  recommendation TEXT,
  total_score REAL,
  stats_score REAL,
  market_score REAL,
  liquidity_score REAL,
  valuation_score REAL,
  news_score REAL,
  catalyst_score REAL,
  thesis TEXT,
  catalyst TEXT,
  risk_notes TEXT,
  status TEXT,
  snapshot_date TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (player_id) REFERENCES players(id),
  FOREIGN KEY (card_target_id) REFERENCES emerging_card_targets(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_recommendation_snapshots_unique
  ON recommendation_snapshots(player_id, card_target_id, board_type, status, snapshot_date);

CREATE INDEX IF NOT EXISTS idx_recommendation_snapshots_latest
  ON recommendation_snapshots(board_type, status, snapshot_date);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_type TEXT,
  started_at TEXT,
  finished_at TEXT,
  status TEXT,
  players_checked INTEGER,
  stats_updated INTEGER,
  top100_removed INTEGER,
  called_up_removed INTEGER,
  inactive_removed INTEGER,
  card_targets_checked INTEGER,
  market_snapshots_added INTEGER,
  recommendations_created INTEGER,
  errors_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_type_started
  ON pipeline_runs(run_type, started_at);
