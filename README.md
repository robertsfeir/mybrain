# MyBrain

**A personal knowledge base with semantic search, delivered as a Claude Code plugin.**

Capture thoughts, ideas, notes, and decisions as you work. Ask Claude about them later in plain English -- MyBrain finds matches by meaning, not just keywords. Everything is stored in your own PostgreSQL database with pgvector embeddings.

Works with **Claude Code** (CLI, Desktop, and Web) over MCP.

---

## What You Get

Four MCP tools Claude can call on your behalf:

| Tool | What it does | Cost |
|---|---|---|
| `capture_thought` | Save a thought with optional metadata | ~$0.0001 (embedding) |
| `search_thoughts` | Semantic search with three-axis scoring | ~$0.0001 (embedding) |
| `browse_thoughts` | List recent thoughts, filter by metadata | Free (pure SQL) |
| `brain_stats` | Total count, date range, top metadata keys | Free (pure SQL) |

Two skills that ship with the plugin:

- **`/mybrain-setup`** -- interactive setup wizard (Bundled, Docker, or RDS)
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

Claude will ask which mode you want:

- **Bundled mode** -- PostgreSQL + Ollama + MCP server in a **single container**. No API key needed. One port. Recommended for personal use.
- **Docker mode** -- separate containers for PostgreSQL, optional Ollama, and the MCP server. Uses OpenRouter or Ollama for embeddings.
- **RDS mode** -- connect to a shared PostgreSQL on AWS RDS (or any remote Postgres with `pgvector` and `ltree` extensions). Best for multi-project / multi-user setups.

The wizard handles the rest: scaffolding files, wiring `.mcp.json`, starting containers, and verifying everything works.

### 3. Get an OpenRouter API key (Docker and RDS modes only)

Bundled mode uses local Ollama — no API key needed. For Docker or RDS mode with OpenRouter:

1. Sign up at <https://openrouter.ai>
2. Create a key at <https://openrouter.ai/keys>
3. Load a few dollars of credits. The embedding model (`text-embedding-3-small`) costs fractions of a cent per call -- $5 of credits goes a very long way.

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

Then register the MCP server with Claude Code:

```bash
claude mcp add mybrain --transport stdio \
  -e DATABASE_URL="postgresql://user:password@host:5432/mybrain?ssl=true&sslmode=no-verify" \
  -e OPENROUTER_API_KEY="sk-or-..." \
  -e BRAIN_SCOPE="personal" \
  -- node /absolute/path/to/mybrain/server.mjs
```

If you're setting up a fresh database, apply the schema:

```bash
psql "$DATABASE_URL" -f templates/schema.sql
```

---

## Deployment Modes

### Bundled mode (recommended for personal use)

```
Claude Code --HTTP--> localhost:8787
                           |
               ┌─────── container ──────┐
               │  MCP server (:8787)    │
               │  PostgreSQL (:5432)    │
               │  Ollama (:11434)       │
               └────────────────────────┘
```

- Everything runs in **one container** — PostgreSQL, Ollama, and the MCP server
- **No API key needed** — embeddings are generated locally by `mxbai-embed-large` via Ollama
- Only one port exposed to the host (`8787` by default)
- Ollama stays in memory permanently (`OLLAMA_KEEP_ALIVE=-1`) — no cold-start latency
- `restart: unless-stopped` — auto-starts with Docker Desktop, auto-restarts on crash
- First boot pulls the model (~700 MB, one-time); subsequent starts are under 10 seconds

### Docker mode

```
Claude Code --HTTP--> mybrain_mcp (:8787) --> mybrain_postgres
                                          --> OpenRouter or local Ollama (embeddings)
```

- PostgreSQL + pgvector in separate containers
- MCP server runs in its own container, exposed on `http://localhost:8787`
- Supports OpenRouter (default) or local Ollama via compose profile (`--profile ollama`)
- `BRAIN_SCOPE` is optional (single-user, single database)
- Run multiple named brains side-by-side on different ports

### RDS mode

```
Claude Code --stdio--> server.mjs --> AWS RDS (your database)
                                  --> OpenRouter (embeddings)
```

- Connects to an existing Postgres with `pgvector` and `ltree` extensions
- `BRAIN_SCOPE` is required -- isolates your thoughts from others on the same database
- Good for teams or users syncing a brain across multiple machines

---

## How Semantic Search Works

When you capture a thought, the text is sent to the embedding provider — local Ollama (`mxbai-embed-large`) in Bundled mode, or OpenRouter (`text-embedding-3-small`) in Docker/RDS mode — and returned as a 1024-dimensional vector. That vector is stored next to your text in PostgreSQL with an HNSW index.

When you search, your query is embedded the same way and scored with the **three-axis formula**:

```
score = (3.0 × cosine_similarity) + (2.0 × importance) + (0.5 × recency_decay)
```

Results come back sorted by combined score, so recent *and* important *and* relevant thoughts rise to the top.

### ltree scoping

Every thought carries an `ltree[]` scope (e.g. `personal`, `work.acme.app`). When `BRAIN_SCOPE` is set, every query is filtered to that scope -- multiple users or projects can share one database without leaking thoughts to each other.

