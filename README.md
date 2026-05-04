# MyBrain

**A personal knowledge base with semantic search, delivered as a Claude Code plugin.**

Capture thoughts, ideas, notes, and decisions as you work. Ask Claude about them later in plain English -- MyBrain finds matches by meaning, not just keywords. Everything is stored in your own PostgreSQL database with pgvector embeddings.

Works with **Claude Code** (CLI, Desktop, and Web) over MCP.

> 📖 **New here?** Start with the **[User Guide](guides/user-guide.md)** — a friendly tour of how MyBrain captures, scores, fades, and removes memories. Want the deep specs (schema, scoring math, conflict thresholds, the full tool surface)? See the **[Technical Reference](guides/technical-reference.md)**.

---

## Tool Rename (v2.0)

mybrain v2.0 implements the 8-tool atelier-brain protocol. The four legacy
tools (`capture_thought`, `search_thoughts`, `browse_thoughts`, `brain_stats`)
have been **replaced** by the protocol tool surface. v1 tool names no longer
exist on the server.

| Tool | What it does |
|---|---|
| `agent_capture` | Store a thought with schema-enforced metadata; dedup + conflict detection + supersedes |
| `agent_search` | Semantic search with three-axis scoring (recency + importance + relevance) |
| `atelier_browse` | Paginated thought listing with status / type / agent / scope filters |
| `atelier_stats` | Brain health check, counts by type / status / agent / human |
| `atelier_relation` | Link two thoughts via a typed relation (`supersedes`, `supports`, `contradicts`, …) |
| `atelier_trace` | Traverse the relation graph from a thought (backward / forward / both) |
| `atelier_hydrate` | Ingest JSONL telemetry from a Claude Code project sessions directory |
| `atelier_hydrate_status` | Poll completion state of a previous `atelier_hydrate` call |

### Migration steps

1. **Update tool names in your Claude Code / Cursor configs.** Any custom
   prompts or scripts that referenced `capture_thought` / `search_thoughts` /
   `browse_thoughts` / `brain_stats` need to be updated to the new tool names
   above. Old names will return "tool not found".

2. **Apply the v1-to-merged migration to existing databases.** v2 introduces
   new columns (`captured_by`, `origin_pipeline`, `origin_context`,
   `trigger_when`), new enum values (`handoff`, `pattern`, `seed`, plus
   atelier-pipeline source agents and phases), and the `thought_relations`
   table. The migration is purely additive and idempotent — re-running it on
   an already-migrated database is a no-op.

   ```bash
   psql $DATABASE_URL -f migrations/001-mybrain-v1-to-merged.sql
   ```

   Fresh installs do not need to run this manually — `lib/db.mjs`'s
   `runMigrations(pool)` applies it automatically at server startup.

---

## What You Get

