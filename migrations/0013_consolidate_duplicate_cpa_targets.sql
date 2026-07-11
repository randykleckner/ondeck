-- Keep one active emerging card target per player/CPA code.
-- Prefer targets that already carry market snapshots so diagnostics and boards do not lose comps.

WITH ranked_targets AS (
  SELECT
    ect.id,
    ROW_NUMBER() OVER (
      PARTITION BY ect.player_id, COALESCE(ect.verified_card_code, ect.auto_code)
      ORDER BY
        CASE WHEN COALESCE(ms.market_rows, 0) > 0 THEN 0 ELSE 1 END,
        COALESCE(ms.market_sales, 0) DESC,
        CASE WHEN ect.checklist_card_id IS NOT NULL THEN 0 ELSE 1 END,
        CASE WHEN ect.review_status = 'Verified' THEN 0 ELSE 1 END,
        ect.id ASC
    ) AS target_rank
  FROM emerging_card_targets ect
  LEFT JOIN (
    SELECT
      card_target_id,
      COUNT(*) AS market_rows,
      SUM(COALESCE(sales_count_30d, 0) + COALESCE(sales_count_90d, 0)) AS market_sales
    FROM card_market_snapshots
    GROUP BY card_target_id
  ) ms ON ms.card_target_id = ect.id
  WHERE ect.active = 1
    AND COALESCE(ect.verified_card_code, ect.auto_code, '') LIKE 'CPA%'
)
UPDATE emerging_card_targets
SET
  active = 0,
  include_in_emerging = 0,
  notes = COALESCE(notes, '') || CASE
    WHEN COALESCE(notes, '') LIKE '%Duplicate CPA target consolidated%' THEN ''
    ELSE ' Duplicate CPA target consolidated; canonical active target retained for this player/code.'
  END,
  updated_at = CURRENT_TIMESTAMP
WHERE id IN (
  SELECT id FROM ranked_targets WHERE target_rank > 1
);
