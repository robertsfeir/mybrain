/**
 * Startup-log writer test (no DB).
 *
 * Verifies lib/startup-log.mjs:
 *   1. writeStartupFailure creates the log directory if missing
 *   2. multiple calls append (do not overwrite) the file
 *   3. malformed input does not throw
 *   4. getStartupLogPath returns an absolute path under the user's home
 *
 * The module is the operator's only signal when Claude Desktop's .mcpb
 * runtime swallows stderr (see Frank's 2026-05-07 install). If this
 * module ever throws or no-ops, the original failure path is
 * unobservable -- so its tests are particularly load-bearing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getStartupLogPath, writeStartupFailure } from '../../lib/startup-log.mjs';

const ORIGINAL_HOME = process.env.HOME;

function withFakeHome(fn) {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'mybrain-startup-log-'));
  process.env.HOME = tmpRoot;
  try {
    return fn(tmpRoot);
  } finally {
    process.env.HOME = ORIGINAL_HOME;
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

await test('getStartupLogPath returns an absolute path under home', () => {
  withFakeHome((home) => {
    const p = getStartupLogPath();
    assert.ok(path.isAbsolute(p), `expected absolute path, got ${p}`);
    assert.ok(p.startsWith(home), `expected path under fake home (${home}), got ${p}`);
    assert.ok(p.endsWith('startup.log'), `expected startup.log filename, got ${p}`);
  });
});

await test('writeStartupFailure creates ~/.mybrain/ if missing and writes a block', () => {
  withFakeHome((home) => {
    const logDir = path.join(home, '.mybrain');
    assert.equal(existsSync(logDir), false, 'precondition: ~/.mybrain must not exist');

    writeStartupFailure('test failure A', { config_source: 'test-source' });

    assert.equal(existsSync(logDir), true, '~/.mybrain must be created');
    assert.equal(statSync(logDir).isDirectory(), true);

    const logPath = getStartupLogPath();
    assert.equal(existsSync(logPath), true, 'startup.log must be created');

    const content = readFileSync(logPath, 'utf-8');
    assert.match(content, /mybrain startup failed/);
    assert.match(content, /reason: test failure A/);
    assert.match(content, /config_source: test-source/);
    assert.match(content, /node_version: /);
    assert.match(content, /cwd: /);
    assert.match(content, /---/);
  });
});

await test('writeStartupFailure appends across calls (does not overwrite)', () => {
  withFakeHome(() => {
    writeStartupFailure('first failure');
    writeStartupFailure('second failure');

    const content = readFileSync(getStartupLogPath(), 'utf-8');
    assert.match(content, /first failure/);
    assert.match(content, /second failure/);

    // Both blocks present -> the file is bigger than a single block.
    const blocks = content.split('---').filter((b) => b.trim().length > 0);
    assert.ok(blocks.length >= 2, `expected at least 2 blocks, got ${blocks.length}`);
  });
});

await test('writeStartupFailure does not throw on weird input', () => {
  withFakeHome(() => {
    // None of these should throw. They may produce nonsense in the log
    // but that is fine -- the contract is "best-effort, never throws".
    assert.doesNotThrow(() => writeStartupFailure(undefined));
    assert.doesNotThrow(() => writeStartupFailure(null));
    assert.doesNotThrow(() => writeStartupFailure(''));
    assert.doesNotThrow(() => writeStartupFailure('multi\nline\nreason'));
    assert.doesNotThrow(() => writeStartupFailure(new Error('an Error object').toString()));
    // Non-string extras must be tolerated.
    assert.doesNotThrow(() => writeStartupFailure('reason', { num: 42, bool: true }));
  });
});
