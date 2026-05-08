/**
 * Config resolution test (no DB).
 *
 * Verifies lib/config.mjs resolveConfig() behavior:
 *   1. cwd config inside a Claude Desktop extension folder is skipped,
 *      so a hostile/leftover config there does not shadow the user's
 *      ~/.claude/brain-config.json.
 *   2. cwd config NOT inside a Claude Desktop extension folder resolves
 *      normally (legitimate project-local config still works).
 *   3. _source field accurately reflects which path was loaded, with
 *      a distinct sentinel value when the cwd skip caused fallthrough.
 *
 * Reproduces the 2026-05-07 .mcpb failure where Frank's
 * `Claude Extensions/local.mcpb.robert-sfeir.mybrain/.claude/brain-config.json`
 * (created by some prior install path, missing openrouter_api_key)
 * silently shadowed his working ~/.claude/brain-config.json.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveConfig } from '../../lib/config.mjs';

// Save originals once so each test can restore between cases.
const ORIGINAL_CWD = process.cwd();
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_BRAIN_PROJECT = process.env.BRAIN_CONFIG_PROJECT;
const ORIGINAL_BRAIN_USER = process.env.BRAIN_CONFIG_USER;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_ATELIER_BRAIN_DATABASE_URL = process.env.ATELIER_BRAIN_DATABASE_URL;

function setHome(homeDir) {
  // os.homedir() honors $HOME on POSIX. The test's resolveConfig uses
  // os.homedir() to build homePath, so overriding $HOME is enough to
  // redirect the home lookup at a temp dir.
  process.env.HOME = homeDir;
}

function clearEnvOverrides() {
  delete process.env.BRAIN_CONFIG_PROJECT;
  delete process.env.BRAIN_CONFIG_USER;
  // The bare-env-var fallback fires if no config file is found AND
  // DATABASE_URL is set. Clear both so we test the file-resolution path
  // in isolation.
  delete process.env.DATABASE_URL;
  delete process.env.ATELIER_BRAIN_DATABASE_URL;
}

function restoreEnv() {
  process.chdir(ORIGINAL_CWD);
  process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_BRAIN_PROJECT === undefined) delete process.env.BRAIN_CONFIG_PROJECT;
  else process.env.BRAIN_CONFIG_PROJECT = ORIGINAL_BRAIN_PROJECT;
  if (ORIGINAL_BRAIN_USER === undefined) delete process.env.BRAIN_CONFIG_USER;
  else process.env.BRAIN_CONFIG_USER = ORIGINAL_BRAIN_USER;
  if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  if (ORIGINAL_ATELIER_BRAIN_DATABASE_URL === undefined) delete process.env.ATELIER_BRAIN_DATABASE_URL;
  else process.env.ATELIER_BRAIN_DATABASE_URL = ORIGINAL_ATELIER_BRAIN_DATABASE_URL;
}

function makeFakeHome(tmpRoot) {
  const home = path.join(tmpRoot, 'home');
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  return home;
}

function writeBrainConfig(dir, content) {
  const claudeDir = path.join(dir, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(path.join(claudeDir, 'brain-config.json'), JSON.stringify(content));
}

await test('cwd inside a Claude Extensions folder is skipped, falling through to home', () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'mybrain-cfg-skip-'));
  try {
    clearEnvOverrides();
    const home = makeFakeHome(tmpRoot);
    setHome(home);

    // Hostile cwd: matches the .mcpb install path shape.
    const extensionDir = path.join(tmpRoot, 'Claude Extensions', 'local.mcpb.test-ext');
    mkdirSync(extensionDir, { recursive: true });
    writeBrainConfig(extensionDir, {
      database_url: 'postgresql://wrong:wrong@cwd-shadow:5432/wrong',
      // Deliberately missing openrouter_api_key -- mirrors Frank's case.
    });

    // Real user config in ~/.claude/.
    writeBrainConfig(home, {
      database_url: 'postgresql://user:user@home:5432/mybrain',
      openrouter_api_key: 'sk-or-real',
    });

    process.chdir(extensionDir);
    const cfg = resolveConfig();
    assert.ok(cfg, 'resolveConfig must return a config');
    assert.equal(
      cfg.database_url,
      'postgresql://user:user@home:5432/mybrain',
      'must load home config, not the shadowing extension cwd config'
    );
    assert.equal(cfg.openrouter_api_key, 'sk-or-real');
    assert.equal(
      cfg._source,
      'personal-home-extension-cwd-skipped',
      '_source must record that the cwd skip fired'
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
    restoreEnv();
  }
});

await test('cwd outside Claude Extensions resolves project-cwd normally', () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'mybrain-cfg-cwd-'));
  try {
    clearEnvOverrides();
    const home = makeFakeHome(tmpRoot);
    setHome(home);

    // Plain project dir -- no "Claude Extensions" segment.
    const projectDir = path.join(tmpRoot, 'projects', 'my-app');
    mkdirSync(projectDir, { recursive: true });
    writeBrainConfig(projectDir, {
      database_url: 'postgresql://user:user@cwd:5432/mybrain',
      openrouter_api_key: 'sk-or-cwd',
    });

    // Home config also exists -- cwd should still win for legitimate dirs.
    writeBrainConfig(home, {
      database_url: 'postgresql://user:user@home:5432/mybrain',
      openrouter_api_key: 'sk-or-home',
    });

    process.chdir(projectDir);
    const cfg = resolveConfig();
    assert.ok(cfg);
    assert.equal(cfg.database_url, 'postgresql://user:user@cwd:5432/mybrain');
    assert.equal(cfg._source, 'project-cwd', 'normal cwd resolution must report project-cwd');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
    restoreEnv();
  }
});

await test('home-only resolution reports personal-home (no skip, no cwd config)', () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'mybrain-cfg-home-'));
  try {
    clearEnvOverrides();
    const home = makeFakeHome(tmpRoot);
    setHome(home);

    const emptyDir = path.join(tmpRoot, 'empty');
    mkdirSync(emptyDir, { recursive: true });

    writeBrainConfig(home, {
      database_url: 'postgresql://user:user@home:5432/mybrain',
      openrouter_api_key: 'sk-or-only-home',
    });

    process.chdir(emptyDir);
    const cfg = resolveConfig();
    assert.ok(cfg);
    assert.equal(cfg.database_url, 'postgresql://user:user@home:5432/mybrain');
    assert.equal(cfg._source, 'personal-home');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
    restoreEnv();
  }
});
