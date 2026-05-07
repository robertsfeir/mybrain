/**
 * Fresh-install bootstrap test.
 *
 * Verifies that `runMigrations(pool)` on a truly empty database:
 *   1. Detects the missing baseline (no `thoughts` table) and applies
 *      templates/schema.sql before the migration loop.
 *   2. Records the baseline as `000-baseline-schema.sql` in schema_migrations.
 *   3. Runs all 5 numbered migrations as idempotent no-ops on top of the
 *      fresh baseline.
 *   4. Leaves a working database: `thoughts` with vector(1536), brain_config
 *      singleton populated, thought_type_config with all 11 rows, and the
 *      match_thoughts_scored function callable.
 *   5. Re-running runMigrations is a clean no-op (no second baseline row,
 *      no duplicate brain_config, no errors).
 *
 * Schema isolation: all DDL runs inside `mybrain_test_fresh_bootstrap` to
 * keep the test from racing migration.test.mjs / protocol-tools.test.mjs.
 *
 * Skips gracefully when MYBRAIN_TEST_DATABASE_URL is unset or the DB is
 * unreachable. Requires PostgreSQL with pgvector + ltree.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { runMigrations } from '../../lib/db.mjs';

const TEST_SCHEMA = 'mybrain_test_fresh_bootstrap';

const DATABASE_URL = process.env.MYBRAIN_TEST_DATABASE_URL || null;

if (DATABASE_URL) {
  const u = new URL(DATABASE_URL);
  const host = u.hostname.toLowerCase();
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (!isLocal) {
    console.error(`ABORT: MYBRAIN_TEST_DATABASE_URL points at non-localhost host '${host}'. Refusing to run tests.`);
    process.exit(1);
  }
}

async function probeDatabase(url) {
  if (!url) return { ok: false, reason: 'MYBRAIN_TEST_DATABASE_URL not set' };
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
  test('SKIP: fresh-install-bootstrap.test.mjs (database unreachable)', () => {
    console.error(`[SKIP] ${dbProbe.reason}`);
  });
} else {
  await runSuite();
}

async function runSuite() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });

  pool.on('connect', (client) => {
    client.query(`SET search_path TO ${TEST_SCHEMA}, public`).catch(() => {});
  });

  // ---- Setup: drop and recreate the test schema so we start truly empty ----
  {
    const adminClient = await pool.connect();
    try {
      await adminClient.query(`SET search_path TO public`);
      await adminClient.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await adminClient.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await adminClient.query(`SET search_path TO ${TEST_SCHEMA}, public`);
    } finally {
      adminClient.release();
    }
  }

  await test('runMigrations bootstraps baseline schema on an empty DB', async () => {
    // Sanity: the schema is truly empty -- no thoughts, no schema_migrations.
    const before = await pool.query(`SELECT to_regclass('thoughts') AS t, to_regclass('schema_migrations') AS m`);
    assert.equal(before.rows[0].t, null, 'pre-condition: no thoughts table');
    assert.equal(before.rows[0].m, null, 'pre-condition: no schema_migrations table');

    await runMigrations(pool);

    // Post: thoughts table exists with vector(1536) embedding.
    // pgvector stores the dim directly in atttypmod (no offset), so we compare
    // format_type rather than relying on the legacy `(atttypmod - 4)` formula
    // elsewhere in the runner.
    const dimRes = await pool.query(`
      SELECT format_type(a.atttypid, a.atttypmod) AS pretty
      FROM pg_attribute a
      JOIN pg_class c ON a.attrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE c.relname = 'thoughts' AND a.attname = 'embedding'
        AND n.nspname = '${TEST_SCHEMA}'
    `);
    assert.equal(dimRes.rows.length, 1, 'thoughts.embedding column must exist');
    assert.equal(dimRes.rows[0].pretty, 'vector(1536)', 'fresh-install bootstrap must default EMBED_DIM to 1536');
  });

  await test('baseline + all migrations are recorded in schema_migrations', async () => {
    const { rows } = await pool.query(
      `SELECT version FROM schema_migrations ORDER BY version`
    );
    const versions = rows.map(r => r.version);
    assert.deepEqual(
      versions,
      [
        '000-baseline-schema.sql',
        '001-mybrain-v1-to-merged.sql',
        '002-match-thoughts-scored-captured-by.sql',
        '003-brain-config.sql',
        '004-thought-type-config.sql',
        '005-rename-default-scope-to-personal.sql',
      ],
      'baseline + all 5 numbered migrations must be recorded'
    );
  });

  await test('brain_config singleton exists with brain_enabled=true after bootstrap', async () => {
    const { rows } = await pool.query(`SELECT id, brain_enabled FROM brain_config`);
    assert.equal(rows.length, 1, 'brain_config must have exactly one row');
    assert.equal(rows[0].id, 1);
    // Migration 003 flips brain_enabled to true on top of the baseline default of false.
    assert.equal(rows[0].brain_enabled, true, 'migration 003 must enable the brain on a fresh install');
  });

  await test('thought_type_config has all 11 rows after bootstrap', async () => {
    const { rows } = await pool.query(`SELECT thought_type FROM thought_type_config ORDER BY thought_type`);
    assert.equal(rows.length, 11, 'thought_type_config must have one row per enum value');
  });

  await test('match_thoughts_scored function is callable and returns captured_by column', async () => {
    // Insert one thought, search, verify the function returns rows including captured_by.
    const zeroVec = '[' + new Array(1536).fill(0).join(',') + ']';
    const oneVec = '[1' + ',0'.repeat(1535) + ']';
    await pool.query(
      `INSERT INTO thoughts (content, embedding, thought_type, source_agent, source_phase, importance, captured_by)
       VALUES ($1, $2::vector, 'insight', 'robert', 'build', 0.5, 'fresh-install-test')`,
      ['canary thought', oneVec]
    );
    const { rows } = await pool.query(
      `SELECT id, content, captured_by, similarity, combined_score
       FROM match_thoughts_scored($1::vector, 0.0, 10, '{}'::jsonb, NULL, false)`,
      [oneVec]
    );
    assert.equal(rows.length, 1, 'search must return the seeded thought');
    assert.equal(rows[0].captured_by, 'fresh-install-test', 'search result must include captured_by');
  });

  await test('re-running runMigrations is a clean no-op (idempotent)', async () => {
    const beforeMigrations = (await pool.query(`SELECT count(*)::int AS n FROM schema_migrations`)).rows[0].n;
    const beforeThoughts   = (await pool.query(`SELECT count(*)::int AS n FROM thoughts`)).rows[0].n;
    const beforeBrain      = (await pool.query(`SELECT count(*)::int AS n FROM brain_config`)).rows[0].n;

    await runMigrations(pool);

    const afterMigrations = (await pool.query(`SELECT count(*)::int AS n FROM schema_migrations`)).rows[0].n;
    const afterThoughts   = (await pool.query(`SELECT count(*)::int AS n FROM thoughts`)).rows[0].n;
    const afterBrain      = (await pool.query(`SELECT count(*)::int AS n FROM brain_config`)).rows[0].n;

    assert.equal(afterMigrations, beforeMigrations, 're-run must not insert another schema_migrations row');
    assert.equal(afterThoughts, beforeThoughts, 're-run must not touch thoughts');
    assert.equal(afterBrain, beforeBrain, 're-run must not duplicate the brain_config singleton');
  });

  // ---- Teardown ----
  {
    const adminClient = await pool.connect();
    try {
      await adminClient.query(`SET search_path TO public`);
      await adminClient.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    } finally {
      adminClient.release();
    }
  }

  await pool.end();
}
