/**
 * Behavioral integration tests for the 8 protocol tools (mybrain ADR-0001 Wave 5).
 *
 * Skips gracefully when DATABASE_URL / ATELIER_BRAIN_DATABASE_URL is unset
 * or the DB is unreachable. Requires PostgreSQL with pgvector + ltree.
 *
 * Test strategy:
 *   1. Apply templates/schema.sql with EMBED_DIM=3 to a real test DB.
 *   2. Spin up a tiny localhost HTTP server that mimics the openai-compat
 *      /embeddings endpoint and returns [0.1, 0.2, 0.3] for any input.
 *   3. Stub the McpServer.tool(name, desc, schema, handler) interface to
 *      capture handler refs by tool name.
 *   4. Call each handler directly with representative input and assert the
 *      response shape required by ADR-0001.
 *
 * Schema isolation: all tables are created inside the PostgreSQL schema
 * `mybrain_test_tools` to prevent parallel-test races against migration.test.mjs
 * which uses the same DB and the same table names. The schema is created at
 * setup and dropped (CASCADE) at teardown.
 *
 * Conflict detection is bypassed by using thought_type: 'lesson'
 * (tools.mjs:99 only triggers the conflict path on decision/preference).
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

// =============================================================================
// Paths + test DB URL
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'templates', 'schema.sql');
const TEST_SCHEMA = 'mybrain_test_tools';

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
  test('SKIP: protocol-tools.test.mjs (database unreachable)', () => {
    console.error(`[SKIP] ${dbProbe.reason}`);
  });
} else {
  await runSuite();
}

// =============================================================================
// Suite
// =============================================================================

async function runSuite() {
  // ---- Fake embeddings server (3-dim vector to match EMBED_DIM=3 schema) ----
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
        if (req.url.endsWith('/chat/completions')) {
          // Not exercised in this suite (we avoid decision/preference thought
          // types so detectConflicts never calls chat). Returned for safety.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{ message: { content: '{"classification":"NOVEL","confidence":0.9,"reasoning":"test"}' } }],
          }));
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

  // ---- Test pool wired to isolated schema ----
  const pool = createPool(DATABASE_URL);

  // Route every connection in this pool to the isolated schema so that all
  // DDL and DML land in mybrain_test_tools, not public.
  pool.on('connect', (client) => {
    client.query(`SET search_path TO ${TEST_SCHEMA}, public`).catch(() => {});
  });

  // ---- Schema isolation: create dedicated test schema ----
  // Use a raw client (bypasses pool routing) to create the schema itself first.
  {
    const adminClient = await pool.connect();
    try {
      await adminClient.query(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);
      await adminClient.query(`SET search_path TO ${TEST_SCHEMA}, public`);

      // Drop any tables left from a failed prior run within this schema.
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

      const schemaSrc = readFileSync(SCHEMA_PATH, 'utf-8').replaceAll('{{EMBED_DIM}}', '3');
      await adminClient.query(schemaSrc);
      // brain_enabled defaults to false; flip on so atelier_stats reports true.
      await adminClient.query(`UPDATE brain_config SET brain_enabled = true WHERE id = 1`);
    } finally {
      adminClient.release();
    }
  }

  resetBrainConfigCache();

  // ---- Stub MCP server: capture tool handlers ----
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

  // Sanity: all 8 tools registered.
  const expected = [
    'agent_capture', 'agent_search', 'atelier_browse', 'atelier_stats',
    'atelier_relation', 'atelier_trace', 'atelier_hydrate', 'atelier_hydrate_status',
  ];
  for (const name of expected) {
    assert.ok(handlers.has(name), `expected tool "${name}" to be registered`);
  }

  function parseToolResult(result) {
    assert.ok(result.content && result.content[0] && typeof result.content[0].text === 'string',
      'tool result must be { content: [{ type, text }] }');
    if (result.isError) {
      throw new Error(`tool reported error: ${result.content[0].text}`);
    }
    try {
      return JSON.parse(result.content[0].text);
    } catch {
      return result.content[0].text; // some tools may emit plain text
    }
  }

  // ---------- agent_capture ----------
  await test('agent_capture returns thought_id, captured_by, conflict_flag, related_ids', async () => {
    const r = await handlers.get('agent_capture')({
      content: 'Test lesson learned during integration tests.',
      thought_type: 'lesson', // bypasses conflict detection (decision/preference only)
      source_agent: 'colby',
      source_phase: 'qa',
      importance: 0.6,
    });
    const body = parseToolResult(r);
    assert.match(body.thought_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(body.captured_by, cfg.capturedBy);
    assert.equal(typeof body.conflict_flag, 'boolean');
    assert.ok(Array.isArray(body.related_ids));
  });

  // ---------- agent_search ----------
  await test('agent_search returns { results: [...] }', async () => {
    const r = await handlers.get('agent_search')({
      query: 'integration tests',
      threshold: 0.0, // 3-dim test vectors collapse similarity; allow all
      limit: 10,
    });
    const body = parseToolResult(r);
    assert.ok(Array.isArray(body.results), 'results must be an array');
  });

  // ---------- atelier_browse ----------
  await test('atelier_browse returns { thoughts, total, limit, offset }', async () => {
    const r = await handlers.get('atelier_browse')({ limit: 20, offset: 0 });
    const body = parseToolResult(r);
    assert.ok(Array.isArray(body.thoughts), 'thoughts must be an array');
    assert.equal(typeof body.total, 'number');
    assert.equal(body.limit, 20);
    assert.equal(body.offset, 0);
  });

  // ---------- atelier_stats ----------
  await test('atelier_stats returns { brain_enabled, total, active, by_type, ... }', async () => {
    const r = await handlers.get('atelier_stats')({});
    const body = parseToolResult(r);
    assert.equal(typeof body.brain_enabled, 'boolean');
    assert.equal(typeof body.total, 'number');
    assert.equal(typeof body.active, 'number');
    assert.equal(typeof body.by_type, 'object');
    assert.ok(body.by_type !== null);
  });

  // ---------- atelier_relation ----------
  // Need two thoughts to relate. Insert a second one first.
  await test('atelier_relation creates a typed edge between two thoughts', async () => {
    const a = parseToolResult(await handlers.get('agent_capture')({
      content: 'First thought for relation test.',
      thought_type: 'lesson', source_agent: 'colby', source_phase: 'qa', importance: 0.5,
    }));
    const b = parseToolResult(await handlers.get('agent_capture')({
      content: 'Second thought for relation test.',
      thought_type: 'lesson', source_agent: 'colby', source_phase: 'qa', importance: 0.5,
    }));
    const r = await handlers.get('atelier_relation')({
      source_id: a.thought_id,
      target_id: b.thought_id,
      relation_type: 'supports',
      context: 'integration test',
    });
    const body = parseToolResult(r);
    assert.equal(body.created, true);
    assert.equal(body.source_id, a.thought_id);
    assert.equal(body.target_id, b.thought_id);
    assert.equal(body.relation_type, 'supports');
  });

  // ---------- atelier_trace ----------
  await test('atelier_trace returns { chain: [...] }', async () => {
    // Use any existing thought id.
    const browse = parseToolResult(await handlers.get('atelier_browse')({ limit: 1, offset: 0 }));
    assert.ok(browse.thoughts.length > 0, 'fixture: at least one thought must exist');
    const r = await handlers.get('atelier_trace')({
      thought_id: browse.thoughts[0].id,
      direction: 'both',
      max_depth: 5,
    });
    const body = parseToolResult(r);
    assert.ok(Array.isArray(body.chain), 'chain must be an array');
    assert.ok(body.chain.length >= 1, 'chain must include at least the root thought');
  });

  // ---------- atelier_hydrate ----------
  await test('atelier_hydrate returns { status: "queued", session_path }', async () => {
    // Use a path that does NOT exist; the tool should still queue (background
    // worker will record an error in the status map, but the synchronous
    // response is "queued" by contract).
    const r = await handlers.get('atelier_hydrate')({ session_path: '/tmp/nonexistent-mybrain-test-path' });
    const body = parseToolResult(r);
    assert.equal(body.status, 'queued');
    assert.equal(typeof body.session_path, 'string');
  });

  // ---------- atelier_hydrate_status ----------
  await test('atelier_hydrate_status returns one of idle/running/completed/error', async () => {
    const r = await handlers.get('atelier_hydrate_status')({ session_path: '/tmp/some-other-path' });
    const body = parseToolResult(r);
    assert.ok(['idle', 'running', 'completed', 'error'].includes(body.status),
      `status must be idle/running/completed/error, got "${body.status}"`);
  });

  // ---- Cleanup: drop the isolated schema, close the pool, stop embed server ----
  await test('cleanup', async () => {
    // Drop the test schema and all objects within it.
    const adminClient = await pool.connect();
    try {
      // Reset search_path to default so the DROP SCHEMA command itself isn't
      // restricted to the schema being dropped.
      await adminClient.query(`SET search_path TO public`);
      await adminClient.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    } finally {
      adminClient.release();
    }
    await pool.end();
    await new Promise((resolve) => embedServer.close(resolve));
  });
}
