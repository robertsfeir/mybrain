/**
 * ADR-0002 behavioral test: capture-then-immediate-search must not miss
 * a thought whose embedding is still queued.
 *
 * Setup:
 *   - Apply schema with EMBED_DIM=3 to an isolated PostgreSQL schema.
 *   - Start a fake openai-compat embeddings server returning [0.1, 0.2, 0.3].
 *   - Insert a thoughts row with embedding=NULL (simulates the async-capture
 *     state: row stored, embedding pending the worker).
 *   - Set MYBRAIN_ASYNC_STORAGE=true and call agent_search.
 *
 * Assertion:
 *   - The pending row appears in the search results because agent_search
 *     drained the queue in parallel with query embedding (ADR-0002).
 *
 * Negative control:
 *   - Re-insert another NULL-embedding row, leave MYBRAIN_ASYNC_STORAGE
 *     unset (synchronous-search path), and confirm the row is NOT returned.
 *     This proves the flush is what closes the race, not some other side
 *     effect.
 *
 * Schema isolation: tables live in `mybrain_test_async_race` to avoid
 * collision with migration.test.mjs and protocol-tools.test.mjs.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';

import { registerTools } from '../../lib/tools.mjs';
import { resetBrainConfigCache } from '../../lib/conflict.mjs';
import { createPool } from '../../lib/db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'templates', 'schema.sql');
const TEST_SCHEMA = 'mybrain_test_async_race';

// ADR-0058 BUG-005: hard MYBRAIN_TEST_DATABASE_URL requirement.
// The pre-fix three-fallback chain ended in ATELIER_BRAIN_DATABASE_URL
// (production) and produced the 2026-04-29 RDS wipe. We now read ONE env
// var, abort on non-localhost hosts, and skip cleanly when unset.
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
  test('SKIP: async-search-race.test.mjs (database unreachable)', () => {
    console.error(`[SKIP] ${dbProbe.reason}`);
  });
} else {
  await runSuite();
}

async function runSuite() {
  // ---- Fake embeddings server ----
  let embedServer;
  let embedBaseUrl;
  await new Promise((resolve) => {
    embedServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        if (req.url.endsWith('/embeddings')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    embedServer.listen(0, '127.0.0.1', () => {
      const addr = embedServer.address();
      embedBaseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });

  const pool = createPool(DATABASE_URL);
  pool.on('connect', (client) => {
    client.query(`SET search_path TO ${TEST_SCHEMA}, public`).catch(() => {});
  });

  // ---- Schema setup ----
  {
    const adminClient = await pool.connect();
    try {
      await adminClient.query(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);
      // ADR-0058 BUG-004: pin search_path to ${TEST_SCHEMA} ONLY (no public
      // fallback) for the DROP block so an unqualified name cannot resolve
      // against public. Every DROP below is also explicitly schema-qualified
      // as defense in depth. The .catch swallow is removed so any failure
      // surfaces instead of being silently masked.
      await adminClient.query(`SET search_path TO ${TEST_SCHEMA}`);
      await adminClient.query(`
        DROP TABLE IF EXISTS ${TEST_SCHEMA}.thought_relations CASCADE;
        DROP TABLE IF EXISTS ${TEST_SCHEMA}.thoughts CASCADE;
        DROP TABLE IF EXISTS ${TEST_SCHEMA}.brain_config CASCADE;
        DROP TABLE IF EXISTS ${TEST_SCHEMA}.thought_type_config CASCADE;
        DROP TABLE IF EXISTS ${TEST_SCHEMA}.schema_migrations CASCADE;
        DROP FUNCTION IF EXISTS ${TEST_SCHEMA}.match_thoughts_scored(vector, FLOAT, INTEGER, JSONB, ltree, BOOLEAN) CASCADE;
        DROP FUNCTION IF EXISTS ${TEST_SCHEMA}.update_updated_at() CASCADE;
        DROP TYPE IF EXISTS ${TEST_SCHEMA}.relation_type CASCADE;
        DROP TYPE IF EXISTS ${TEST_SCHEMA}.thought_status CASCADE;
        DROP TYPE IF EXISTS ${TEST_SCHEMA}.source_phase CASCADE;
        DROP TYPE IF EXISTS ${TEST_SCHEMA}.source_agent CASCADE;
        DROP TYPE IF EXISTS ${TEST_SCHEMA}.thought_type CASCADE;
      `);

      // Restore search_path to include public for the schema apply step that
      // follows (extensions live in public).
      await adminClient.query(`SET search_path TO ${TEST_SCHEMA}, public`);

      const schemaSrc = readFileSync(SCHEMA_PATH, 'utf-8').replaceAll('{{EMBED_DIM}}', '3');
      await adminClient.query(schemaSrc);
      await adminClient.query(`UPDATE brain_config SET brain_enabled = true WHERE id = 1`);
    } finally {
      adminClient.release();
    }
  }

  resetBrainConfigCache();

  // ---- Stub MCP server: capture handler refs ----
  const handlers = new Map();
  const stubSrv = {
    tool(name, _desc, _schema, handler) {
      handlers.set(name, handler);
    },
  };

  const cfg = {
    embedProviderConfig: {
      family: 'openai-compat',
      baseUrl: embedBaseUrl,
      apiKey: 'test-key',
      model: 'fake-embed',
      extraHeaders: {},
    },
    chatProviderConfig: {
      family: 'openai-compat',
      baseUrl: embedBaseUrl,
      apiKey: 'test-key',
      model: 'fake-chat',
      extraHeaders: {},
    },
    brain_name: 'test-brain',
    capturedBy: 'tester <tester@example.com>',
    apiToken: null,
    _source: 'test',
  };

  registerTools(stubSrv, pool, cfg);

  function parseToolResult(result) {
    assert.ok(
      result.content && result.content[0] && typeof result.content[0].text === 'string',
      'tool result must be { content: [{ type, text }] }'
    );
    if (result.isError) {
      throw new Error(`tool reported error: ${result.content[0].text}`);
    }
    return JSON.parse(result.content[0].text);
  }

  // Helper: insert a thoughts row with embedding=NULL — simulates the
  // async-capture state where agent_capture has stored content but the
  // background worker has not yet generated the embedding.
  async function insertPendingThought(content) {
    const r = await pool.query(
      `INSERT INTO thoughts
         (content, embedding, metadata, thought_type, source_agent, source_phase,
          importance, captured_by, status, scope)
       VALUES ($1, NULL, '{}'::jsonb, 'lesson', 'colby', 'qa',
          0.5, 'tester <tester@example.com>', 'active', ARRAY['default']::ltree[])
       RETURNING id`,
      [content]
    );
    return r.rows[0].id;
  }

  // ---- Test 1: race exists when async mode is OFF ----
  // Negative control. Confirms that without the parallel flush,
  // a NULL-embedding row is invisible to search. This is the bug.
  await test('negative control: search misses pending thought when MYBRAIN_ASYNC_STORAGE is unset', async () => {
    const prev = process.env.MYBRAIN_ASYNC_STORAGE;
    delete process.env.MYBRAIN_ASYNC_STORAGE;
    const pendingId = await insertPendingThought(
      'Negative control thought stored without embedding.'
    );
    try {
      const r = await handlers.get('agent_search')({
        query: 'negative control thought',
        threshold: 0.0,
        limit: 50,
      });
      const body = parseToolResult(r);
      const ids = body.results.map((row) => row.id);
      assert.ok(
        !ids.includes(pendingId),
        `pre-fix behavior: pending row should be invisible to search; got ids=${JSON.stringify(ids)}`
      );
      // Verify the row is still NULL — proves search did NOT trigger a flush.
      const check = await pool.query(
        `SELECT embedding IS NULL AS pending FROM thoughts WHERE id = $1`,
        [pendingId]
      );
      assert.equal(check.rows[0].pending, true, 'sync-mode search must not flush');
    } finally {
      // Clean up the leftover NULL row so the next test starts clean.
      await pool.query(`DELETE FROM thoughts WHERE id = $1`, [pendingId]);
      if (prev !== undefined) process.env.MYBRAIN_ASYNC_STORAGE = prev;
    }
  });

  // ---- Test 2: ADR-0002 — parallel flush eliminates the race ----
  await test('ADR-0002: search finds capture-pending thought when MYBRAIN_ASYNC_STORAGE=true', async () => {
    const prev = process.env.MYBRAIN_ASYNC_STORAGE;
    process.env.MYBRAIN_ASYNC_STORAGE = 'true';
    const pendingId = await insertPendingThought(
      'Async-mode pending thought that must be findable on the next search.'
    );
    try {
      const r = await handlers.get('agent_search')({
        query: 'pending thought findable',
        threshold: 0.0,
        limit: 50,
      });
      const body = parseToolResult(r);
      const ids = body.results.map((row) => row.id);
      assert.ok(
        ids.includes(pendingId),
        `ADR-0002 fix: pending row must be visible after parallel flush; got ids=${JSON.stringify(ids)}`
      );
      // Verify the embedding is now populated — proves the flush ran.
      const check = await pool.query(
        `SELECT embedding IS NULL AS still_pending FROM thoughts WHERE id = $1`,
        [pendingId]
      );
      assert.equal(check.rows[0].still_pending, false,
        'flush must have populated the embedding');
    } finally {
      if (prev === undefined) delete process.env.MYBRAIN_ASYNC_STORAGE;
      else process.env.MYBRAIN_ASYNC_STORAGE = prev;
    }
  });

  // ---- Test 3: flush drains a multi-row backlog in async mode ----
  await test('ADR-0002: parallel flush drains a multi-row backlog before search runs', async () => {
    const prev = process.env.MYBRAIN_ASYNC_STORAGE;
    process.env.MYBRAIN_ASYNC_STORAGE = 'true';
    const ids = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await insertPendingThought(`Backlog row ${i}`));
    }
    try {
      await handlers.get('agent_search')({
        query: 'backlog drain check',
        threshold: 0.0,
        limit: 50,
      });
      const check = await pool.query(
        `SELECT count(*)::int AS pending FROM thoughts WHERE id = ANY($1) AND embedding IS NULL`,
        [ids]
      );
      assert.equal(check.rows[0].pending, 0,
        'every backlog row must have been embedded by the parallel flush');
    } finally {
      if (prev === undefined) delete process.env.MYBRAIN_ASYNC_STORAGE;
      else process.env.MYBRAIN_ASYNC_STORAGE = prev;
    }
  });

  // ---- Cleanup ----
  await test('cleanup', async () => {
    const adminClient = await pool.connect();
    try {
      await adminClient.query(`SET search_path TO public`);
      await adminClient.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    } finally {
      adminClient.release();
    }
    await pool.end();
    await new Promise((resolve) => embedServer.close(resolve));
  });
}
