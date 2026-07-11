-- Normalize the active player universe around MLB StatsAPI-backed identities.
-- Keep historical rows and market data intact; non-MLBAM rows are removed from active boards.

UPDATE players
SET
  first_seen_source = 'MLB StatsAPI',
  identity_key = COALESCE(identity_key, 'mlbam:' || mlbam_id),
  active_status = 'active',
  updated_at = CURRENT_TIMESTAMP
WHERE mlbam_id IS NOT NULL;

UPDATE players
SET
  active_status = 'inactive',
  updated_at = CURRENT_TIMESTAMP
WHERE mlbam_id IS NULL;

UPDATE player_sources
SET
  source_type = 'MLB StatsAPI',
  source_notes = COALESCE(source_notes, '') || CASE
    WHEN COALESCE(source_notes, '') LIKE '%Normalized from MiLB Roster Refresh%' THEN ''
    ELSE ' Normalized from MiLB Roster Refresh.'
  END
WHERE source_type = 'MiLB Roster Refresh';

INSERT OR IGNORE INTO player_sources (
  player_id,
  source_type,
  source_name,
  source_date,
  source_notes
)
SELECT
  p.id,
  'MLB StatsAPI',
  'Backfilled MLBAM identity',
  DATE('now'),
  'Normalized source cleanup; active player identity is backed by MLB StatsAPI MLBAM ID.'
FROM players p
WHERE p.mlbam_id IS NOT NULL;

DELETE FROM player_sources
WHERE source_type <> 'MLB StatsAPI';

UPDATE player_tracking_status
SET
  tracking_group = 'inactive',
  priority_tier = 'inactive_no_mlbam',
  status = 'removed',
  notes = COALESCE(notes, '') || CASE
    WHEN COALESCE(notes, '') LIKE '%Removed from active universe because no MLBAM ID%' THEN ''
    ELSE ' Removed from active universe because no MLBAM ID is available.'
  END,
  last_reviewed_at = CURRENT_TIMESTAMP
WHERE player_id IN (
  SELECT id FROM players WHERE mlbam_id IS NULL
);
