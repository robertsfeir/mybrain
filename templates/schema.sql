-- MyBrain database schema
-- Run this against your mybrain database:
--   psql -d mybrain -f schema.sql

-- Enable vector extension (requires pgvector installed)
CREATE EXTENSION IF NOT EXISTS vector;

-- Thoughts table
CREATE TABLE IF NOT EXISTS thoughts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  content text NOT NULL,
  embedding vector(1536),
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- HNSW index for fast approximate nearest neighbor vector search
CREATE INDEX IF NOT EXISTS thoughts_embedding_idx
  ON thoughts USING hnsw (embedding vector_cosine_ops);

-- GIN index for fast JSONB metadata filtering
CREATE INDEX IF NOT EXISTS thoughts_metadata_idx
  ON thoughts USING gin (metadata);

-- B-tree index for fast chronological browsing
CREATE INDEX IF NOT EXISTS thoughts_created_at_idx
  ON thoughts (created_at DESC);

-- Auto-update the updated_at timestamp on row changes
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS trigger AS $$
BEGIN
  new.updated_at = now();
  RETURN new;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS thoughts_updated_at ON thoughts;
CREATE TRIGGER thoughts_updated_at
  BEFORE UPDATE ON thoughts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- Semantic search function
-- Returns thoughts ranked by cosine similarity to a query embedding
CREATE OR REPLACE FUNCTION match_thoughts(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 10,
  filter jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  id uuid,
  content text,
  metadata jsonb,
  similarity float,
  created_at timestamptz
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id,
    t.content,
    t.metadata,
    (1 - (t.embedding <=> query_embedding))::float AS similarity,
    t.created_at
  FROM thoughts t
  WHERE 1 - (t.embedding <=> query_embedding) > match_threshold
  AND (filter = '{}'::jsonb OR t.metadata @> filter)
  ORDER BY t.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
