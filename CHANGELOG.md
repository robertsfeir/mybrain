# Changelog

All notable changes to mybrain-mcp are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [2.3.3] — 2026-05-06

### Changed
- **`/mybrain-setup` registration steps now branch on install path for all four backends.** B6 (Bundled), D8 (Docker), N6 (Native), and R4 (RDS) each present two registration branches: **CoWork plugin path** (open Customize → mybrain → Settings, enter `database_url` / `embedding_api_key` / `brain_scope`) and **CLI per-project path** (`claude mcp add` with local scope). Previously only D8 had the CoWork branch; N6 and R4 were CLI-only. The database backend question is now always asked first regardless of install path.

---

## [2.2.2] — 2026-05-04

### Changed
- **`/mybrain-setup` now sets `alwaysLoad: true` after every `claude mcp add` call** (B6, D8, N6, R4). Claude Code v2.1.121 added an `alwaysLoad` option to the MCP server config — when true, all tools from that server skip deferred tool-search loading and are immediately callable from session start. Without this, mybrain tools appeared as deferred every session and required a ToolSearch round-trip before first use, which caused the atelier pipeline's brain-capture PreToolUse hook to fire before tools were loaded. The setup step adds the field via a short Python snippet that patches `~/.claude.json` in place after `claude mcp add` writes the base registration.

---

## [2.2.1] — 2026-05-04

### Removed
- **`.mcp.json` deleted from the plugin source.** This file was added in v0.2.0 (commit `ffa921a`) as a convenience: install the plugin, have `DATABASE_URL` and `OPENROUTER_API_KEY` exported in your shell, and the plugin's `server.mjs` would run as a stdio child of Claude Code. When the plugin was installed via the marketplace, the file landed in the plugin cache and Claude Code's plugin loader auto-registered it as **`plugin:mybrain:mybrain`** with a hard-coded `BRAIN_SCOPE: "personal"` — applying to every project on the machine. This was the primary cause of the "thoughts attributed to the wrong project" symptom that v2.2.0 set out to fix; removing the `--scope user` recommendation alone in v2.2.0 was necessary but insufficient because the plugin loader was still auto-registering the same shape independently. v2.2.1 removes the file entirely. After v2.2.1, the plugin ships skills + templates + server code only — the only path to a working MCP registration is `/mybrain-setup`, which always uses `claude mcp add` with local scope per-project.

### Changed
- **`/mybrain-setup` Step 0 now also detects `plugin:mybrain:mybrain` entries.** When `claude mcp list` shows that name, Step 0 explains that it came from a v2.2.0-or-earlier `.mcp.json` cached in the plugin install, and walks the user through clearing it via `claude plugin update mybrain@mybrain` (or uninstall+reinstall). The `plugin:` prefix is the scope indicator — these entries cannot be removed with `claude mcp remove`; they are managed by the plugin loader. After upgrading to v2.2.1+ the plugin cache no longer contains `.mcp.json`, so `plugin:mybrain:mybrain` disappears on next Claude Code restart.
- **README updated** to make explicit that the plugin no longer auto-registers an MCP server. The plugin is a delivery vehicle for skills, templates, and server source — every per-project install of mybrain is an explicit `claude mcp add` driven by `/mybrain-setup`.

### Migration notes
- **Users who installed v2.2.0 or earlier** — your plugin cache likely still has the `.mcp.json` and is auto-registering `plugin:mybrain:mybrain`. Run `claude mcp list` to confirm. To clear it, upgrade the plugin (`claude plugin update mybrain@mybrain`) or uninstall + reinstall, then restart Claude Code. After that, `/mybrain-setup` produces the canonical per-project local-scope registration.
- **Brain data (databases, containers, volumes) is unaffected** by the upgrade; only the Claude Code registration changes shape.
- **If a user relied on the auto-registration's "DATABASE_URL from shell env" behavior**, they need to run `/mybrain-setup` to re-create that behavior explicitly. The wizard will ask for the connection string and bake it into a per-project `claude mcp add -e` invocation. Per-repo `BRAIN_SCOPE` is set in the same command — no more shared `personal` default across all projects.

### Why this was missed in v2.2.0
The v2.2.0 audit looked at `claude mcp add` scope flags (`--scope user`, `--scope project`) and the documented setup paths. It did not inspect `.mcp.json` at the plugin root, which Claude Code's plugin loader treats as an auto-registration manifest independently of the scope flags. The two paths produced overlapping but distinct registrations (`plugin:mybrain:mybrain` from the manifest, `mybrain (scope: user)` from the documented setup). Fixing one without the other left the same cross-project bleed in place via the other path.

