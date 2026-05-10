-- Run once on PostgreSQL (e.g. Neon) if universities.is_frozen is INTEGER but the ORM expects BOOLEAN.
-- App startup also attempts this migration automatically (see app/__init__.py _apply_lightweight_migrations).

ALTER TABLE universities
  ALTER COLUMN is_frozen DROP DEFAULT;
ALTER TABLE universities
  ALTER COLUMN is_frozen TYPE boolean
  USING (CASE WHEN is_frozen = 0 THEN false ELSE true END);
ALTER TABLE universities
  ALTER COLUMN is_frozen SET DEFAULT false;
