-- Store current player age from MLB/MiLB identity refreshes.

ALTER TABLE players ADD COLUMN age REAL;

UPDATE players
SET age = CAST((julianday('now') - julianday(birth_date)) / 365.25 AS REAL)
WHERE birth_date IS NOT NULL
  AND birth_date <> ''
  AND age IS NULL;
