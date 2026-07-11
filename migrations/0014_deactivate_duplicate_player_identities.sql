-- Keep one active player registry row per MLBAM identity.
-- Duplicate rows are retained for history, but removed from active board/diagnostics joins.

WITH duplicate_players AS (
  SELECT
    id,
    MIN(id) OVER (PARTITION BY identity_key) AS canonical_id
  FROM players
  WHERE COALESCE(active_status, 'active') = 'active'
    AND identity_key IS NOT NULL
    AND identity_key <> ''
)
UPDATE players
SET
  active_status = 'inactive',
  updated_at = CURRENT_TIMESTAMP
WHERE id IN (
  SELECT id
  FROM duplicate_players
  WHERE id <> canonical_id
);

UPDATE player_tracking_status
SET
  tracking_group = 'inactive',
  priority_tier = 'duplicate_identity',
  status = 'removed',
  notes = TRIM(COALESCE(notes, '') || ' Removed from active universe because another player row has the same MLBAM identity.'),
  last_reviewed_at = CURRENT_TIMESTAMP
WHERE player_id IN (
  SELECT duplicate_id
  FROM (
    SELECT
      id AS duplicate_id,
      MIN(id) OVER (PARTITION BY identity_key) AS canonical_id
    FROM players
    WHERE identity_key IS NOT NULL
      AND identity_key <> ''
  )
  WHERE duplicate_id <> canonical_id
);
