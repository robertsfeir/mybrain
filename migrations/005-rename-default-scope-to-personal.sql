-- 005-rename-default-scope-to-personal.sql
-- Re-tag thoughts captured under the legacy "default" scope as "personal".
--
-- Background:
--   Prior to v2.3.5, lib/tools.mjs:110 fell back to scope=["default"] when
--   the agent_capture caller did not pass an explicit `scope` parameter.
--   "default" is a meaningless label for an ltree namespace and made
--   scope-filtered searches unhelpful by default. v2.3.5 changes the
--   fallback to "personal" and wires the BRAIN_SCOPE env var through to
--   override the fallback per-install.
--
-- Safe properties:
--   - Idempotent: WHERE scope = ARRAY['default']::ltree[] is a no-op once
--     the rows have been migrated. Re-running on a freshly-migrated DB
--     touches zero rows.
--   - Targeted: matches only thoughts whose scope is *exactly* the
--     single-element array ['default']. Multi-element scopes that happen
--     to contain 'default' (e.g. ['default', 'work']) are left alone --
--     those carry intentional information that this rename should not
--     destroy.
--   - No data loss: only the `scope` column is rewritten. Content,
--     embeddings, relations, metadata, importance, status are untouched.
--
-- The migration runner (lib/db.mjs) records this file in schema_migrations
-- on success, so future startups skip it.

UPDATE thoughts
SET scope = ARRAY['personal']::ltree[]
WHERE scope = ARRAY['default']::ltree[];
