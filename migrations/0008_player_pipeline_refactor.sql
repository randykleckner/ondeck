-- Player-first / card-eligible pipeline foundation.
-- This migration preserves existing Top 100 and Emerging data while adding
-- identity, source, card-review, and score layers for future refresh jobs.

ALTER TABLE players ADD COLUMN milb_player_id INTEGER;
ALTER TABLE players ADD COLUMN identity_key TEXT;
ALTER TABLE players ADD COLUMN full_name TEXT;
ALTER TABLE players ADD COLUMN middle_name TEXT;
ALTER TABLE players ADD COLUMN current_level TEXT;
ALTER TABLE players ADD COLUMN active_status TEXT DEFAULT 'active';
ALTER TABLE players ADD COLUMN first_seen_source TEXT;
ALTER TABLE players ADD COLUMN last_seen_date TEXT;
ALTER TABLE players ADD COLUMN draft_year INTEGER;
ALTER TABLE players ADD COLUMN draft_round TEXT;
ALTER TABLE players ADD COLUMN draft_overall INTEGER;
ALTER TABLE players ADD COLUMN draft_team TEXT;
ALTER TABLE players ADD COLUMN school TEXT;
ALTER TABLE players ADD COLUMN height TEXT;
ALTER TABLE players ADD COLUMN weight INTEGER;
ALTER TABLE players ADD COLUMN raw_identity_json TEXT;

CREATE INDEX IF NOT EXISTS idx_players_mlbam_id
  ON players(mlbam_id);

CREATE INDEX IF NOT EXISTS idx_players_identity_key
  ON players(identity_key);

CREATE INDEX IF NOT EXISTS idx_players_active_status
  ON players(active_status, current_level);

CREATE TABLE IF NOT EXISTS player_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  source_type TEXT NOT NULL,
  source_name TEXT,
  source_date TEXT,
  source_notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_player_sources_unique
  ON player_sources(player_id, source_type, source_name, source_date);

CREATE INDEX IF NOT EXISTS idx_player_sources_type
  ON player_sources(source_type, source_date);

ALTER TABLE emerging_card_targets ADD COLUMN is_bowman INTEGER DEFAULT 1;
ALTER TABLE emerging_card_targets ADD COLUMN is_chrome INTEGER DEFAULT 1;
ALTER TABLE emerging_card_targets ADD COLUMN is_auto INTEGER DEFAULT 1;
ALTER TABLE emerging_card_targets ADD COLUMN is_1st_bowman INTEGER DEFAULT 1;
ALTER TABLE emerging_card_targets ADD COLUMN card_status TEXT DEFAULT 'Card Target Found';
ALTER TABLE emerging_card_targets ADD COLUMN review_status TEXT DEFAULT 'Needs Review';
ALTER TABLE emerging_card_targets ADD COLUMN generated_card_code TEXT;
ALTER TABLE emerging_card_targets ADD COLUMN verified_card_code TEXT;
ALTER TABLE emerging_card_targets ADD COLUMN card_code_confidence TEXT;
ALTER TABLE emerging_card_targets ADD COLUMN review_notes TEXT;

ALTER TABLE card_targets ADD COLUMN player_registry_id INTEGER;
ALTER TABLE card_targets ADD COLUMN product_year INTEGER;
ALTER TABLE card_targets ADD COLUMN product_name TEXT;
ALTER TABLE card_targets ADD COLUMN is_bowman INTEGER DEFAULT 1;
ALTER TABLE card_targets ADD COLUMN is_chrome INTEGER DEFAULT 1;
ALTER TABLE card_targets ADD COLUMN is_auto INTEGER DEFAULT 1;
ALTER TABLE card_targets ADD COLUMN is_1st_bowman INTEGER DEFAULT 1;
ALTER TABLE card_targets ADD COLUMN card_status TEXT DEFAULT 'Needs Card Review';
ALTER TABLE card_targets ADD COLUMN review_status TEXT DEFAULT 'Needs Review';
ALTER TABLE card_targets ADD COLUMN generated_card_code TEXT;
ALTER TABLE card_targets ADD COLUMN verified_card_code TEXT;
ALTER TABLE card_targets ADD COLUMN card_code_confidence TEXT;
ALTER TABLE card_targets ADD COLUMN review_notes TEXT;

CREATE INDEX IF NOT EXISTS idx_card_targets_review
  ON card_targets(enabled, card_status, review_status);

