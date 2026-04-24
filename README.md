# MyBrain

**A personal knowledge base with semantic search, delivered as a Claude Code plugin.**

Capture thoughts, ideas, notes, and decisions as you work. Ask Claude about them later in plain English -- MyBrain finds matches by meaning, not just keywords. Everything is stored in your own PostgreSQL database with pgvector embeddings.

Works with **Claude Code** (CLI, Desktop, and Web) over MCP.

---

## What You Get

Four MCP tools Claude can call on your behalf:

| Tool | What it does | Cost |
|---|---|---|
| `capture_thought` | Save a thought with optional metadata | ~$0.0001 (embedding) or free (Bundled) |
| `search_thoughts` | Semantic search with three-axis scoring | ~$0.0001 (embedding) or free (Bundled) |
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

The wizard handles the rest: scaffolding files, starting containers, and verifying everything works.

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
Claude Code ──HTTP──▶ localhost:8787
                           │
               ┌─────── container ──────────┐
               │  MCP server  (0.0.0.0:8787)│
               │       │            │       │
               │       ▼            ▼       │
               │  127.0.0.1:5432  127.0.0.1:11434
               │   (PostgreSQL)   (Ollama + model)
               └────────────────────────────┘
```

- Everything runs in **one container** — PostgreSQL, Ollama, and the MCP server
- **No API key needed** — embeddings generated locally by `mxbai-embed-large` via Ollama
- **Only port 8787 is exposed** to the host — Ollama and PostgreSQL are container-internal
- Ollama stays in memory permanently (`OLLAMA_KEEP_ALIVE=-1`) — zero cold-start latency
- `restart: unless-stopped` — auto-starts with Docker Desktop, auto-restarts on crash
- First boot pulls the model (~700 MB, one-time); subsequent starts are under 10 seconds

### Docker mode

```
Claude Code ──HTTP──▶ mybrain_mcp (:8787) ──▶ mybrain_postgres
                                          ──▶ OpenRouter or local Ollama (embeddings)
```

- PostgreSQL + pgvector in a separate container
- MCP server runs in its own container, exposed on `http://localhost:8787`
- Supports OpenRouter (default) or local Ollama via compose profile (`--profile ollama`)
- `BRAIN_SCOPE` is optional (single-user, single database)
- Run multiple named brains side-by-side on different ports

### RDS mode

```
Claude Code ──stdio──▶ server.mjs ──▶ AWS RDS (your database)
                                  ──▶ OpenRouter (embeddings)
```

- Connects to an existing Postgres with `pgvector` and `ltree` extensions
- `BRAIN_SCOPE` is required -- isolates your thoughts from others on the same database
- Good for teams or users syncing a brain across multiple machines

---

## Migrating from Docker mode to Bundled mode

If you started with Docker mode (separate containers + OpenRouter) and want to switch to Bundled (single container + local Ollama):

**What changes:**
- Two containers (`postgres` + `mcp`) → one container (`mybrain_default`)
- OpenRouter API calls for embeddings → local `mxbai-embed-large` via Ollama (no cost, no network)
- MCP transport stays HTTP; port stays 8787

**Steps:**

1. Export your thoughts (skip if starting fresh):
   ```bash
   docker exec mybrain_postgres psql -U mybrain -d mybrain \
     -c "COPY (SELECT content, metadata, thought_type, source_agent, source_phase,
                      importance, scope, status, created_at
               FROM thoughts)
         TO STDOUT WITH (FORMAT csv, HEADER)" > thoughts_backup.csv
   ```

2. Stop Docker mode:
   ```bash
   cd .mybrain/<name> && docker compose down
   ```

3. Run `/mybrain-setup` and choose **Bundled**. The wizard scaffolds a new `.mybrain/<name>/` directory.

4. Start bundled and wait for healthy:
   ```bash
   docker compose up -d --build
   # First boot: ~2-5 min (model pull). Watch: docker logs mybrain_<name> -f
   ```

5. Re-import thoughts (optional):
   ```bash
   docker exec -i mybrain_default psql -U mybrain -d mybrain <<'SQL'
   \copy thoughts (content, metadata, thought_type, source_agent, source_phase,
                   importance, scope, status, created_at)
   FROM 'thoughts_backup.csv' WITH (FORMAT csv, HEADER);
   SQL
   ```
   With `MYBRAIN_ASYNC_STORAGE=true`, the embed worker will backfill all embeddings in the background automatically.

6. Update MCP registration:
   ```bash
   claude mcp remove mybrain
   claude mcp add mybrain --scope user --transport http --url http://localhost:8787
   ```

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

### Async memory storage

By default, `capture_thought` generates the embedding and inserts the row in one synchronous step. When `MYBRAIN_ASYNC_STORAGE=true`, the flow changes:

