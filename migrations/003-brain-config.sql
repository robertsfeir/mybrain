-- 003-brain-config.sql
-- Creates brain_config singleton table missing from v1 schema.
-- Only templates/schema.sql (fresh-install) created this table; no prior
-- migration backfilled it for existing databases.
--
-- Safe: CREATE TABLE IF NOT EXISTS + INSERT ON CONFLICT DO NOTHING.
-- No enum dependencies -- safe to run on any v1 database.

CREATE TABLE IF NOT EXISTS brain_config (
  id                             INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  brain_enabled                  BOOLEAN NOT NULL DEFAULT false,
  consolidation_interval_minutes INTEGER NOT NULL DEFAULT 30,
  consolidation_min_thoughts     INTEGER NOT NULL DEFAULT 3,
  consolidation_max_thoughts     INTEGER NOT NULL DEFAULT 20,
  conflict_detection_enabled     BOOLEAN NOT NULL DEFAULT true,
  conflict_duplicate_threshold   FLOAT   NOT NULL DEFAULT 0.9,
  conflict_candidate_threshold   FLOAT   NOT NULL DEFAULT 0.7,
  conflict_llm_enabled           BOOLEAN NOT NULL DEFAULT true,
  default_scope                  ltree            DEFAULT 'default'
);

INSERT INTO brain_config DEFAULT VALUES ON CONFLICT DO NOTHING;

UPDATE brain_config SET brain_enabled = true WHERE id = 1;
