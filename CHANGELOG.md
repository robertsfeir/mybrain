# Changelog

All notable changes to mybrain-mcp are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
