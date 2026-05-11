/**
 * Behavioral integration tests for inline relations on agent_capture
 * (mybrain ADR-0001 — inline relations).
 *
 * Skips gracefully when MYBRAIN_TEST_DATABASE_URL is unset or the DB is
 * unreachable. Requires PostgreSQL with pgvector + ltree.
 *
 * Five cases (per the implementation brief):
 *   (a) capture with no relations       → existing behavior unchanged
 *   (b) capture with one relation
 *   (c) capture with multiple relations
 *   (d) capture with both supersedes_id AND a supersedes entry in relations
 *       → must error (ambiguous), thought is NOT inserted
 *   (e) capture where a relation insert fails (unknown target_id)
 *       → must roll back the new thought (no orphaned row)
 *
 * Schema isolation: dedicated `mybrain_test_inline_relations` schema, dropped
 * CASCADE at teardown. Same pattern as protocol-tools.test.mjs.
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
const TEST_SCHEMA = 'mybrain_test_inline_relations';

// ADR-0058 BUG-005: hard MYBRAIN_TEST_DATABASE_URL requirement; abort on
// non-localhost hosts to prevent the 2026-04-29-style RDS wipe.
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
  test('SKIP: inline-relations.test.mjs (database unreachable)', () => {
    console.error(`[SKIP] ${dbProbe.reason}`);
  });
} else {
  await runSuite();
}

async function runSuite() {
  // ---- Fake openai-compat embeddings server ----
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

  const pool = createPool(DATABASE_URL);
  pool.on('connect', (client) => {
    client.query(`SET search_path TO ${TEST_SCHEMA}, public`).catch(() => {});
  });

  // ---- Schema isolation ----
  {
    const adminClient = await pool.connect();
    try {
      await adminClient.query(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);
      await adminClient.query(`SET search_path TO ${TEST_SCHEMA}, public`);
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
      `).catch(() => {});

      const schemaSrc = readFileSync(SCHEMA_PATH, 'utf-8').replaceAll('{{EMBED_DIM}}', '3');
      await adminClient.query(schemaSrc);
      await adminClient.query(`UPDATE brain_config SET brain_enabled = true WHERE id = 1`);
    } finally {
      adminClient.release();
    }
  }

  resetBrainConfigCache();

  const handlers = new Map();
  const stubSrv = {
    tool(name, _desc, _schema, handler) { handlers.set(name, handler); },
  };

  const cfg = {
    embedProviderConfig: {
      family: 'openai-compat', baseUrl: embedBaseUrl, apiKey: 'test-key',
      model: 'fake-embed', extraHeaders: {},
    },
    chatProviderConfig: {
      family: 'openai-compat', baseUrl: embedBaseUrl, apiKey: 'test-key',
      model: 'fake-chat', extraHeaders: {},
    },
    brain_name: 'test-brain',
    capturedBy: 'tester <tester@example.com>',
    apiToken: null,
    _source: 'test',
  };

  registerTools(stubSrv, pool, cfg);

  function parseToolResult(result) {
    assert.ok(result.content && result.content[0] && typeof result.content[0].text === 'string',
      'tool result must be { content: [{ type, text }] }');
    if (result.isError) {
      throw new Error(`tool reported error: ${result.content[0].text}`);
    }
    try {
      return JSON.parse(result.content[0].text);
    } catch {
      return result.content[0].text;
    }
  }

  function expectError(result) {
    assert.equal(result.isError, true, `expected isError=true; got ${JSON.stringify(result)}`);
    return result.content[0].text;
  }

  // Convenience: capture a baseline thought we can target.
  async function capture(content, opts = {}) {
    const r = await handlers.get('agent_capture')({
      content,
      thought_type: opts.thought_type || 'lesson',
      source_agent: 'colby',
      source_phase: 'qa',
      importance: 0.5,
      ...opts,
    });
    return parseToolResult(r);
  }

  // ===== (a) capture with no relations — existing behavior unchanged =====
  await test('(a) capture without relations[] preserves existing response shape', async () => {
    const body = await capture('Baseline thought without inline relations.');
    assert.match(body.thought_id, /^[0-9a-f-]{36}$/);
    assert.equal(body.captured_by, cfg.capturedBy);
    assert.equal(typeof body.conflict_flag, 'boolean');
    assert.deepEqual(body.related_ids, [], 'related_ids must be empty when no relations were created');
    assert.ok(body.created_at, 'created_at must be present');
    assert.equal(body.warning, undefined, 'warning must be absent on the no-relations path');
  });

  // ===== (b) capture with one relation =====
  await test('(b) capture with one inline relation creates the edge atomically', async () => {
    const target = await capture('Target thought for one-relation test.');

    const newCap = await capture('Source thought with one inline relation.', {
      relations: [
        { target_id: target.thought_id, relation_type: 'evolves_from', context: 'one-relation test' },
      ],
    });

    assert.match(newCap.thought_id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(newCap.related_ids, [target.thought_id]);

    // Verify the edge actually landed in thought_relations.
    const r = await pool.query(
      `SELECT relation_type, context FROM thought_relations
        WHERE source_id = $1 AND target_id = $2`,
      [newCap.thought_id, target.thought_id]
    );
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].relation_type, 'evolves_from');
    assert.equal(r.rows[0].context, 'one-relation test');

    // And: atelier_trace should now find target as a backward neighbor.
    const trace = parseToolResult(await handlers.get('atelier_trace')({
      thought_id: newCap.thought_id, direction: 'backward', max_depth: 3,
    }));
    const ids = trace.chain.map(n => n.id);
    assert.ok(ids.includes(target.thought_id),
      `backward trace from ${newCap.thought_id} must include ${target.thought_id}; got ${JSON.stringify(ids)}`);
  });

  // ===== (c) capture with multiple relations =====
  await test('(c) capture with multiple inline relations creates all edges in one transaction', async () => {
    const t1 = await capture('Target A for multi-relation test.');
    const t2 = await capture('Target B for multi-relation test.');
    const t3 = await capture('Target C for multi-relation test.');

    const newCap = await capture('Source thought with three inline relations.', {
      relations: [
        { target_id: t1.thought_id, relation_type: 'supports' },
        { target_id: t2.thought_id, relation_type: 'evolves_from', context: 'B' },
        { target_id: t3.thought_id, relation_type: 'triggered_by',  context: 'C' },
      ],
    });

    assert.equal(newCap.related_ids.length, 3, 'all three target ids should be reflected in related_ids');
    for (const id of [t1.thought_id, t2.thought_id, t3.thought_id]) {
      assert.ok(newCap.related_ids.includes(id), `related_ids missing ${id}`);
    }

    const r = await pool.query(
      `SELECT target_id, relation_type FROM thought_relations
        WHERE source_id = $1
        ORDER BY relation_type`,
      [newCap.thought_id]
    );
    assert.equal(r.rows.length, 3, 'three relation rows must exist');
    const byType = Object.fromEntries(r.rows.map(row => [row.relation_type, row.target_id]));
    assert.equal(byType.supports,      t1.thought_id);
    assert.equal(byType.evolves_from,  t2.thought_id);
    assert.equal(byType.triggered_by,  t3.thought_id);
  });

  // ===== (c2) capture with an inline 'supersedes' relation marks the target =====
  await test("(c2) inline relation_type='supersedes' marks the target row superseded", async () => {
    const old = await capture('Old decision-equivalent (supersession test).');

    const newCap = await capture('New thought that supersedes the old one.', {
      relations: [
        { target_id: old.thought_id, relation_type: 'supersedes', context: 'inline supersedes' },
      ],
    });

    assert.deepEqual(newCap.related_ids, [old.thought_id]);

    const r = await pool.query(
      `SELECT status, invalidated_at FROM thoughts WHERE id = $1`,
      [old.thought_id]
    );
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].status, 'superseded');
    assert.ok(r.rows[0].invalidated_at !== null, 'invalidated_at must be set on the superseded target');
  });

  // ===== (d) supersedes_id + relations[supersedes] = ambiguous error =====
  await test('(d) supersedes_id + inline supersedes relation is rejected as ambiguous; thought not inserted', async () => {
    const target = await capture('Target for the ambiguity-error test.');
    const before = await pool.query(`SELECT count(*)::int AS n FROM thoughts`);

    const result = await handlers.get('agent_capture')({
      content: 'Capture that should be rejected — both supersedes_id and inline supersedes provided.',
      thought_type: 'lesson',
      source_agent: 'colby',
      source_phase: 'qa',
      importance: 0.5,
      supersedes_id: target.thought_id,
      relations: [
        { target_id: target.thought_id, relation_type: 'supersedes' },
      ],
    });
    const errText = expectError(result);
    assert.match(errText, /both 'supersedes_id' and a 'supersedes' entry/);

    const after = await pool.query(`SELECT count(*)::int AS n FROM thoughts`);
    assert.equal(after.rows[0].n, before.rows[0].n,
      'no new thought row may be inserted when the API rejects the call');
  });

  // ===== (e) failed relation insert rolls back the new thought =====
  await test('(e) unknown target_id in relations[] rolls back the entire capture', async () => {
    const before = await pool.query(`SELECT count(*)::int AS n FROM thoughts`);
    const beforeRels = await pool.query(`SELECT count(*)::int AS n FROM thought_relations`);
    const fakeUuid = '00000000-0000-4000-8000-000000000001'; // valid uuid, no such row

    const result = await handlers.get('agent_capture')({
      content: 'Capture that should fully roll back: target does not exist.',
      thought_type: 'lesson',
      source_agent: 'colby',
      source_phase: 'qa',
      importance: 0.5,
      relations: [
        { target_id: fakeUuid, relation_type: 'evolves_from' },
      ],
    });
    const errText = expectError(result);
    assert.match(errText, /unknown thought id/);
    assert.match(errText, new RegExp(fakeUuid));

    const after = await pool.query(`SELECT count(*)::int AS n FROM thoughts`);
    const afterRels = await pool.query(`SELECT count(*)::int AS n FROM thought_relations`);
    assert.equal(after.rows[0].n, before.rows[0].n,
      'thought row must be rolled back when an inline relation insert fails');
    assert.equal(afterRels.rows[0].n, beforeRels.rows[0].n,
      'no relation rows may persist when the transaction aborts');
  });

  // ===== (e2) duplicate (target_id, relation_type) within relations[] is rejected =====
  await test("(e2) duplicate (target_id, relation_type) in relations[] is rejected at the API boundary", async () => {
    const target = await capture('Target for the dedup-error test.');
    const before = await pool.query(`SELECT count(*)::int AS n FROM thoughts`);

    const result = await handlers.get('agent_capture')({
      content: 'Capture with duplicate inline relation entries.',
      thought_type: 'lesson',
      source_agent: 'colby',
      source_phase: 'qa',
      importance: 0.5,
      relations: [
        { target_id: target.thought_id, relation_type: 'supports' },
        { target_id: target.thought_id, relation_type: 'supports' },
      ],
    });
    const errText = expectError(result);
    assert.match(errText, /duplicate entry in 'relations'/);

    const after = await pool.query(`SELECT count(*)::int AS n FROM thoughts`);
    assert.equal(after.rows[0].n, before.rows[0].n,
      'duplicate-rejection must occur before any insert');
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