```
SYNC (default)
──────────────────────────────────────────────────────────────
Claude calls capture_thought
  │
  ├─▶ getEmbedding(content)  ◀── 100–1000 ms (Ollama forward pass)
  │
  ├─▶ INSERT INTO thoughts (content, embedding, ...)  ◀── 2–5 ms
  │
  └─▶ return "Thought captured"
                                   ▲
                        Claude waits all of this

ASYNC (MYBRAIN_ASYNC_STORAGE=true)
──────────────────────────────────────────────────────────────
Claude calls capture_thought
  │
  ├─▶ INSERT INTO thoughts (content, embedding=NULL, ...)  ◀── 2–5 ms
  │
  └─▶ return "Thought queued"
             ▲
  Claude waits only this (~3 ms)

  Meanwhile, off Claude's path:
  ┌─── embed worker (setInterval 500ms) ────────────────────┐
  │  SELECT id, content FROM thoughts WHERE embedding IS NULL│
  │  for each row:                                           │
  │    vec ← getEmbedding(content)   ◀── 100–1000 ms        │
  │    UPDATE thoughts SET embedding = vec WHERE id = …      │
  └──────────────────────────────────────────────────────────┘
```

The `thoughts` table is the queue — no extra services, no message bus. If the container crashes mid-embed, unembedded rows stay in the table and get picked up on next boot. Nothing is lost.

**Trade-off:** a just-captured thought isn't retrievable via `search_thoughts` until the background worker embeds it (typically within a second). In practice, capture is followed by more conversation, not an immediate self-search — so the lag is imperceptible.

The `/mybrain-setup` wizard asks about this in every path. Default is **on** for Bundled (local Ollama is slower), **off** for Docker/RDS with OpenRouter (cloud embeddings are fast enough).

---

## Always-On Container

Bundled mode is designed to stay running continuously — you never manually start or stop it.

**How it stays alive:**

- `restart: unless-stopped` in `compose.yml` — Docker Desktop starts the container automatically on login and restarts it if it crashes
- `tini` as PID 1 — correct signal forwarding and zombie process reaping
- `start.sh` runs PG, Ollama, and the MCP server as background jobs, then calls `wait -n`. If any one of the three exits, `wait -n` returns, the script kills the others and exits — Docker immediately restarts the whole container
- `OLLAMA_KEEP_ALIVE=-1` — Ollama never unloads the model from memory, so the first embed after a cold start is just as fast as the hundredth

**What this means in practice:**

```
Boot your Mac
    │
    ▼
Docker Desktop starts automatically
    │
    ▼
mybrain_default starts automatically (restart: unless-stopped)
    │
    ▼
PG → Ollama → model warm → MCP HTTP server
    │
    ▼
Container healthy on :8787 — ready before you open a terminal
```

Subsequent starts (after first boot) take under 10 seconds because the model is already cached in the `mybrain_ollama_models` Docker volume.

---

## Shell Wrapper — `claude` Preflight

The `shell/` directory contains wrappers for zsh, bash, fish, csh, and tcsh. Once sourced, they **intercept the `claude` command** and run a health check before launching Claude Code.

### How it works

```
You type: claude

    ▼
shell function claude() runs
    │
    ├─ curl http://localhost:8787/health (2s timeout)
    │
    ├─ HEALTHY ──────────────────────────────────▶ command claude "$@"
    │                                               (brain available)
    │
    ├─ DOCKER NOT RUNNING ───────────────────────▶ command claude "$@"
    │   (logs warning)                              (brain unavailable,
    │                                                Claude still starts)
    │
    └─ NOT HEALTHY
           │
           ├─ docker compose -f ~/.claude/mybrain/compose.yml up -d
           │
           ├─ poll /health every 2s ──── healthy ──▶ command claude "$@"
           │
           ├─ Ctrl+C ────────────────────────────▶ command claude "$@"
           │   (logs "interrupted")                 (brain may be unavailable)
           │
           └─ timeout (120s) ────────────────────▶ command claude "$@"
               (logs "timed out")                   (brain may be unavailable)
```

The key detail: `command claude "$@"` at the end bypasses the wrapper function and calls the real `claude` binary with your original arguments unchanged. You never need to think about it — you still just type `claude`.

### The `claude` override

When you source the file in your shell rc, a shell function named `claude` shadows the binary. This is standard shell practice (e.g. how `git` aliases work). It is not a new command — it is a transparent wrapper around the existing one:

```zsh
claude          # → runs preflight → calls real claude binary
claude chat     # → runs preflight → calls real claude binary with "chat"
claude --help   # → runs preflight → calls real claude binary with "--help"
```

To bypass the wrapper for any reason: `command claude` (calls the binary directly, no preflight).

### Install