Eight MCP tools Claude can call on your behalf (the 8-tool atelier-brain protocol — see [Tool Rename (v2.0)](#tool-rename-v20) above for the v1 → v2 mapping):

| Tool | What it does |
|---|---|
| `agent_capture` | Save a thought with schema-enforced metadata; runs dedup + conflict detection on `decision`/`preference` types |
| `agent_search` | Semantic search with three-axis scoring (relevance + importance + recency); refreshes recency on hits |
| `atelier_browse` | Paginated listing filtered by status, type, agent, scope, or human |
| `atelier_stats` | Brain health + counts by type / status / agent / human |
| `atelier_relation` | Link two thoughts via a typed relation (`supersedes`, `supports`, `contradicts`, `evolves_from`, `triggered_by`, `synthesized_from`) |
| `atelier_trace` | Walk the relation graph from a thought (backward / forward / both) |
| `atelier_hydrate` | Ingest JSONL telemetry from a Claude Code project sessions directory |
| `atelier_hydrate_status` | Poll the completion state of a previous `atelier_hydrate` call |

**Per-call cost:** SQL-only tools (`atelier_browse`, `atelier_stats`, `atelier_relation`, `atelier_trace`, `atelier_hydrate_status`) are free. `agent_capture` and `agent_search` each make one embedding call (free with local Ollama; ~$0.0001 with OpenRouter `text-embedding-3-small`). `agent_capture` may also make one chat call when a `decision`/`preference` lands in the conflict-candidate zone (0.7–0.9 similarity) and `conflict_llm_enabled` is true. `atelier_hydrate` cost scales with the number of telemetry files ingested.

Deeper docs:

- **[User Guide](guides/user-guide.md)** — friendly walkthrough of how MyBrain captures, scores, fades, and removes memories
- **[Technical Reference](guides/technical-reference.md)** — schema, scoring math, conflict thresholds, consolidation algorithm, REST API, full tool reference

Two skills that ship with the plugin:

- **`/mybrain-setup`** -- interactive setup wizard (Bundled, Docker, Native, or RDS)
- **`/mybrain-overview`** -- explains architecture, tools, and usage

---

## Install in Claude Code (Recommended)

This is the fastest path. The plugin marketplace installs the MCP server, skills, and templates for you.

### 1. Add the marketplace and install the plugin

```bash
claude plugin marketplace add robertsfeir/mybrain
claude plugin install mybrain@mybrain
```

### 2. Run the setup wizard

Inside any Claude Code session, run:

```
/mybrain-setup
```

The wizard installs MyBrain **per-project** (local MCP scope) -- the brain is registered for this user, in this project, and nowhere else. `--scope user` and `--scope project` registrations are deprecated and explicitly removed by the new flow's pre-flight step (see [Per-project install (v2.2.0+)](#per-project-install-v220) below).

Claude will then ask **where this repo's brain database should live**. Four backends are available:

- **Bundled** -- *(recommended)* PostgreSQL, Ollama, and the MCP server all run inside a single container. No API key. One port. One volume.
- **Docker** -- multi-container: PostgreSQL + (optional Ollama via compose profile) + MCP server. Choose OpenRouter (cloud) or Ollama (local) for embeddings.
- **Native** -- no Docker. Ollama on the host, any reachable PostgreSQL, MCP server as a local process.
- **RDS** -- connect to a shared PostgreSQL on AWS RDS or any reachable remote Postgres. OpenRouter for embeddings. `BRAIN_SCOPE` (ltree) keeps each repo's thoughts isolated when several repos share the same DB.

The wizard handles the rest: scaffolding files, registering the MCP server with `claude mcp add` (local scope), starting containers (Bundled/Docker), and verifying everything works.

#### Per-project install (v2.2.0+)

As of v2.2.0, every install registers the MCP server with **local scope only**. This is the default for `claude mcp add` -- the wizard never passes `--scope user` or `--scope project`.

- `--scope user` previously made one `mybrain` registration visible across every project on the machine, which caused the brain to fail to start when two repos raced for the same container/port and caused thoughts to be attributed to the wrong project.
- `--scope project` wrote the registration to `.mcp.json` and shipped it to teammates / other clones via git.

`/mybrain-setup` now begins with a **Step 0 pre-flight** that runs `claude mcp list` and offers to remove any deprecated `mybrain` registration before continuing. If you decline, the install stops -- it won't create a colliding local-scope entry alongside an existing user/project-scope one. Removing a deprecated registration affects every other project on the machine that was relying on it; each will need to re-run `/mybrain-setup` once. **Brain data (databases, containers, volumes) is untouched** -- only the Claude Code registration is removed. Multiple repos can still share one *database* by selecting **RDS** (or pointing several Native installs at the same Postgres) -- `BRAIN_SCOPE` keeps thoughts isolated.

### 3. (Optional) Get an OpenRouter API key

**You only need a key in Docker/RDS modes that use OpenRouter.** Bundled and Native modes use local Ollama and don't need one.

1. Sign up at <https://openrouter.ai>
2. Create a key at <https://openrouter.ai/keys>
3. Load a few dollars of credits. The default model (`openai/text-embedding-3-small`, 1536-dim) costs fractions of a cent per call -- $5 of credits goes a long way.

### 4. Restart Claude Code and try it

```
Remember this: I just set up MyBrain.
How many thoughts do I have?
```

If Claude responds with a thought count, you're done.

---

## Install Manually (Clone and Register)

Use this path if you don't want to go through the marketplace, or you need to customize the server.

```bash
git clone https://github.com/robertsfeir/mybrain.git
cd mybrain
npm install
```

Apply the schema (`{{EMBED_DIM}}` is substituted at scaffold time, default `1536`):

```bash
sed 's/{{EMBED_DIM}}/1536/g' templates/schema.sql | psql "$DATABASE_URL" -f -
```

Then register the MCP server with Claude Code (Native or RDS-style stdio registration). **Use the default local scope** -- do not pass `--scope user` or `--scope project`:

```bash
claude mcp add mybrain --transport stdio \
  -e DATABASE_URL="postgresql://user:password@host:5432/mybrain?ssl=true&sslmode=no-verify" \
  -e EMBEDDING_PROVIDER="ollama" \
  -e OLLAMA_HOST="http://localhost:11434" \
  -e OLLAMA_MODEL="gte-qwen2-1.5b-instruct" \
  -e BRAIN_SCOPE="personal" \
  -- node /absolute/path/to/mybrain/server.mjs
```

Swap `EMBEDDING_PROVIDER=openrouter` and `OPENROUTER_API_KEY=sk-or-...` if you'd rather use the cloud embedding model.

---

## Deployment Modes

### Bundled mode (recommended)

```
Claude Code --HTTP--> mybrain container (:8787)
                       ├─ PostgreSQL + pgvector
                       ├─ Ollama (gte-qwen2-1.5b-instruct, 1536-dim)
                       └─ MCP server
```

- Everything runs in one container -- no API key, no external services
- Exposes only the MCP HTTP port; data + models persisted in named Docker volumes
- First boot pulls the embedding model (~1.7 GB); subsequent starts are <10s
- Best for personal use on a single machine

### Docker mode

```
Claude Code --HTTP--> mcp container (:8787) ──> postgres container
                                            └─> OpenRouter  OR  ollama container (compose profile)
```

- PostgreSQL + MCP server in separate containers
- Embeddings via **OpenRouter** (default) or **local Ollama** via the `ollama` compose profile
- Each brain instance uses two ports (default: MCP 8787, Postgres 5433); you can run multiple named brains on different ports

### Native mode

```
Claude Code --stdio (or HTTP)--> server.mjs ──> your local/remote Postgres
                                            └─> host-installed Ollama (:11434)
```

- No Docker. Ollama runs directly on the host (`brew install ollama` or the official installer)
- Postgres is whatever PG you already have, with `pgvector` and `ltree` extensions enabled
- MCP server runs as a local Node process registered via `claude mcp add` (stdio default, HTTP optional)
- Good if you already run Ollama and Postgres for other reasons

### RDS mode

```
Claude Code --stdio--> server.mjs --> AWS RDS (your database)
                                  --> OpenRouter (embeddings)
```

- Connects to an existing remote Postgres with `pgvector` and `ltree` extensions
- `BRAIN_SCOPE` is required -- isolates your thoughts from others sharing the database
- Good for teams or syncing a brain across multiple machines

---

## How Semantic Search Works

When you capture a thought, the text is sent to your configured embedding provider -- **local Ollama** (default `gte-qwen2-1.5b-instruct`) or **OpenRouter** (`openai/text-embedding-3-small`) -- and returned as a 1536-dimensional vector. That vector is stored next to your text in PostgreSQL with an HNSW index.

When you search, your query is embedded the same way and scored with the **three-axis formula**:

```
score = (3.0 × cosine_similarity) + (2.0 × importance) + (0.5 × recency_decay)
```

Results come back sorted by combined score, so recent *and* important *and* relevant thoughts rise to the top.

The schema's vector column dimension is template-substituted at scaffold time (default `1536`). A 1024-dim opt-in is supported for local models like `mxbai-embed-large` -- substitute `{{EMBED_DIM}}=1024` in `schema.sql` and set `OLLAMA_MODEL=mxbai-embed-large` together. On startup the MCP server reads and logs the actual column dimension (e.g. `embedding dim: 1536 (detected)`), so dimension drift surfaces immediately.

### ltree scoping

Every thought carries an `ltree[]` scope (e.g. `personal`, `work.acme.app`). When `BRAIN_SCOPE` is set, every query is filtered to that scope -- multiple users or projects can share one database without leaking thoughts to each other.

---

## Async Memory Storage

Set `MYBRAIN_ASYNC_STORAGE=true` to make `agent_capture` return in ~3ms. The thought is inserted with `embedding=NULL`; a background worker in the same Node process polls NULL-embedding rows every 500ms and backfills them. The `thoughts` table itself is the queue, so nothing is lost on crash.

Trade-off: a thought is not retrievable via `agent_search` until the embedding lands (typically <1s). To eliminate the capture-then-search race, `agent_search` runs `flushEmbedQueue` in parallel with its own query embedding so a thought captured ~500ms before the search becomes findable on the same call. Recommended whenever the embedding call is the slow path -- i.e. local Ollama (Bundled / Native / Docker+Ollama).

In stdio mode (Native / RDS) the worker only runs while Claude Code is open; thoughts captured right before you close Claude embed on next launch.

---

## Shell Wrappers (auto-start the brain when you launch Claude)

The `shell/` directory ships preflight wrappers for `zsh`, `bash`, `fish`, `csh`, and `tcsh`. Once sourced, running `claude` health-checks the bundled container at `http://localhost:<port>/health`, starts/restarts it via `docker compose up -d` if it's not healthy, polls until ready (default 120s timeout), and then launches Claude Code. If the container is already healthy, overhead is sub-100ms.

The setup wizard offers to install these for you. Manual one-liner for zsh once `~/.claude/mybrain/shell/mybrain.zsh` exists:

```sh
# add to ~/.zshrc
[ -f ~/.claude/mybrain/shell/mybrain.zsh ] && source ~/.claude/mybrain/shell/mybrain.zsh
```

Tunables (set before the `source` line):

```sh
export MYBRAIN_HEALTH_TIMEOUT=60   # seconds to wait (default: 120)
export MYBRAIN_QUIET=1             # suppress mybrain output (default: 0)
```

The wrapper never blocks Claude Code -- if Docker isn't running, it logs a warning and starts Claude anyway.

---

## Requirements

**Bundled mode:**
- Docker Desktop

**Docker mode:**
- Docker
- OpenRouter API key (only if using the cloud provider)
- Node.js 18+ (only if you install manually)

**Native mode:**
- Node.js 18+
- PostgreSQL with `pgvector` and `ltree` extensions
- Ollama installed and running on the host

**RDS mode:**
- Node.js 18+
- PostgreSQL with `pgvector` and `ltree` extensions (remote)
- OpenRouter API key

---

## Usage Examples

Once installed, talk to Claude naturally:

- `Remember this: Sarah said she wants to start a consulting business next quarter.`
- `What do I know about Sarah?`
- `Show me my recent thoughts.`
- `Search my brain for anything about deployment pipelines.`
- `How many thoughts do I have?`
- `Capture thought: pg_dump with --data-only skips schema changes.`
- `Trace what led to my decision about authentication.`
- `Show me my preferences.`

Claude will pick the right tool (`agent_capture`, `agent_search`, `atelier_browse`, `atelier_stats`, `atelier_relation`, `atelier_trace`) automatically.

---

## Repository Layout

```
.claude-plugin/
  plugin.json              Plugin manifest (declares skills)
  marketplace.json         Marketplace definition
.mcp.json                  MCP server config (stdio, plugin-root path)
skills/
  mybrain-setup/SKILL.md   Interactive setup wizard (4 modes)
  mybrain-overview/SKILL.md Architecture + tool reference
shell/
  mybrain-preflight.sh     Health-check + container start
  mybrain.zsh              zsh wrapper
  mybrain.bash             bash wrapper
  mybrain.fish             fish wrapper
  mybrain.csh              csh wrapper
  mybrain.tcsh             tcsh wrapper
templates/
  server.mjs               MCP server (stdio + HTTP, /health endpoint)
  package.json             Node dependencies
  schema.sql               Full schema (ltree, match_thoughts_scored, HNSW, {{EMBED_DIM}} placeholder)
  Dockerfile               MCP container image (Docker mode)
  Dockerfile.bundled       Single-container image (PG + Ollama + MCP)
  start.sh                 Bundled-mode entrypoint (init PG, start Ollama, pull model, run MCP)
  compose.yml              Multi-container compose (Docker mode)
  compose.bundled.yml      Single-container compose (Bundled mode)
  .env.example             Environment template (Docker / Native / RDS)
  .env.bundled.example     Environment template (Bundled)
server.mjs                 Top-level server (used by stdio registration)
```

---

## Troubleshooting

**Bundled mode -- first boot is slow / container shows `unhealthy`.**
First boot pulls the embedding model (~1.7 GB) into the volume. On a slow connection this can exceed the healthcheck `start_period` (300s). Wait it out -- Docker's restart policy keeps the container coming back, and once the model is cached subsequent starts are <10s. Watch progress: `docker compose logs -f mybrain`.

**Bundled mode -- `/health` returns nothing.**
Check the container is up: `docker compose ps` inside `.mybrain/<name>/`. If the container is restarting in a loop, inspect logs for the failing service (Postgres init, Ollama pull, or the MCP server itself).

**"No thoughts found" on every search.**
The schema may not be loaded. In Bundled/Docker modes, run `docker compose down -v && docker compose up -d` in your `.mybrain/<name>/` directory to rebuild the volume with the schema. In Native/RDS modes, re-apply: `sed 's/{{EMBED_DIM}}/1536/g' templates/schema.sql | psql "$DATABASE_URL" -f -`.

**`Embedding API error: 401`.**
Your `OPENROUTER_API_KEY` is missing or invalid (Docker/RDS with OpenRouter only). Check it's set in `.env` or the `claude mcp add` command.

**Claude doesn't see the tools.**
Restart Claude Code after installing. In Bundled/Docker modes, check the container is running and healthy: `docker compose ps`.

**`agent_capture` succeeds but `agent_search` returns nothing.**
If async storage is enabled, the embedding may not have been written yet -- `agent_search` flushes the queue in parallel with its own query embedding, so a one-shot retry usually picks it up. Otherwise lower the similarity threshold: `Search my brain for X with threshold 0.1`. The default (0.2) is conservative.

**Embedding dim mismatch on insert.**
The MCP server logs `embedding dim: N (detected)` on startup. If your model produces a different dim than the column expects, pgvector raises a clear error. Either pull a model that matches the column dim, or rebuild the schema with the matching `{{EMBED_DIM}}`.

**Port conflicts in Bundled/Docker mode.**
Each brain instance uses one port (Bundled: MCP 8787) or two ports (Docker: MCP 8787, Postgres 5433). Run `/mybrain-setup` again with a different brain name to pick new ports.

---

## License

Apache License 2.0 — see [LICENSE](LICENSE) for the full text.