---

## [2.2.0] — 2026-05-04

### Changed
- **Install scope is now always per-project (local).** `/mybrain-setup` (`skills/mybrain-setup/SKILL.md`) registers the MCP server with `claude mcp add` using the default local scope only. Previous guidance recommended `--scope user` (and listed `--scope project` as an alternative) — both are now deprecated. User scope made one `mybrain` registration visible across every project on the machine, which caused two observed failure modes: (a) brains failing to start when multiple repos shared the same registration and raced for the same container/port, and (b) thoughts being attributed to the wrong project because the shared registration carried one repo's `BRAIN_SCOPE` into another's session.
- **Step 1 of setup reframed** from "Choose Deployment Mode" to "Choose Database Backend." The four backends (Bundled, Docker, Native, RDS) are unchanged and still selected the same way; the renaming makes explicit that this is a *data-location* question, not an *install-scope* question. Multiple repos can still share one DB by selecting RDS (or pointing several Native installs at the same Postgres) — `BRAIN_SCOPE` (ltree) keeps each repo's thoughts isolated. Sharing the **install** (one MCP registration across repos) is no longer supported.

### Added
- **Step 0 pre-flight in `/mybrain-setup`** runs `claude mcp list` before any scaffold or container work. If any `mybrain` (or `mybrain-*`) entry is registered with `user` or `project` scope, the skill explains the deprecation, asks the user to remove it via `claude mcp remove mybrain --scope <user|project>`, and warns that any **other** project on the machine that was relying on the shared registration will need to re-run `/mybrain-setup` once. Brain data (DBs, containers, volumes) is untouched — only the Claude Code registration is removed. If the user declines the cleanup, the install stops rather than creating a colliding local-scope entry alongside the deprecated one.
- **B6 / D8 / N6 / R4 troubleshooting hint**: each register-MCP subsection now states "local scope, this repo only" and points back at Step 0 if `claude mcp add` reports `mybrain` already exists. The four backends each carry one canonical `claude mcp add` invocation — no `--scope` flag, no alternatives.

### Migration notes
- **Existing installs created with `--scope user` continue to work** as long as only one project uses them at a time. No data migration is required. To adopt the new per-project model, run `claude mcp remove mybrain --scope user` once on the machine, then re-run `/mybrain-setup` inside each repo that needs a brain.
- **Existing installs created with `--scope project`** (registration written to `.mcp.json` and committed) should remove the `mybrain` entry from `.mcp.json` and re-run `/mybrain-setup` locally. The new flow does not write `.mcp.json` — registrations stay in the per-user, per-project Claude config.

---

## [2.1.0] — 2026-04-30

### Added
- **User Guide** (`guides/user-guide.md`): friendly, non-technical walkthrough of how MyBrain captures, scores, fades, and removes memories. Covers the mental model (thoughts, types, status), capture flow, three-axis scoring in plain English, TTL + recency decay with concrete numbers, duplicate/contradiction detection in three zones, reflections from clustering, scope hierarchy, soft-vs-hard removal, and an FAQ.
- **Technical Reference** (`guides/technical-reference.md`): deep reference verified against the source. Schema (every column, enum, index), `agent_capture` flow step by step, embedding subsystem (retries, async worker, `flushEmbedQueue` race fix), exact scoring SQL with decay table, conflict-detection decision tree with thresholds and the verbatim LLM prompt, consolidation algorithm (clustering, synthesis), TTL pass, removal-status matrix, traversal CTEs, ltree rules, full config + provider preset table, all 8 MCP tools with schemas, all 11 REST endpoints, hydration pipeline, and migrations.
- **Docs callout** at the top of `README.md` linking to both new guides.

### Changed
- **License: MIT → Apache 2.0.** `LICENSE` replaced with the canonical Apache 2.0 text. `package.json` SPDX identifier corrected (was previously `"ISC"`, never matched the shipped MIT LICENSE) and `templates/package.json` SPDX identifier updated to match. GitHub repo metadata auto-updates on merge.
- **README modernized**: stale legacy-tool references (`capture_thought` / `search_thoughts` / `browse_thoughts` / `brain_stats`) in §"What You Get", §"Async Memory Storage", §"Usage Examples", and the troubleshooting section replaced with current 8-tool API names. Added a per-call cost note covering embedding and chat costs.
- **CLAUDE.md source-layout entry** for `ui/` corrected — the directory is currently a placeholder, not populated with HTML/CSS/JS assets.

