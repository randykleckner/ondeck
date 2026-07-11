CREATE TABLE IF NOT EXISTS bowman_checklist_cards (
  checklist_card_id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_year INTEGER NOT NULL,
  product_family TEXT NOT NULL,
  product_name TEXT NOT NULL,
  subset_name TEXT,
  card_code TEXT NOT NULL,
  player_name TEXT NOT NULL,
  normalized_player_name TEXT NOT NULL,
  team TEXT,
  is_auto INTEGER NOT NULL DEFAULT 1,
  is_chrome INTEGER NOT NULL DEFAULT 1,
  is_1st_bowman INTEGER NOT NULL DEFAULT 1,
  source_name TEXT,
  source_url TEXT,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bowman_checklist_unique
  ON bowman_checklist_cards(product_year, product_family, product_name, subset_name, card_code, normalized_player_name);

CREATE INDEX IF NOT EXISTS idx_bowman_checklist_player
  ON bowman_checklist_cards(normalized_player_name, product_year);

CREATE INDEX IF NOT EXISTS idx_bowman_checklist_code
  ON bowman_checklist_cards(card_code);

ALTER TABLE card_targets ADD COLUMN checklist_card_id INTEGER;
ALTER TABLE card_targets ADD COLUMN checklist_match_confidence TEXT;
ALTER TABLE card_targets ADD COLUMN checklist_source_name TEXT;
ALTER TABLE card_targets ADD COLUMN checklist_source_url TEXT;
ALTER TABLE card_targets ADD COLUMN checklist_imported_at TEXT;

ALTER TABLE emerging_card_targets ADD COLUMN checklist_card_id INTEGER;
ALTER TABLE emerging_card_targets ADD COLUMN checklist_match_confidence TEXT;
ALTER TABLE emerging_card_targets ADD COLUMN checklist_source_name TEXT;
ALTER TABLE emerging_card_targets ADD COLUMN checklist_source_url TEXT;
ALTER TABLE emerging_card_targets ADD COLUMN checklist_imported_at TEXT;

CREATE INDEX IF NOT EXISTS idx_card_targets_checklist
  ON card_targets(checklist_card_id, checklist_match_confidence);

CREATE INDEX IF NOT EXISTS idx_emerging_card_targets_checklist
  ON emerging_card_targets(checklist_card_id, checklist_match_confidence);
