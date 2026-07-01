CREATE TABLE IF NOT EXISTS top100_rank_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date TEXT NOT NULL,
  player_key TEXT NOT NULL,
  player_id TEXT,
  mlbam_id TEXT,
  player_name TEXT NOT NULL,
  org TEXT,
  position TEXT,
  rank INTEGER NOT NULL,
  source_url TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(snapshot_date, player_key)
);

CREATE INDEX IF NOT EXISTS idx_top100_rank_snapshots_player
  ON top100_rank_snapshots(player_key, snapshot_date);

CREATE INDEX IF NOT EXISTS idx_top100_rank_snapshots_date
  ON top100_rank_snapshots(snapshot_date, rank);

CREATE TABLE IF NOT EXISTS top100_rank_trends (
  player_key TEXT PRIMARY KEY,
  player_id TEXT,
  mlbam_id TEXT,
  player_name TEXT NOT NULL,
  org TEXT,
  position TEXT,
  current_rank INTEGER NOT NULL,
  previous_rank INTEGER,
  movement INTEGER,
  first_seen_rank INTEGER,
  best_rank INTEGER,
  worst_rank INTEGER,
  snapshots_count INTEGER NOT NULL DEFAULT 1,
  last_snapshot_date TEXT NOT NULL,
  previous_snapshot_date TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS top100_rank_run_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  snapshot_date TEXT,
  source_url TEXT,
  status TEXT NOT NULL,
  players_found INTEGER NOT NULL DEFAULT 0,
  message TEXT
);
