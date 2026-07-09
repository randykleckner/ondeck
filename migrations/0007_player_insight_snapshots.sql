CREATE TABLE IF NOT EXISTS player_insight_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  player_name TEXT NOT NULL,
  board_type TEXT NOT NULL,
  input_data_hash TEXT NOT NULL,
  model_provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  opportunity_score REAL,
  callup_score REAL,
  final_action TEXT,
  confidence TEXT,
  status TEXT,
  on_deck_eligible INTEGER NOT NULL DEFAULT 0,
  resume TEXT,
  signals TEXT,
  edge TEXT,
  risk TEXT,
  card_market_take TEXT,
  next_trigger TEXT,
  what_would_change_my_mind TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  is_current INTEGER NOT NULL DEFAULT 1,
  refresh_reason TEXT,
  raw_packet_json TEXT,
  raw_model_response_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_player_insight_current_board
  ON player_insight_snapshots(board_type, is_current, on_deck_eligible, opportunity_score, callup_score);

CREATE INDEX IF NOT EXISTS idx_player_insight_player_current
  ON player_insight_snapshots(player_id, board_type, is_current, expires_at);

CREATE TABLE IF NOT EXISTS top100_insight_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  players_checked INTEGER NOT NULL DEFAULT 0,
  market_queries_used INTEGER NOT NULL DEFAULT 0,
  packets_built INTEGER NOT NULL DEFAULT 0,
  ai_calls_attempted INTEGER NOT NULL DEFAULT 0,
  ai_calls_skipped INTEGER NOT NULL DEFAULT 0,
  insights_created INTEGER NOT NULL DEFAULT 0,
  insights_reused INTEGER NOT NULL DEFAULT 0,
  insights_failed INTEGER NOT NULL DEFAULT 0,
  on_deck_top10_updated INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_top100_insight_runs_started
  ON top100_insight_runs(job_name, started_at);
