/**
 * Migration test: v1-to-merged (mybrain ADR-0001 Wave 5).
 *
 * Verifies that `migrations/001-mybrain-v1-to-merged.sql`:
 *   1. preserves all v1 rows (no data loss)
 *   2. records itself in schema_migrations (via runMigrations runner)
 *   3. is idempotent -- calling runMigrations a second time leaves exactly
 *      one row in schema_migrations, not two, and does not throw
 *
 * Skips gracefully when DATABASE_URL / ATELIER_BRAIN_DATABASE_URL is unset
 * or the DB is unreachable. Requires PostgreSQL with pgvector + ltree.
 *
 * Schema isolation: all tables are created inside the PostgreSQL schema
 * `mybrain_test_migration` to prevent parallel-test races against
 * protocol-tools.test.mjs which drops/creates the same table names.
 * The schema is created at setup and dropped (CASCADE) at teardown.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

import { runMigrations } from '../../lib/db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATION_FILENAME = '001-mybrain-v1-to-merged.sql';
const TEST_SCHEMA = 'mybrain_test_migration';

const DATABASE_URL =
  process.env.MYBRAIN_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  process.env.ATELIER_BRAIN_DATABASE_URL ||
  null;

// =============================================================================
// V1 baseline schema (minimal subset that the migration expects to exist).
// Mirrors mybrain v1 templates/schema.sql in the period before ADR-0001:
//   - extensions vector + ltree
//   - enum types thought_type / source_agent / source_phase / thought_status / relation_type
//   - thoughts table with the columns v1 used pre-merge
// EMBED_DIM = 3 to keep test inserts cheap.
// =============================================================================

const V1_BASELINE_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS ltree;

CREATE TYPE thought_type AS ENUM (
  'decision', 'preference', 'lesson', 'rejection',
  'drift', 'correction', 'insight', 'reflection'
);

CREATE TYPE source_agent AS ENUM (
  'eva', 'robert', 'sable', 'colby', 'poirot',
  'agatha', 'distillator', 'ellis'
);

CREATE TYPE source_phase AS ENUM (
  'design', 'build', 'qa', 'review', 'reconciliation', 'setup'
);

CREATE TYPE thought_status AS ENUM (
  'active', 'superseded', 'invalidated', 'expired', 'conflicted'
);

CREATE TYPE relation_type AS ENUM (
  'supersedes', 'triggered_by', 'evolves_from',
  'contradicts', 'supports', 'synthesized_from'
);

CREATE TABLE thoughts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  content TEXT NOT NULL,
  embedding vector(3),
  metadata JSONB DEFAULT '{}',
  thought_type thought_type NOT NULL,
  source_agent source_agent NOT NULL,
  source_phase source_phase NOT NULL,
  importance FLOAT NOT NULL DEFAULT 0.5,
  trigger_event TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
`;

// =============================================================================
// Skip-gracefully guard
// =============================================================================

async function probeDatabase(url) {
  if (!url) return { ok: false, reason: 'DATABASE_URL not set' };
  const probe = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 2000, max: 1 });
  try {
    await probe.query('SELECT 1');
    await probe.end();
    return { ok: true };
  } catch (err) {
    try { await probe.end(); } catch {}
    return { ok: false, reason: err.message };
  }
}

const dbProbe = await probeDatabase(DATABASE_URL);

if (!dbProbe.ok) {
  test('SKIP: migration.test.mjs (database unreachable)', () => {
    console.error(`[SKIP] ${dbProbe.reason}`);
  });
} else {
  await runSuite();
}

// =============================================================================
// Suite
// =============================================================================

async function runSuite() {
  // Create a pool whose every connection is routed to the isolated test schema.
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });

  pool.on('connect', (client) => {
    client.query(`SET search_path TO ${TEST_SCHEMA}, public`).catch(() => {});
  });

  // ---- Schema isolation: create dedicated test schema ----
  // Use a direct client to create the schema first (before the connect hook
  // tries to SET search_path to a schema that doesn't exist yet).
  {
    const adminClient = await pool.connect();
    try {
      // Override to public so we can create the schema at the top level.
      await adminClient.query(`SET search_path TO public`);
      await adminClient.query(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);
      // Now switch into the test schema.
      await adminClient.query(`SET search_path TO ${TEST_SCHEMA}, public`);

      // Drop any objects left from a prior failed run within this schema.
      await adminClient.query(`
        DROP TABLE IF EXISTS thought_relations CASCADE;
        DROP TABLE IF EXISTS thoughts CASCADE;
        DROP TABLE IF EXISTS brain_config CASCADE;
        DROP TABLE IF EXISTS thought_type_config CASCADE;
        DROP TABLE IF EXISTS schema_migrations CASCADE;
        DROP FUNCTION IF EXISTS match_thoughts_scored(vector, FLOAT, INTEGER, JSONB, ltree, BOOLEAN) CASCADE;
        DROP FUNCTION IF EXISTS update_updated_at() CASCADE;
        DROP TYPE IF EXISTS relation_type CASCADE;
        DROP TYPE IF EXISTS thought_status CASCADE;
        DROP TYPE IF EXISTS source_phase CASCADE;
        DROP TYPE IF EXISTS source_agent CASCADE;
        DROP TYPE IF EXISTS thought_type CASCADE;
      `).catch(() => { /* tolerate if objects don't exist */ });
    } finally {
      adminClient.release();
    }
  }

  // ---- Drop everything from any prior run, apply v1 baseline ----
  await test('setup: drop and recreate v1 baseline schema', async () => {
    await pool.query(V1_BASELINE_SQL);

    // Insert 3 v1-shape rows (no captured_by, no scope, no status -- v1 had
    // none of those columns).
    await pool.query(
      `INSERT INTO thoughts (content, embedding, metadata, thought_type, source_agent, source_phase, importance)
       VALUES
         ($1, '[0.1,0.2,0.3]'::vector, '{}'::jsonb, 'insight', 'robert', 'build', 0.5),
         ($2, '[0.4,0.5,0.6]'::vector, '{}'::jsonb, 'decision', 'colby', 'qa', 0.7),
         ($3, '[0.7,0.8,0.9]'::vector, '{}'::jsonb, 'lesson', 'eva', 'review', 0.6)`,
      ['v1 row alpha', 'v1 row beta', 'v1 row gamma']
    );
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM thoughts`);
    assert.equal(rows[0].n, 3, 'v1 baseline must have 3 rows before migration');
  });

  // ---- Apply migration via runMigrations (the real runner); it records the
  //      migration in schema_migrations automatically ----
  await test('migration applies cleanly and records itself', async () => {
    await runMigrations(pool);
    const { rows } = await pool.query(
      `SELECT version FROM schema_migrations WHERE version = $1`,
      [MIGRATION_FILENAME]
    );
    assert.equal(rows.length, 1, 'schema_migrations must contain the migration filename');
  });

  // ---- (a) all 3 v1 rows survive ----
  await test('all 3 v1 rows survive the migration', async () => {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM thoughts`);
    assert.equal(rows[0].n, 3, 'expected 3 surviving v1 rows after migration');

    const { rows: contentRows } = await pool.query(
      `SELECT content FROM thoughts ORDER BY content`
    );
    assert.deepEqual(
      contentRows.map(r => r.content),
      ['v1 row alpha', 'v1 row beta', 'v1 row gamma'],
      'row contents must be preserved verbatim'
    );

    // Migration adds new columns -- they should exist as nullable on v1 rows.
    const { rows: colRows } = await pool.query(`
      SELECT captured_by, origin_pipeline, origin_context, trigger_when, status, scope
      FROM thoughts ORDER BY content LIMIT 1
    `);
    assert.equal(colRows[0].captured_by, null);
    assert.equal(colRows[0].origin_pipeline, null);
    assert.equal(colRows[0].origin_context, null);
    assert.equal(colRows[0].trigger_when, null);
    assert.equal(colRows[0].status, 'active', 'status default should be "active"');
    const scopeOk = colRows[0].scope != null && (Array.isArray(colRows[0].scope) ? colRows[0].scope.includes('default') : String(colRows[0].scope).includes('default'));
    assert.ok(scopeOk, 'scope contains default');
  });

  // ---- (b) thought_relations table exists ----
  await test('thought_relations table is created by the migration', async () => {
    const { rows } = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = 'thought_relations'
    `, [TEST_SCHEMA]);
    assert.equal(rows.length, 1, 'thought_relations must exist after migration');
  });

  // ---- (c) calling runMigrations a second time is a no-op (idempotent) ----
  await test('re-running runMigrations is a no-op (idempotent)', async () => {
    // Call the real runner a second time -- must not throw.
    await runMigrations(pool);
    // Row count unchanged.
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM thoughts`);
    assert.equal(rows[0].n, 3, 'row count must not change on runMigrations re-run');
    // schema_migrations still has exactly one entry for this file (not two).
    const { rows: migRows } = await pool.query(
      `SELECT count(*)::int AS n FROM schema_migrations WHERE version = $1`,
      [MIGRATION_FILENAME]
    );
    assert.equal(migRows[0].n, 1, 'schema_migrations must still record the migration exactly once');
  });

  await test('cleanup', async () => {
    // Drop the isolated schema and everything in it.
    const adminClient = await pool.connect();
    try {
      await adminClient.query(`SET search_path TO public`);
      await adminClient.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    } finally {
      adminClient.release();
    }
    await pool.end();
  });
}