### Async memory storage (optional)

Set `MYBRAIN_ASYNC_STORAGE=true` to make `capture_thought` return the moment the row hits the database (~3 ms on local PostgreSQL) instead of waiting for the embedding call (100–1000 ms, especially with local Ollama). A background worker inside the same Node process polls for rows with `embedding IS NULL` every 500 ms and fills them in.

The `thoughts` table itself is the queue — no extra services, no message bus. If the container crashes mid-embed, the un-embedded rows stay in the table and get picked up on next boot. Nothing is lost.

Trade-off: a just-captured thought isn't retrievable via `search_thoughts` until the embedding has been generated (typically within a second). For chatty sessions where Claude captures many thoughts in a row, this turns capture from a 100–1000 ms blocker into a ~3 ms non-event.

The `/mybrain-setup` wizard asks about this in each path (Bundled / Docker / RDS) — default is **on** for Bundled (local Ollama is the slow path) and **off** for Docker/RDS with OpenRouter (cloud embeddings are fast enough that the sync path is fine).

---

## Requirements

**Bundled mode:**
- Docker Desktop

**Docker mode:**
- Podman or Docker
- Node.js 18+ (only if you install manually)
- OpenRouter API key, or local Ollama (via compose profile)

**RDS mode:**
- Node.js 18+
- PostgreSQL with `pgvector` and `ltree` extensions
- OpenRouter API key (<https://openrouter.ai>)

---

## Usage Examples

Once installed, talk to Claude naturally:

- `Remember this: Sarah said she wants to start a consulting business next quarter.`
- `What do I know about Sarah?`
- `Show me my recent thoughts.`
- `Search my brain for anything about deployment pipelines.`
- `How many thoughts do I have?`
- `Capture thought: pg_dump with --data-only skips schema changes.`

Claude will pick the right tool (`capture_thought`, `search_thoughts`, `browse_thoughts`, `brain_stats`) automatically.

---

## Repository Layout

```
.claude-plugin/
  plugin.json                  Plugin manifest (declares skills)
  marketplace.json             Marketplace definition
.mcp.json                      MCP server config (stdio, plugin-root path)
skills/
  mybrain-setup/SKILL.md       Interactive setup wizard (Bundled / Docker / RDS)
  mybrain-overview/SKILL.md    Architecture + tool reference
templates/
  server.mjs                   MCP server (dual mode: stdio + HTTP)
  package.json                 Node dependencies
  schema.sql                   Full schema (ltree, match_thoughts_scored, HNSW)
  Dockerfile                   MCP container image (Docker mode)
  compose.yml                  Docker mode: PostgreSQL + Ollama profile + MCP
  .env.example                 Docker / RDS environment template
  Dockerfile.bundled           Bundled mode: single-container image (PG + Ollama + MCP)
  compose.bundled.yml          Bundled mode: one service, one port, two volumes
  start.sh                     Bundled mode: tini entrypoint (PG → Ollama → model pull → MCP)
  .env.bundled.example         Bundled mode environment template
shell/
  mybrain-preflight.sh         POSIX health check helper (canonical logic)
  mybrain.zsh                  zsh wrapper with preflight
  mybrain.bash                 bash wrapper with preflight
  mybrain.fish                 fish wrapper with preflight
  mybrain.csh                  csh alias delegating to preflight script
  mybrain.tcsh                 tcsh alias delegating to preflight script
server.mjs                     Top-level server (used by stdio registration)
```

---

## Troubleshooting

**Bundled mode first boot is slow.**
The image build installs Node.js and copies the Ollama binary (~500 MB). Then the first container start pulls `mxbai-embed-large` (~700 MB). Both are one-time costs. After the first boot, subsequent starts complete in under 10 seconds because the model is cached in the `mybrain_ollama_models` volume.

**Bundled container won't start / stays unhealthy.**
Tail the logs: `docker logs mybrain_<name> -f`. The start sequence is: PostgreSQL → Ollama → model pull → MCP server. If it stalls at the model pull, check your internet connection. If it stalls at Ollama, the Ollama binary may not be compatible with your CPU architecture — open an issue.

**"No thoughts found" on every search.**
The schema may not be loaded. In Docker mode, run `podman compose down -v && podman compose up -d` in your `.mybrain/<name>/` directory to rebuild the volume with the schema. In RDS mode, re-run `psql "$DATABASE_URL" -f templates/schema.sql`.

**`Embedding API error: 401`.**
Your `OPENROUTER_API_KEY` is missing or invalid. Check it's set in `.env` (Docker mode) or the `claude mcp add` command (RDS mode). Not applicable to Bundled mode (no API key needed).

**Claude doesn't see the tools.**
Restart Claude Code after installing. In Docker or Bundled mode, check the container is running and healthy: `docker compose ps` inside `.mybrain/<name>/`.

**`capture_thought` succeeds but `search_thoughts` returns nothing.**
Lower the similarity threshold: `Search my brain for X with threshold 0.2`. The default is conservative.

**Port conflicts in Docker mode.**
Each brain instance uses two ports (default: MCP 8787, Postgres 5433). Run `/mybrain-setup` again with a different brain name to pick new ports.

---

## License

MIT