```bash
# Copy wrappers to ~/.claude/mybrain/shell/
cp shell/mybrain.zsh shell/mybrain-preflight.sh ~/.claude/mybrain/shell/
cp .mybrain/default/compose.yml ~/.claude/mybrain/compose.yml
```

Add one line to your `~/.zshrc` (or equivalent):

```zsh
[ -f ~/.claude/mybrain/shell/mybrain.zsh ] && source ~/.claude/mybrain/shell/mybrain.zsh
```

### Tunables (set before the `source` line)

```zsh
MYBRAIN_HEALTH_TIMEOUT=60   # seconds to wait for container (default: 120)
MYBRAIN_QUIET=1             # suppress all mybrain output (default: 0)
NO_COLOR=1                  # disable ANSI colors + spinner animation
```

### What the wait looks like

When the wrapper is waiting for the container, you get a live spinner line (animated at ~10 fps) with the elapsed time and a hint for the escape hatch:

```
✻ Waiting for mybrain… (14s / 120s · Ctrl+C to skip)
```

The spinner glyph cycles in cyan; the parenthetical metadata is dimmed; `Ctrl+C` is bold yellow so it reads as a live keybinding rather than prose. Terminal status lines use a colored dot prefix:

```
● mybrain: ready after 14s — starting Claude Code                 (green)
● mybrain: interrupted — starting Claude Code anyway …            (yellow)
● mybrain: timed out after 120s — starting Claude Code anyway …   (yellow)
● mybrain: docker daemon not reachable — starting Claude Code …   (yellow)
```

When stderr isn't a TTY (piped to a file, CI, etc.) or `NO_COLOR` is set, the wrapper falls back to plain text with no animation.

### Ctrl+C behavior

Pressing Ctrl+C during the health-wait loop interrupts the wait and **starts Claude Code immediately** — same behavior as the timeout path. The brain may be unavailable for that session, but Claude always starts. You are never stuck.

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
  mybrain-preflight.sh         POSIX health check + wait logic (used by csh/tcsh)
  mybrain.zsh                  zsh claude() wrapper with preflight
  mybrain.bash                 bash claude() wrapper with preflight
  mybrain.fish                 fish claude wrapper with preflight
  mybrain.csh                  csh alias delegating to preflight script
  mybrain.tcsh                 tcsh alias delegating to preflight script
server.mjs                     Top-level server (used by stdio and bundled mode)
```

---

## Troubleshooting

**Bundled mode first boot is slow.**
The image build installs Node.js and copies the Ollama binary (~500 MB). Then the first container start pulls `mxbai-embed-large` (~700 MB). Both are one-time costs. After the first boot, subsequent starts complete in under 10 seconds because the model is cached in the `mybrain_ollama_models` volume.

**Bundled container won't start / stays unhealthy.**
Tail the logs: `docker logs mybrain_<name> -f`. The start sequence is: PostgreSQL → Ollama → model pull → MCP server. If it stalls at the model pull, check your internet connection. If it stalls at Ollama, the Ollama binary may not be compatible with your CPU architecture — open an issue.

**"No thoughts found" on every search.**
The schema may not be loaded. In Docker mode, run `docker compose down -v && docker compose up -d` in your `.mybrain/<name>/` directory to rebuild the volume with the schema. In RDS mode, re-run `psql "$DATABASE_URL" -f templates/schema.sql`.

**Thoughts captured but not searchable.**
If `MYBRAIN_ASYNC_STORAGE=true`, embeddings are generated in the background. Check: `docker exec mybrain_default psql -U mybrain -d mybrain -c "SELECT count(*) FROM thoughts WHERE embedding IS NULL;"` — should return 0 within a few seconds. If it stays non-zero, check the container logs for embed worker errors.

**`Embedding API error: 401`.**
Your `OPENROUTER_API_KEY` is missing or invalid. Check it's set in `.env` (Docker mode) or the `claude mcp add` command (RDS mode). Not applicable to Bundled mode (no API key needed).

**Claude doesn't see the tools.**
Restart Claude Code after installing. In Docker or Bundled mode, check the container is running and healthy: `docker compose ps` inside `.mybrain/<name>/`.

**`capture_thought` succeeds but `search_thoughts` returns nothing.**
Lower the similarity threshold: `Search my brain for X with threshold 0.2`. The default is conservative.

**Port conflicts in Docker mode.**
Each brain instance uses two ports (default: MCP 8787, Postgres 5433). Run `/mybrain-setup` again with a different brain name to pick new ports.

**Shell wrapper hangs when starting `claude`.**
The container is unhealthy and Docker is trying to start it. Press **Ctrl+C** to interrupt the wait — Claude Code will start immediately without the brain. The container will keep trying to come up in the background.

---

## License

MIT
