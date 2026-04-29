-- 001-mybrain-v1-to-merged.sql
-- Bring an existing mybrain v1 database up to the merged (post-ADR-0001) schema.
--
-- Safe properties:
--   - Purely additive (no DROP, no rename, no retype, no data migration).
--   - Idempotent (every statement uses IF NOT EXISTS / IF EXISTS guards).
--   - Re-runnable (running on an already-migrated DB is a no-op).
--   - Bootstraps schema_migrations table so the runner can record THIS file
--     even when the target DB has never had a migrations runner before.
--
-- Scope of changes (per ADR-0001 § Decision 3):
--   1. CREATE TABLE schema_migrations (chicken-and-egg bootstrap).
--   2. Extend thought_type enum: add 'handoff', 'pattern', 'seed'.
--   3. Extend source_agent enum: add atelier-pipeline agents
--      (robert-spec, sable-ux, sarah, sherlock, sentinel).
--   4. Extend source_phase enum: add 'handoff', 'devops', 'telemetry',
--      'ci-watch', 'pipeline', 'product', 'ux', 'commit'.
--   5. Add columns to thoughts: captured_by, origin_pipeline, origin_context,
--      trigger_when. (status, scope, invalidated_at, last_accessed_at,
--      updated_at already exist in v1 -- ADD COLUMN IF NOT EXISTS guards
--      protect re-running against any partial-state DB.)
--   6. CREATE TABLE thought_relations (new typed-edge table).
--   7. CREATE INDEX guards for thoughts (any missing v1 indexes) and
--      thought_relations.
--   8. CREATE OR REPLACE update_updated_at trigger (in case v1 lacks it).
--
-- Out of scope:
--   - The match_thoughts_scored function. v1 already has it. The merged
--     baseline (templates/schema.sql) returns one extra column (captured_by)
--     in its result set; rebuilding the function on an existing DB is a
--     migration concern handled in a later wave when tools.mjs needs the
--     captured_by column in search results. Wave 1 leaves the function
--     untouched to avoid silently changing the SQL contract on personal
--     databases mid-port.
--
-- Transaction note: this file is intentionally NOT wrapped in BEGIN/COMMIT.
-- ALTER TYPE … ADD VALUE has historical restrictions inside a transaction
-- (PG ≤ 11 disallows it; PG 12+ allows it but the new values cannot be used
-- in the same transaction). Statement-level autocommit + idempotent guards
-- make this file safe to run, re-run, or partial-run.

-- =============================================================================
-- 1. schema_migrations bootstrap
-- =============================================================================
-- The runner in lib/db.mjs creates this table itself before applying any
-- migration, so a fresh-install path will already have it. This guard is for
-- the case where someone applies this SQL file by hand against a v1 DB.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checksum   TEXT
);

-- =============================================================================
-- 2. thought_type enum extension
-- =============================================================================

ALTER TYPE thought_type ADD VALUE IF NOT EXISTS 'handoff';
ALTER TYPE thought_type ADD VALUE IF NOT EXISTS 'pattern';
ALTER TYPE thought_type ADD VALUE IF NOT EXISTS 'seed';

-- =============================================================================
-- 3. source_agent enum extension
-- =============================================================================
-- v1 mybrain agents: eva, cal, robert, sable, colby, roz, poirot, agatha,
-- distillator, ellis. cal and roz are mybrain-specific and remain valid.
-- This migration adds atelier-pipeline agents that may submit captures.

ALTER TYPE source_agent ADD VALUE IF NOT EXISTS 'robert-spec';
ALTER TYPE source_agent ADD VALUE IF NOT EXISTS 'sable-ux';
ALTER TYPE source_agent ADD VALUE IF NOT EXISTS 'sarah';
ALTER TYPE source_agent ADD VALUE IF NOT EXISTS 'sherlock';
ALTER TYPE source_agent ADD VALUE IF NOT EXISTS 'sentinel';

-- =============================================================================
-- 4. source_phase enum extension
-- =============================================================================

ALTER TYPE source_phase ADD VALUE IF NOT EXISTS 'handoff';
ALTER TYPE source_phase ADD VALUE IF NOT EXISTS 'devops';
ALTER TYPE source_phase ADD VALUE IF NOT EXISTS 'telemetry';
ALTER TYPE source_phase ADD VALUE IF NOT EXISTS 'ci-watch';
ALTER TYPE source_phase ADD VALUE IF NOT EXISTS 'pipeline';
ALTER TYPE source_phase ADD VALUE IF NOT EXISTS 'product';
ALTER TYPE source_phase ADD VALUE IF NOT EXISTS 'ux';
ALTER TYPE source_phase ADD VALUE IF NOT EXISTS 'commit';

-- =============================================================================
-- 5. thoughts table column additions
-- =============================================================================
-- captured_by         -- human/operator identity that triggered the capture
-- origin_pipeline     -- ADR / pipeline ID this thought originated in (seeds)
-- origin_context      -- one-line description of what prompted a seed
-- trigger_when        -- keyword/feature area that should resurface a seed
--
-- All four are nullable TEXT and have no default; v1 rows simply have NULL.
-- status, scope, invalidated_at, last_accessed_at, updated_at exist in v1
-- but the IF NOT EXISTS guards keep this idempotent against any drift.

ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS captured_by      TEXT;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS origin_pipeline  TEXT;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS origin_context   TEXT;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS trigger_when     TEXT;

ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS status           thought_status NOT NULL DEFAULT 'active';
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS scope            ltree[] DEFAULT ARRAY['default']::ltree[];
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS invalidated_at   TIMESTAMPTZ;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ DEFAULT now();

-- =============================================================================
-- 6. thought_relations table
-- =============================================================================
-- Convention: source_id = NEWER/DERIVED, target_id = OLDER/ORIGINAL.

CREATE TABLE IF NOT EXISTS thought_relations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source_id UUID NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  target_id UUID NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  relation_type relation_type NOT NULL,
  context TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (source_id, target_id, relation_type)
);

-- =============================================================================
-- 7. Indexes (idempotent guards on every required index)
-- =============================================================================

CREATE INDEX IF NOT EXISTS thoughts_embedding_idx   ON thoughts USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS thoughts_metadata_idx    ON thoughts USING gin (metadata);
CREATE INDEX IF NOT EXISTS thoughts_scope_idx       ON thoughts USING gist (scope);
CREATE INDEX IF NOT EXISTS thoughts_status_idx      ON thoughts (status);
CREATE INDEX IF NOT EXISTS thoughts_type_idx        ON thoughts (thought_type);
CREATE INDEX IF NOT EXISTS thoughts_created_idx     ON thoughts (created_at DESC);
CREATE INDEX IF NOT EXISTS thoughts_agent_idx       ON thoughts (source_agent);
CREATE INDEX IF NOT EXISTS thoughts_invalidated_idx ON thoughts (invalidated_at) WHERE invalidated_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS relations_source_idx ON thought_relations (source_id);
CREATE INDEX IF NOT EXISTS relations_target_idx ON thought_relations (target_id);
CREATE INDEX IF NOT EXISTS relations_type_idx   ON thought_relations (relation_type);

-- =============================================================================
-- 8. updated_at trigger (CREATE OR REPLACE function; trigger guarded)
-- =============================================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'thoughts_updated_at'
      AND tgrelid = 'thoughts'::regclass
  ) THEN
    CREATE TRIGGER thoughts_updated_at
      BEFORE UPDATE ON thoughts
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END$$;
