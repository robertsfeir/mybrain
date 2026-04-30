-- 004-thought-type-config.sql
-- Creates thought_type_config lookup table missing from v1 schema.
-- Runs after 003 so brain_config exists regardless of whether this succeeds.
-- Per ADR-0057 item 5: errors propagate to Postgres -- no EXCEPTION WHEN
-- OTHERS THEN NULL clauses. Enum-mismatch failures surface to runMigrations()
-- and abort startup, matching the fail-hard contract end-to-end.

CREATE TABLE IF NOT EXISTS thought_type_config (
  thought_type       thought_type PRIMARY KEY,
  default_ttl_days   INTEGER,
  default_importance FLOAT NOT NULL DEFAULT 0.5,
  description        TEXT
);

DO $$ BEGIN INSERT INTO thought_type_config VALUES ('decision',   NULL, 0.9,  'Architectural or product decisions') ON CONFLICT DO NOTHING; END $$;
DO $$ BEGIN INSERT INTO thought_type_config VALUES ('preference', NULL, 1.0,  'Human preferences and HALT resolutions') ON CONFLICT DO NOTHING; END $$;
DO $$ BEGIN INSERT INTO thought_type_config VALUES ('lesson',     365,  0.7,  'Retro learnings and patterns') ON CONFLICT DO NOTHING; END $$;
DO $$ BEGIN INSERT INTO thought_type_config VALUES ('rejection',  180,  0.5,  'Alternatives considered and discarded') ON CONFLICT DO NOTHING; END $$;
DO $$ BEGIN INSERT INTO thought_type_config VALUES ('drift',      90,   0.8,  'Spec/UX drift findings') ON CONFLICT DO NOTHING; END $$;
DO $$ BEGIN INSERT INTO thought_type_config VALUES ('correction', 90,   0.7,  'Fixes applied after drift detection') ON CONFLICT DO NOTHING; END $$;
DO $$ BEGIN INSERT INTO thought_type_config VALUES ('insight',    180,  0.6,  'Mid-task discoveries') ON CONFLICT DO NOTHING; END $$;
DO $$ BEGIN INSERT INTO thought_type_config VALUES ('reflection', NULL, 0.85, 'Consolidation-generated synthesis') ON CONFLICT DO NOTHING; END $$;
DO $$ BEGIN INSERT INTO thought_type_config VALUES ('handoff',    NULL, 0.9,  'Structured handoff briefs for team collaboration') ON CONFLICT DO NOTHING; END $$;
DO $$ BEGIN INSERT INTO thought_type_config VALUES ('pattern',    365,  0.7,  'Reusable implementation patterns') ON CONFLICT DO NOTHING; END $$;
DO $$ BEGIN INSERT INTO thought_type_config VALUES ('seed',       NULL, 0.5,  'Out-of-scope ideas with trigger conditions') ON CONFLICT DO NOTHING; END $$;
