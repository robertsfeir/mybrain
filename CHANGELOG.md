# Changelog

All notable changes to mybrain-mcp are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

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