---

## [2.0.4] — 2026-04-30

### Fixed
- **Migration runner no longer hard-fails on missing `pg_dump`** (`lib/db.mjs`): when `spawnSync("pg_dump", ...)` returns `error.code === "ENOENT"` (binary not on PATH), the runner now logs a warning and proceeds without writing a pre-migration dump instead of aborting startup. The post-migration count gate still detects data loss; the operator simply will not have a rollback dump artifact. Other spawn errors (e.g. `EACCES` on the binary) and non-zero exits remain fatal. Without this fix, every install whose host lacked `postgresql-client` failed to start once the `thoughts` table held any rows.

---

## [2.0.3] — 2026-04-30

### Fixed
- **BUG-001**: `createSupersessionRelation` and the `conflict` branch in `handleRelations` now guard their `UPDATE thoughts SET status = ...` statements with `AND status = 'active'`. Without the guard, passing a `supersedes_id` pointing at an already-`expired` thought reclassified it to `superseded`, making it invisible to `handlePurgeExpired` permanently.
- **BUG-002**: `agent_capture` now rejects `decision` and `preference` captures that supply more than one scope. Conflict detection (`detectConflicts`) only inspects `scope[0]`; accepting multi-scope captures of these types silently dropped conflict detection on every non-first scope.
- **BUG-003**: `normalizeLtreeArray` wrapper added around `topMatch.scope` before calling `.some()` in the CONTRADICTION branch of `handleClassification`. Without it, a future node-postgres driver update returning `ltree[]` as a raw Postgres array string would throw `TypeError` and silently drop the conflict flag.
- **BUG-004**: All `DROP TABLE / FUNCTION / TYPE` statements in `migration.test.mjs` and `async-search-race.test.mjs` test setup blocks are now schema-qualified (`${TEST_SCHEMA}.thoughts`, etc.) and the `search_path` is pinned to the test schema only (no `, public` fallback) during the DROP block. The `.catch(() => {})` swallow is removed — setup failures now surface. This was the direct mechanism of the 2026-04-29 production database wipe.
- **BUG-005**: All four `tests/brain/*.test.mjs` files now read only `MYBRAIN_TEST_DATABASE_URL` (the three-fallback chain ending in `ATELIER_BRAIN_DATABASE_URL` is removed). A non-localhost host in `MYBRAIN_TEST_DATABASE_URL` triggers `process.exit(1)` before any query runs.

### Added
- **Podman test fixture** (`scripts/test-db.sh`): `up` subcommand starts a `pgvector/pgvector:0.7.1-pg16` container named `mybrain-test` on a free local port bound to `127.0.0.1`, waits for readiness, applies `templates/schema.sql`, and exports `MYBRAIN_TEST_DATABASE_URL`. `down` destroys the container. Container is the primary blast-radius boundary — no path from a passing `MYBRAIN_TEST_DATABASE_URL` to a production host.
- **`npm test` script**: `bash -c '_dbenv=$(mktemp) && ./scripts/test-db.sh up > "$_dbenv" && source "$_dbenv"; rm -f "$_dbenv"; node --test tests/brain/*.test.mjs; _rc=$?; ./scripts/test-db.sh down; exit $_rc'` — starts the fixture, runs the suite, tears down the container, and propagates the test-runner exit code.

---

## [2.0.0] — 2026-04-29

### Added
- **8-tool MCP API** (`agent_capture`, `agent_search`, `atelier_browse`, `atelier_stats`, `atelier_relation`, `atelier_trace`, `atelier_hydrate`, `atelier_hydrate_status`) — replaces the original 4-tool set with the full atelier-brain protocol
- **Typed thought relations** (`atelier_relation`): source/target edges with `supersedes`, `contradicts`, `refines`, `elaborates`, `invalidates` types; graph traversal via `atelier_trace`
- **Hydration pipeline** (`atelier_hydrate` / `atelier_hydrate_status`): session-scoped project context ingestion from disk
- **LLM provider abstraction**: pluggable embedding providers (OpenRouter, OpenAI, Ollama, Vertex, Bedrock) configurable via `brain-config.json`
- **Business logic layer** (`lib/`): conflict detection, TTL enforcement, consolidation, deduplication
- **REST management backend**: HTTP transport with `/health`, `/api/thoughts`, admin endpoints
- **v1-to-merged migration** (`migrations/001-mybrain-v1-to-merged.sql`): upgrades a mybrain v0.x database to the merged schema (new tables: `thought_relations`; new columns: `origin_pipeline`, `origin_context`, `trigger_when`, `captured_by`, `ttl_days`; new types; updated scoring function)
- **Protocol tests** (15 tests): full round-trip coverage of all 8 tools and migration path

