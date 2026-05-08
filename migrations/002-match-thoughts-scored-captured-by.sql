-- 002-match-thoughts-scored-captured-by.sql
-- Bring migrated mybrain v1 databases up to the merged shape of
-- match_thoughts_scored() — the merged baseline (templates/schema.sql)
-- adds `captured_by TEXT` to the RETURNS TABLE clause and selects
-- `t.captured_by` in the result set. v1 databases that ran migration
-- 001 retain the v1 version of this function (without captured_by) by
-- design (see migration 001 header). Wave 4 of ADR-0001 (tools.mjs)
-- expects captured_by in agent_search results, so this migration brings
-- migrated DBs to the same shape as fresh installs from
-- templates/schema.sql.
--
-- DROP-then-CREATE (not CREATE OR REPLACE): Postgres rejects
-- CREATE OR REPLACE FUNCTION when the new RETURNS TABLE differs from the
-- existing one (error 42P13 cannot change return type of existing
-- function). Adding the captured_by column to the result set is exactly
-- such a change for any v1 DB. The DROP IF EXISTS … CASCADE clears the
-- v1 function shape; CREATE FUNCTION below installs the merged shape.
--
-- Re-runnable: IF EXISTS makes the DROP a no-op when the function is
-- absent; on a fresh install the merged baseline (templates/schema.sql)
-- already created the function, so this migration drops + recreates an
-- identical body. CASCADE is safe — no schema-level objects depend on
-- this function (callers reach it via runtime SQL strings, not as a
-- declared dependency).
--
-- The {{EMBED_DIM}} placeholder is substituted at apply time by the
-- same mechanism that applies templates/schema.sql (sed in start.sh).

DROP FUNCTION IF EXISTS match_thoughts_scored(vector, FLOAT, INTEGER, JSONB, ltree, BOOLEAN) CASCADE;

CREATE FUNCTION match_thoughts_scored(
  query_embedding vector({{EMBED_DIM}}),
  similarity_threshold FLOAT DEFAULT 0.2,
  max_results INTEGER DEFAULT 10,
  metadata_filter JSONB DEFAULT '{}',
  scope_filter ltree DEFAULT NULL,
  include_invalidated BOOLEAN DEFAULT false
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  metadata JSONB,
  thought_type thought_type,
  source_agent source_agent,
  source_phase source_phase,
  importance FLOAT,
  status thought_status,
  scope ltree[],
  captured_by TEXT,
  created_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  similarity FLOAT,
  recency_score FLOAT,
  combined_score FLOAT
) AS $$
BEGIN
  -- Validate inputs
  IF query_embedding IS NULL THEN
    RAISE EXCEPTION 'query_embedding must not be NULL';
  END IF;
  IF max_results < 0 THEN
    RAISE EXCEPTION 'max_results must be non-negative, got %', max_results;
  END IF;
  IF similarity_threshold < 0 OR similarity_threshold > 1 THEN
    RAISE EXCEPTION 'similarity_threshold must be between 0 and 1, got %', similarity_threshold;
  END IF;

  RETURN QUERY
  SELECT
    t.id,
    t.content,
    t.metadata,
    t.thought_type,
    t.source_agent,
    t.source_phase,
    t.importance,
    t.status,
    t.scope,
    t.captured_by,
    t.created_at,
    t.invalidated_at,
    (1 - (t.embedding <=> query_embedding))::FLOAT AS similarity,
    POWER(0.995, EXTRACT(EPOCH FROM (now() - COALESCE(t.last_accessed_at, t.created_at))) / 3600)::FLOAT AS recency_score,
    (
      0.5 * POWER(0.995, EXTRACT(EPOCH FROM (now() - COALESCE(t.last_accessed_at, t.created_at))) / 3600) +
      2.0 * t.importance +
      3.0 * (1 - (t.embedding <=> query_embedding))
    )::FLOAT AS combined_score
  FROM thoughts t
  WHERE
    t.embedding IS NOT NULL
    AND (1 - (t.embedding <=> query_embedding)) >= similarity_threshold
    AND (include_invalidated OR t.status = 'active')
    AND (metadata_filter = '{}' OR t.metadata @> metadata_filter)
    AND (scope_filter IS NULL OR t.scope @> ARRAY[scope_filter])
  ORDER BY combined_score DESC
  LIMIT max_results;
END;
$$ LANGUAGE plpgsql;