CREATE INDEX IF NOT EXISTS idx_emerging_card_targets_review
  ON emerging_card_targets(active, card_status, review_status);

ALTER TABLE card_market_snapshots ADD COLUMN current_auto_price REAL;
ALTER TABLE card_market_snapshots ADD COLUMN liquidity_label TEXT;
ALTER TABLE card_market_snapshots ADD COLUMN market_source TEXT;

CREATE TABLE IF NOT EXISTS player_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  card_target_id INTEGER,
  score_date TEXT NOT NULL,
  source_scope TEXT,
  move_score REAL,
  investment_score REAL,
  moonshot_rating INTEGER,
  ceiling_score REAL,
  catalyst_score REAL,
  attention_velocity_score REAL,
  market_confidence_score REAL,
  eligible_for_top100 INTEGER DEFAULT 0,
  eligible_for_emerging INTEGER DEFAULT 0,
  eligible_for_on_deck INTEGER DEFAULT 0,
  excluded_reason TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (player_id) REFERENCES players(id),
  FOREIGN KEY (card_target_id) REFERENCES emerging_card_targets(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_player_scores_unique
  ON player_scores(player_id, card_target_id, source_scope, score_date);

CREATE INDEX IF NOT EXISTS idx_player_scores_board
  ON player_scores(eligible_for_on_deck, investment_score, move_score);

CREATE TABLE IF NOT EXISTS player_refresh_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_type TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT,
  sport_ids TEXT,
  teams_checked INTEGER DEFAULT 0,
  players_seen INTEGER DEFAULT 0,
  players_inserted INTEGER DEFAULT 0,
  players_updated INTEGER DEFAULT 0,
  stats_snapshots_added INTEGER DEFAULT 0,
  errors_json TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

UPDATE emerging_card_targets
SET
  is_bowman = COALESCE(is_bowman, 1),
  is_chrome = COALESCE(is_chrome, 1),
  is_auto = COALESCE(is_auto, 1),
  is_1st_bowman = COALESCE(is_1st_bowman, 1),
  card_status = CASE
    WHEN COALESCE(auto_code, '') <> '' THEN 'Card Target Found'
    ELSE 'Needs Card Review'
  END,
  review_status = CASE
    WHEN COALESCE(auto_code, '') <> '' THEN 'Verified'
    ELSE 'Needs Review'
  END,
  verified_card_code = CASE
    WHEN COALESCE(auto_code, '') <> '' THEN auto_code
    ELSE verified_card_code
  END,
  card_code_confidence = CASE
    WHEN COALESCE(auto_code, '') <> '' THEN 'verified_from_import'
    ELSE card_code_confidence
  END
WHERE card_status IS NULL OR review_status IS NULL OR verified_card_code IS NULL;

UPDATE card_targets
SET
  product_year = COALESCE(product_year, CAST(NULLIF(card_year, '') AS INTEGER)),
  product_name = COALESCE(product_name, 'Bowman Chrome Auto'),
  is_bowman = COALESCE(is_bowman, 1),
  is_chrome = COALESCE(is_chrome, 1),
  is_auto = COALESCE(is_auto, 1),
  is_1st_bowman = COALESCE(is_1st_bowman, 1),
  card_status = CASE
    WHEN enabled = 1 AND COALESCE(card_code, '') <> '' THEN 'Card Target Found'
    WHEN enabled = 0 THEN 'No Known Card'
    ELSE 'Needs Card Review'
  END,
  review_status = CASE
    WHEN enabled = 1 AND COALESCE(card_code, '') <> '' THEN 'Verified'
    WHEN enabled = 0 THEN 'Rejected'
    ELSE 'Needs Review'
  END,
  verified_card_code = CASE
    WHEN COALESCE(card_code, '') <> '' THEN card_code
    ELSE verified_card_code
  END,
  card_code_confidence = CASE
    WHEN COALESCE(card_code, '') <> '' THEN 'verified_from_import'
    WHEN enabled = 0 THEN 'no_card'
    ELSE card_code_confidence
  END,
  review_notes = COALESCE(review_notes, notes)
WHERE card_status IS NULL OR review_status IS NULL OR verified_card_code IS NULL;

UPDATE card_market_snapshots
SET
  current_auto_price = COALESCE(current_auto_price, last_sold_price, avg_price_30d, avg_price_90d),
  liquidity_label = COALESCE(liquidity_label, market_signal),
  market_source = COALESCE(market_source, source);

UPDATE players
SET
  full_name = COALESCE(full_name, player_name),
  identity_key = COALESCE(identity_key, CASE WHEN mlbam_id IS NOT NULL THEN 'mlbam:' || mlbam_id ELSE 'name:' || normalized_name END),
  active_status = COALESCE(active_status, 'active');

-- Jared Roger Jones identity correction. Keep him separate from Jared Keith Jones.
UPDATE players
SET
  player_name = 'Jared Roger Jones',
  full_name = 'Jared Roger Jones',
  normalized_name = 'jared roger jones',
  identity_key = 'mlbam:702262',
  middle_name = 'Roger',
  current_team = 'Greensboro Grasshoppers',
  current_org = 'Pittsburgh Pirates',
  current_level = 'A+',
  position = '1B',
  bats = 'R',
  throws = 'R',
  birth_date = '2003-08-01',
  active_status = 'active',
  first_seen_source = COALESCE(first_seen_source, 'Manual Add'),
  last_seen_date = DATE('now'),
  draft_year = 2025,
  draft_team = 'Pittsburgh Pirates',
  height = '6'' 5"',
  weight = 246,
  updated_at = CURRENT_TIMESTAMP
WHERE mlbam_id = 702262;

INSERT INTO players (
  player_name, normalized_name, mlbam_id, identity_key, full_name, middle_name,
  current_team, current_org, current_level, position, bats, throws, birth_date,
  active_status, first_seen_source, last_seen_date, draft_year, draft_team,
  height, weight
)
SELECT
  'Jared Roger Jones', 'jared roger jones', 702262, 'mlbam:702262', 'Jared Roger Jones', 'Roger',
  'Greensboro Grasshoppers', 'Pittsburgh Pirates', 'A+', '1B', 'R', 'R', '2003-08-01',
  'active', 'Manual Add', DATE('now'), 2025, 'Pittsburgh Pirates',
  '6'' 5"', 246
WHERE NOT EXISTS (SELECT 1 FROM players WHERE mlbam_id = 702262);

INSERT OR IGNORE INTO player_sources (player_id, source_type, source_name, source_date, source_notes)
SELECT id, 'Manual Add', 'Backend refactor Jared Roger Jones verification', DATE('now'),
  'StatsAPI id 702262; Jared Roger Jones, Pirates 1B, distinct from Jared Keith Jones id 683003.'
FROM players
WHERE mlbam_id = 702262;

INSERT OR IGNORE INTO player_sources (player_id, source_type, source_name, source_date, source_notes)
SELECT id, 'Scouting Buzz', 'Manual scouting queue', DATE('now'),
  'Queued for Bowman card target review and market pull once verified.'
FROM players
WHERE mlbam_id = 702262;

INSERT INTO emerging_card_targets (
  player_id, year, product, auto_set, auto_code, card_number, player_name_on_card,
  team_on_card, card_query_seed, include_in_emerging, active, notes,
  is_bowman, is_chrome, is_auto, is_1st_bowman, card_status, review_status,
  generated_card_code, card_code_confidence, review_notes, updated_at
)
SELECT
  id, 2026, 'Bowman Chrome', 'Prospect Autographs', 'CPA-JJ', 'CPA-JJ',
  'Jared Jones', 'Pittsburgh Pirates',
  'Jared Roger Jones CPA-JJ Bowman Chrome Auto -paper -digital -break -box -case -lot',
  0, 1, 'Auto-generated card target guess; verify before public board eligibility.',
  1, 1, 1, 1, 'Needs Card Review', 'Auto-Generated',
  'CPA-JJ', 'initials_guess', 'Generated from Bowman CPA initials heuristic. Requires manual checklist/eBay verification.', CURRENT_TIMESTAMP
FROM players
WHERE mlbam_id = 702262
  AND NOT EXISTS (
    SELECT 1
    FROM emerging_card_targets existing
    WHERE existing.player_id = players.id
      AND COALESCE(existing.auto_code, '') <> ''
  )
ON CONFLICT(player_id, year, product, auto_code) DO UPDATE SET
  card_query_seed = excluded.card_query_seed,
  card_status = excluded.card_status,
  review_status = excluded.review_status,
  generated_card_code = excluded.generated_card_code,
  card_code_confidence = excluded.card_code_confidence,
  review_notes = excluded.review_notes,
  updated_at = CURRENT_TIMESTAMP;