### Changed
- Tool names renamed to atelier protocol: `capture_thought` → `agent_capture`, `search_thoughts` → `agent_search`, `browse_thoughts` → `atelier_browse`, `brain_stats` → `atelier_stats`
- `source_agent` enum expanded; `cal` and `roz` deprecated (present in migrated DBs only, not in fresh installs)
- Zod validation updated to v4.x

### Removed
- Legacy 4-tool API surface (replaced by 8-tool atelier protocol above)

---

## [0.3.0] — 2026-04-28

### Added
- **Four deployment modes**: Bundled (single container: PG + Ollama + MCP, no API key needed), Docker (multi-container with optional Ollama compose profile), Native (host-installed Ollama + any reachable Postgres, no Docker), RDS/remote (existing cloud Postgres + OpenRouter)
- **Ollama embedding support**: `EMBEDDING_PROVIDER=ollama` routes embeddings to a local Ollama instance. Default model `gte-qwen2-1.5b-instruct` (1536-dim native, matches default schema); override via `OLLAMA_MODEL` env var
- **Bundled container**: `templates/Dockerfile.bundled`, `templates/compose.bundled.yml`, `templates/start.sh` — PostgreSQL, Ollama, and the MCP server in one image under `tini`. Only port 8787 exposed to the host. `restart: unless-stopped` + `OLLAMA_KEEP_ALIVE=-1` for always-on operation
- **Async memory storage**: `MYBRAIN_ASYNC_STORAGE=true` — `capture_thought` inserts with `embedding=NULL` and returns in ~3 ms; a background worker backfills embeddings. The `thoughts` table is the queue — durable across crashes, no extra services
- **Shell preflight wrappers** (`shell/`): `mybrain.{zsh,bash,fish,csh,tcsh}` + `mybrain-preflight.sh` — health-check the MCP container before launching `claude`. Animated spinner, Ctrl+C fallback (Claude always starts), tunables for timeout and quiet mode
- **`/health` endpoint**: `GET /health` → `{"status":"ok"}` in HTTP transport mode
- **Startup dim-detection probe**: reads the actual `embedding` column dimension from `information_schema` at boot and logs it (e.g. `embedding dim: 1536 (detected)`). Informational only
- **`MCP_TRANSPORT` env var**: overrides `process.argv[2]` for transport mode selection (`stdio` or `http`)
- **Embed worker failure cap**: in-memory map tracks per-row failure count; rows that fail 5 consecutive times are skipped and logged, preventing poison-pill queue starvation
- **Setup wizard**: `/mybrain-setup` skill updated with all four deployment mode flows including Native mode and optional shell wrapper installation

### Changed
- `templates/schema.sql`: `vector(1536)` replaced with `{{EMBED_DIM}}` template placeholder (substituted at scaffold time via `sed`). Default is 1536; opt into 1024 by passing `{{EMBED_DIM}}=1024` at scaffold. Existing installs are never auto-migrated
- `match_thoughts_scored()`: added `t.embedding IS NOT NULL` guard — required for rows inserted by async storage before the worker backfills them
- `templates/server.mjs` converted to a symlink of root `server.mjs` (single source of truth)
- README rewritten to cover all four deployment modes, correct default model, async storage, and shell wrappers

---

## [0.2.0] — 2026-03-22

### Added
- RDS mode: connect to a shared PostgreSQL on AWS RDS (or any remote Postgres with `pgvector` + `ltree`)
- `ltree` scoping on the `thoughts` table — multiple users/projects can share one database without leaking thoughts across scopes (`BRAIN_SCOPE` env var)
- Plugin marketplace structure (`.claude-plugin/marketplace.json`)

---

## [0.1.0] — 2026-03-18

### Added
- Initial mybrain-mcp plugin: personal semantic memory MCP server with four tools (`capture_thought`, `search_thoughts`, `browse_thoughts`, `brain_stats`)
- PostgreSQL + pgvector (1536-dim HNSW index) + ltree storage backend
- Three-axis scoring for search results: vector similarity × recency decay × importance weight
- Docker deployment: `templates/Dockerfile`, `templates/compose.yml` — containerized PG + MCP server
- OpenRouter embeddings (`openai/text-embedding-3-small`)
- `/mybrain-setup` skill: interactive setup wizard (Docker and RDS modes)
- `/mybrain-overview` skill: architecture and tool reference
- MIT license
