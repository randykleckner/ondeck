-- Keep Jared Roger Jones' imported/verified card target as the canonical review row
-- and deactivate the generated CPA initials guess.

UPDATE emerging_card_targets
SET
  active = 1,
  card_status = 'Card Target Found',
  review_status = 'Verified',
  verified_card_code = COALESCE(verified_card_code, auto_code),
  card_code_confidence = COALESCE(card_code_confidence, 'verified_from_import'),
  updated_at = CURRENT_TIMESTAMP
WHERE player_id = (SELECT id FROM players WHERE mlbam_id = 702262)
  AND auto_code = 'CPA-JJ'
  AND product = 'Bowman Baseball';

UPDATE emerging_card_targets
SET
  active = 0,
  include_in_emerging = 0,
  card_status = 'Bad Match / Exclude',
  review_status = 'Rejected',
  review_notes = 'Superseded by imported Jared Roger Jones CPA-JJ target.',
  updated_at = CURRENT_TIMESTAMP
WHERE player_id = (SELECT id FROM players WHERE mlbam_id = 702262)
  AND auto_code = 'CPA-JJ'
  AND product = 'Bowman Chrome'
  AND review_status = 'Auto-Generated';
