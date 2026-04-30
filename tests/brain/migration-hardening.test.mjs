/**
 * Migration hardening behavioral test (ADR-0057).
 *
 * Verifies the data-loss tripwire: a migration that deletes from `thoughts`
 * must cause `runMigrations()` to throw `MigrationDataLossError` with both
 * pre- and post-counts visible in the error message.
 *
 * Skips gracefully when:
 *   - DATABASE_URL / ATELIER_BRAIN_DATABASE_URL is unset or unreachable.
 *   - pg_dump is not available on PATH (the runner shells out to it as a
 *     hard precondition; we don't mock that).
 *
 * Schema isolation: all DDL/DML the runner observes lives inside
 * `mybrain_test_hardening` so the test does not race against
 * migration.test.mjs or protocol-tools.test.mjs running in parallel.
 *
 * Pool's `connect` hook routes every session to the test schema via
 * `SET search_path`, so the runner's `SELECT count(*) FROM thoughts`
 * reads the seeded test row. pg_dump does not honor session search_path,
 * so it returns "no matching tables were found" against the default
 * search_path (public) -- the runner treats that as "nothing to back up,
 * proceed", consistent with the fresh-install handling of the count gate.
 * The data-loss tripwire still fires from the post-count comparison.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import pg from 'pg';

import { runMigrations, MigrationDataLossError } from '../../lib/db.mjs';

const TEST_SCHEMA = 'mybrain_test_hardening';

const DATABASE_URL =
  process.env.MYBRAIN_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  process.env.ATELIER_BRAIN_DATABASE_URL ||
  null;

// =============================================================================
// Skip-gracefully guards
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

function probePgDump() {
  const r = spawnSync('pg_dump', ['--version'], { encoding: 'utf-8' });
  if (r.error) return { ok: false, reason: `pg_dump unavailable: ${r.error.message}` };
  if (r.status !== 0) return { ok: false, reason: `pg_dump --version exit ${r.status}` };
  return { ok: true };
}

const dbProbe = await probeDatabase(DATABASE_URL);
const pgDumpProbe = probePgDump();

if (!dbProbe.ok) {
  test('SKIP: migration-hardening.test.mjs (database unreachable)', () => {
    console.error(`[SKIP] ${dbProbe.reason}`);
  });
} else if (!pgDumpProbe.ok) {
  test('SKIP: migration-hardening.test.mjs (pg_dump unavailable)', () => {
    console.error(`[SKIP] ${pgDumpProbe.reason}`);
  });
} else {
  await runSuite();
}

// =============================================================================
// Suite
// =============================================================================

async function runSuite() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });

  pool.on('connect', (client) => {
    client.query(`SET search_path TO ${TEST_SCHEMA}, public`).catch(() => {});
  });

  // ---- Schema isolation ----
  {
    const adminClient = await pool.connect();
    try {
      await adminClient.query(`SET search_path TO public`);
      await adminClient.query(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);
      // Drop anything from a prior failed run inside this schema. Qualify
      // explicitly so the cleanup does not chase an unqualified `thoughts`
      // through search_path into another schema.
      await adminClient.query(`
        DROP TABLE IF EXISTS ${TEST_SCHEMA}.thoughts CASCADE;
        DROP TABLE IF EXISTS ${TEST_SCHEMA}.schema_migrations CASCADE;
      `).catch(() => {});
      await adminClient.query(`SET search_path TO ${TEST_SCHEMA}, public`);
    } finally {
      adminClient.release();
    }
  }

  // Tmp dir for the synthetic destructive migration.
  let migrationsDir = null;

  await test('setup: seed a thought into the isolated test schema', async () => {
    // Minimal thoughts table -- only what the destructive migration touches.
    await pool.query(`
      CREATE TABLE thoughts (
        id      SERIAL PRIMARY KEY,
        content TEXT NOT NULL
      )
    `);
    await pool.query(`INSERT INTO thoughts (content) VALUES ($1)`, ['hardening canary']);

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM thoughts`);
    assert.equal(rows[0].n, 1, 'seed must place exactly one row before the test runs');

    migrationsDir = mkdtempSync(path.join(tmpdir(), 'mybrain-hardening-'));
    writeFileSync(
      path.join(migrationsDir, '999-destructive-test.sql'),
      'DELETE FROM thoughts WHERE true;\n',
      'utf-8'
    );
  });

  await test('runMigrations throws MigrationDataLossError when a migration deletes thoughts', async () => {
    let caught = null;
    try {
      await runMigrations(pool, migrationsDir);
    } catch (err) {
      caught = err;
    }

    assert.ok(caught, 'runMigrations must throw -- silent data loss is the bug ADR-0057 closes');
    assert.ok(
      caught instanceof MigrationDataLossError,
      `expected MigrationDataLossError, got ${caught && caught.name}: ${caught && caught.message}`
    );
    // Pre-count = 1, post-count = 0; both must be visible in the message.
    assert.ok(
      /\b1\b/.test(caught.message),
      `error message must include the pre-count (1); got: ${caught.message}`
    );
    assert.ok(
      /\b0\b/.test(caught.message),
      `error message must include the post-count (0); got: ${caught.message}`
    );
    // Structured fields must also carry the counts so callers can reason
    // programmatically without parsing the message.
    assert.equal(caught.preCount, 1, 'preCount field must equal 1');
    assert.equal(caught.postCount, 0, 'postCount field must equal 0');
    // The error must tell the operator what recovery options they have.
    // Two valid shapes depending on whether a pre-migration dump was actually
    // written: (a) a real `psql ... --file=` restore command when the dump
    // exists, or (b) an explicit "no pre-migration dump available" notice
    // when the runner skipped pg_dump (fresh install, or -- as in this
    // schema-isolated test environment -- pg_dump found no public.thoughts
    // and took the no-dump branch). Either shape is correct; the test
    // verifies the contract, not which branch the environment exercises.
    if (caught.restoreCommand !== null) {
      assert.ok(
        /psql .* --file=/.test(caught.message),
        `error message must embed the psql restore command when a dump exists; got: ${caught.message}`
      );
    } else {
      assert.ok(
        /no pre-migration dump available/i.test(caught.message),
        `error message must state no pre-migration dump available when none was written; got: ${caught.message}`
      );
    }
  });

  await test('cleanup', async () => {
    if (migrationsDir) {
      try { rmSync(migrationsDir, { recursive: true, force: true }); } catch {}
    }
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
