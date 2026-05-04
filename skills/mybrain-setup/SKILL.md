---
name: mybrain-setup
description: Use when users want to install or set up MyBrain -- a personal knowledge base with semantic search. Install is always per-project (local MCP scope); the only user-facing choice is which database backend to connect to (Bundled, Docker, Native, or RDS). Detects and offers to remove deprecated user/project/plugin-scoped registrations before installing.
---

# MyBrain -- Setup

This skill installs MyBrain.

**Install scope is always per-project (local).** The MCP server is registered with `claude mcp add` using the default local scope — it lives in this user's Claude config for this project only. It is **never** registered with `--scope user` (that registration leaks to every project on the machine and causes port races and mis-attributed thoughts), **never** with `--scope project` (that ships the registration to teammates via `.mcp.json`), and **never** auto-registered by the plugin loader (v2.2.0 and earlier shipped a `.mcp.json` at the plugin root that Claude Code's plugin system would auto-register as `plugin:mybrain:mybrain` with a hard-coded `BRAIN_SCOPE: "personal"` — that file was removed in v2.2.1, but stale plugin caches may still carry it). Step 0 below detects any pre-existing non-local registration and offers to remove it.

The only user-facing choice during setup is **where the brain's database lives**. Four backends are supported:

- **Bundled** -- PostgreSQL, Ollama, and the MCP server all run inside a **single container**. No API key needed. One port. One volume. Recommended for personal use.
- **Docker** -- Multi-container: PostgreSQL + optional Ollama (compose profile) + MCP server. Uses OpenRouter or Ollama for embeddings.
- **Native** -- No Docker. Ollama runs directly on the host, Postgres is whatever the user already has installed (or any reachable PG), and the MCP server runs as a local process registered via `claude mcp add`.
- **RDS** -- Connect to a shared PostgreSQL database on AWS RDS or any reachable remote Postgres. Multiple repos can share one database — ltree scoping (`BRAIN_SCOPE`) isolates each repo's thoughts.

### Embedding dim and the schema

The schema ships with a `{{EMBED_DIM}}` placeholder that is substituted at scaffold time (default: `1536`). The default Ollama model (`gte-qwen2-1.5b-instruct`) and the default OpenRouter model (`openai/text-embedding-3-small`) both produce 1536-dim vectors, so the default schema works against every default backend out of the box. Users who want a 1024-dim local model (e.g. `mxbai-embed-large`) substitute `{{EMBED_DIM}}=1024` at scaffold time and override `OLLAMA_MODEL=mxbai-embed-large` in their `.env`.

Existing installs are never auto-migrated. On startup the MCP server reads the actual `embedding` column dimension from `information_schema` and logs it (e.g. `embedding dim: 1536 (detected)`). The log line is informational — pgvector itself raises a clear error on dimension mismatch at insert time.

## Step 0: Pre-flight — Remove Deprecated Registrations

**Run this before every install, even on a fresh machine.** MyBrain previously had three non-local registration paths, all of which are now deprecated:

- `--scope user` makes one `mybrain` entry visible in *every* project on this machine. When two repos try to use it, one wins and the other silently mis-attributes thoughts (or fails to start, when their containers race for the same port).
- `--scope project` writes the registration to `.mcp.json` and ships it to teammates / other clones via git, leaking machine-local URLs and ports.
- **Plugin auto-registration (v2.2.0 and earlier)** — the plugin shipped a `.mcp.json` at its root, which Claude Code's plugin system auto-registered as **`plugin:mybrain:mybrain`** with a hard-coded `BRAIN_SCOPE: "personal"`. This was the primary cause of "thoughts attributed to the wrong project," because every project on the machine that had the plugin enabled inherited the same registration with the same scope. v2.2.1 removed the file from the plugin source. **Existing v2.2.0 installs may still have a cached copy** until the plugin is re-installed or upgraded.

The new flow registers `mybrain` with **local** scope only — visible to this user, in this project, nowhere else. No plugin auto-registration.

### 0.1 — Detect

Run:

```bash
claude mcp list
```

Inspect the output for any of the following:

- An entry whose name is `mybrain` (or starts with `mybrain-`) **and** whose scope is shown as `user` or `project`.
- An entry named `plugin:mybrain:mybrain` (or any `plugin:mybrain:*` variant). The `plugin:` prefix is the scope indicator — this entry was auto-registered by Claude Code's plugin loader from the `.mcp.json` shipped in v2.2.0 or earlier.

If none of those are present, skip to Step 1.

### 0.2 — Explain and Ask

If a non-local registration exists, tell the user verbatim what you found and why it matters. Use whichever block matches:

**For `--scope user` or `--scope project`:**

> "I found a `mybrain` server registered with **{user|project}** scope. That scope is deprecated — it caused brains to fail to start when multiple repos shared the same registration, and thoughts to be attributed to the wrong project. The new install is always per-project (local scope), so this old registration needs to come out before we continue."

Ask: **"Remove the {user|project}-scoped `mybrain` registration now? (yes / no)"**

**For `plugin:mybrain:mybrain`:**

> "I found a `plugin:mybrain:mybrain` entry. This was auto-registered by Claude Code's plugin loader from a `.mcp.json` shipped in mybrain v2.2.0 or earlier — it carries a hard-coded `BRAIN_SCOPE: \"personal\"` and applies to every project on the machine. v2.2.1 removed that file, but your plugin cache still has it. Until it's cleared, every project sees the same brain with the same scope, which is the bug we're fixing. The cleanest fix is to upgrade or re-install the plugin so the cache picks up the v2.2.1 source (no `.mcp.json`). Then we can register a clean per-project install."

Ask: **"Upgrade the mybrain plugin to v2.2.1+ and clear the auto-registration now? (yes / no)"**

### 0.3 — Remove

**For `--scope user` or `--scope project`:**

```bash
# For user scope
claude mcp remove mybrain --scope user

# For project scope (also delete the entry from .mcp.json if one exists)
claude mcp remove mybrain --scope project
```

If a `mybrain-<name>` variant is registered, repeat with that exact name.

**For `plugin:mybrain:mybrain`:**

The `plugin:` registrations cannot be removed with `claude mcp remove` — they are managed by the plugin loader. Two ways to clear it:

1. **Upgrade or re-install the plugin (recommended).** When the plugin cache picks up v2.2.1+, there is no `.mcp.json` to register, and the `plugin:mybrain:mybrain` entry disappears on the next Claude Code restart.

   ```bash
   claude plugin update mybrain@mybrain
   # or, if update isn't available:
   claude plugin uninstall mybrain
   claude plugin install mybrain@mybrain
   ```

2. **Manual fallback (not recommended unless 1 fails).** Locate the cached plugin directory (typically `~/.claude/plugins/cache/mybrain.<hash>/` or similar — check `claude plugin path mybrain` if available) and delete the `.mcp.json` at its root. Restart Claude Code. This is fragile because the next plugin update can re-create it (it won't, on v2.2.1+, but other tooling might).

After removal, **warn the user**:

> "Any **other** project on this machine that was relying on the `{user|project|plugin:mybrain:mybrain}` registration will no longer see a brain when you open it. Each of those projects will need to re-run `/mybrain-setup` once to register its own per-project install. Existing brain data (databases, containers, volumes) is untouched — only the Claude Code registration was removed."

If **no**: stop the install. Tell the user:

> "I can't safely register a per-project `mybrain` while a {user|project|plugin:mybrain:mybrain} registration still exists — they will collide. Re-run `/mybrain-setup` when you're ready to clear it."

### 0.4 — Continue

Once cleanup is complete (or there was nothing to clean), proceed to Step 1. After cleanup, re-run `claude mcp list` and confirm no `mybrain*` entries remain before continuing.

---

## Step 1: Choose Database Backend

Ask the user: **"Where should this repo's brain database live?"**

> 1. **Bundled** — fresh PostgreSQL + Ollama in a single container, dedicated to this repo (recommended)
> 2. **Docker** — multi-container PostgreSQL + optional Ollama, OpenRouter or local embeddings
> 3. **Native** — no Docker; uses PostgreSQL and Ollama already installed on this host
> 4. **RDS** — remote PostgreSQL (AWS RDS or any reachable Postgres); ltree-scoped so multiple repos can share one DB without leaking thoughts

Whichever the user picks, the MCP registration in the final step will be **local-scoped** (this repo only). The choice here determines only where the data lives.

- If Bundled → follow the **Bundled Path** below
- If Docker → follow the **Docker Path** below
- If Native → follow the **Native Path** below
- If RDS → follow the **RDS Path** below

---

## Bundled Path

Everything (PostgreSQL + Ollama + MCP server) runs in one container. Ollama provides embeddings locally — no API key needed. The container exposes only the MCP HTTP port. Data is persisted in named Docker volumes.

### B1: Prerequisites

| Dependency | Check | Install (macOS) |
|------------|-------|-----------------|
| Docker Desktop | `docker --version` | https://docker.com/products/docker-desktop |
| Node.js (v18+) | `node --version` | `brew install node` (only needed if building from source) |

### B2: Choose a Brain Name and Port

- **Name** (default: `default`) — determines container name: `mybrain_<name>`
- **Port** (default: `8787`) — the only host port exposed

If `.mybrain/` exists, check for port conflicts in existing `compose.yml` files.

### B3: Scaffold Directory

**Show the user what you're about to create and ask for confirmation.**

Create `.mybrain/<name>/`:

```
.mybrain/<name>/
  compose.yml        # Single-container compose (built from Dockerfile.bundled)
  .env               # MYBRAIN_NAME, MYBRAIN_PORT, BRAIN_SCOPE
```

**compose.yml** — copy from `templates/compose.bundled.yml`, substituting `<name>` and `<port>`:

```yaml
services:
  mybrain:
    build:
      context: <path-to-plugin>
      dockerfile: templates/Dockerfile.bundled
    image: mybrain-bundled:latest
    container_name: mybrain_<name>
    restart: unless-stopped
    ports:
      - "<port>:8787"
    volumes:
      - mybrain_<name>_pgdata:/var/lib/postgresql/data
      - mybrain_<name>_ollama_models:/root/.ollama
    environment:
      MYBRAIN_PORT: "8787"
      BRAIN_SCOPE: "${BRAIN_SCOPE:-personal}"
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:8787/health || exit 1"]
      interval: 10s
      timeout: 5s
      start_period: 300s
      retries: 12

volumes:
  mybrain_<name>_pgdata:
  mybrain_<name>_ollama_models:
```

**.env**:
```env
MYBRAIN_NAME=<name>
MYBRAIN_PORT=<port>
BRAIN_SCOPE=personal
OLLAMA_MODEL=gte-qwen2-1.5b-instruct    # 1536-dim, matches default schema
MYBRAIN_ASYNC_STORAGE=<true|false>      # see B4 below
```

The default `OLLAMA_MODEL` is `gte-qwen2-1.5b-instruct` (1536-dim native). To use a 1024-dim model instead (e.g. `mxbai-embed-large`), substitute `{{EMBED_DIM}}=1024` in `schema.sql` at scaffold time AND set `OLLAMA_MODEL=mxbai-embed-large` here.

### B4: Async Memory Storage (ask)

Before building, ask: **"Enable async memory storage? `capture_thought` returns instantly (~3ms) and embeddings run in the background. Trade-off: a thought becomes searchable ~1s after capture. Recommended for Bundled mode since local Ollama is slower than cloud embeddings. (yes / no, default: yes)"**

- **Yes (default):** set `MYBRAIN_ASYNC_STORAGE=true` in `.env`.
- **No:** set `MYBRAIN_ASYNC_STORAGE=false` in `.env`.

Either way, write the chosen value to `.env` before starting the container.

### B5: Build and Start

```bash
cd .mybrain/<name> && docker compose up -d --build
```

The first build downloads the Ollama binary and installs Node.js into the image (~500 MB). First boot pulls the configured `OLLAMA_MODEL` (default `gte-qwen2-1.5b-instruct`, ~1.7 GB) into the volume — one-time. Watch logs: `docker compose logs -f mybrain`.

Wait for: `mybrain is ready — MCP HTTP at http://localhost:<port>`

### B6: Register MCP Server (local scope, this repo only)

Register MyBrain with **local scope** — visible to this user, in this project, nowhere else. This is the default scope; do **not** pass `--scope user` or `--scope project`.

```bash
claude mcp add mybrain --transport http --url "http://localhost:<port>"
```

If `claude mcp add` complains that a `mybrain` entry already exists, you missed Step 0 — run `claude mcp list`, identify the offending registration, and remove it per Step 0.3 before retrying.

### B7: Verify

Restart Claude Code. Test: "How many thoughts do I have?" — should call `brain_stats`.

### B8: Optional — Install Hooks

After setup, offer these two optional steps. Both are independently skippable — if the user says no or skip to either, move on without error.

#### A) Append MyBrain protocol to global CLAUDE.md

Ask: **"Would you like to append the MyBrain brain protocol to ~/.claude/CLAUDE.md so Claude uses your brain automatically in every session? (yes / skip)"**

- **Skip (default):** do nothing. The user can re-run `/mybrain-setup` at any time to add it later.
- **Yes:** read `~/.claude/CLAUDE.md` (create if missing), remove any existing `<!-- mybrain:begin -->…<!-- mybrain:end -->` block, then append:

```markdown

<!-- mybrain:begin -->
## MyBrain Protocol

Use the mybrain MCP server in every session. Tools: `search_thoughts`, `capture_thought`, `browse_thoughts`, `brain_stats`.

At session start, call `search_thoughts` with a query derived from the user's first substantive message (skip trivial greetings). Before answering questions with likely prior history, call `search_thoughts` first. Call `capture_thought` when the user expresses a decision, preference, correction, or commitment. At the end of a meaningful conversation, capture a summary thought.
<!-- mybrain:end -->
```

This block is idempotent — re-running setup replaces it cleanly.

#### B) Install shell wrappers

Ask: **"Would you like to install shell wrappers so the mybrain container auto-starts whenever you run `claude`? (yes / skip)"**

- **Skip (default):** do nothing. Files are available in the plugin's `shell/` directory whenever the user wants them.
- **Yes:**
  1. Create `~/.claude/mybrain/shell/`
  2. Copy `shell/mybrain.{zsh,bash,fish,csh,tcsh}` and `shell/mybrain-preflight.sh` there
  3. Copy `.mybrain/<name>/compose.yml` to `~/.claude/mybrain/compose.yml` (so the wrapper can find the compose file without pointing back into the plugin cache)
  4. **Print** (do NOT execute) the line the user must add to their own shell rc file:

```
# ─── MyBrain preflight ───────────────────────────────────────────────────────
# Add this to your shell rc file (~/.zshrc, ~/.bashrc, ~/.config/fish/config.fish, etc.):
[ -f ~/.claude/mybrain/shell/mybrain.zsh ] && source ~/.claude/mybrain/shell/mybrain.zsh
```

**Never write to `~/.zshrc` or any shell rc file.** Print the line; the user adds it themselves.

The wrapper behavior once sourced:
- **Already healthy:** one log line, Claude Code starts immediately (sub-100ms overhead)
- **Not healthy:** starts/restarts container via `docker compose up -d`, polls `/health` up to `$MYBRAIN_HEALTH_TIMEOUT` seconds (default 120), then starts Claude Code
- **Docker not running:** logs a warning and starts Claude Code anyway — brain unavailable but nothing blocks

Tunables the user can set in their rc before the `source` line:
```sh
export MYBRAIN_HEALTH_TIMEOUT=60    # seconds to wait (default: 120)
export MYBRAIN_QUIET=1              # suppress all mybrain output (default: 0)
```

---

## Docker Path

### D1: Prerequisites

| Dependency | Check | Install (macOS) |
|------------|-------|-----------------|
| Podman or Docker | `podman --version` or `docker --version` | `brew install podman` |
| Node.js (v18+) | `node --version` | `brew install node` |

### D2: Choose Embedding Provider

Ask: **"Do you want to use OpenRouter (cloud) or Ollama (local) for embeddings?"**

- **OpenRouter** (default): requires an API key, costs ~$0.0001/call, no local GPU needed
- **Ollama**: free, runs locally, requires Ollama installed on the host or activated via compose profile

If Ollama: enable the `ollama` compose profile in D8 (`docker compose --profile ollama up -d`).

### D3: Get API Key (OpenRouter only)

If OpenRouter: ask for the **OpenRouter API key**. If they don't have one:
- Sign up at https://openrouter.ai — go to https://openrouter.ai/keys
- The embedding model (`text-embedding-3-small`, 1536 dims native) costs fractions of a cent per call

### D4: Choose a Brain Name

Ask what to name this brain instance. Default: `default`. Determines:
- Subdirectory: `.mybrain/<name>/`
- MCP server name: `mybrain` or `mybrain-<name>`
- Container names: `mybrain_<name>_postgres`, `mybrain_<name>_mcp`

Check for conflicts in existing `.mybrain/*/compose.yml`.

### D5: Assign Ports

Each brain needs two ports:
- `default`: MCP 8787, PostgreSQL 5433
- Additional brains: increment (8788/5434, 8789/5435, ...)

### D6: Scaffold Files

**Show the user what you're about to create and ask for confirmation.**

Copy all files from the plugin's `templates/` directory into `.mybrain/<name>/`:

```
.mybrain/<name>/
  compose.yml       # PostgreSQL + optional Ollama + MCP server
  .env              # API key + EMBEDDING_PROVIDER + optional BRAIN_SCOPE
  schema.sql        # Full schema with ltree, scored search
  Dockerfile        # MCP container build
  package.json      # Dependencies
  server.mjs        # MCP server (ltree-aware, dual-mode)
```

**compose.yml** (replace `<name>`, `<mcp-port>`, `<pg-port>`):

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17
    container_name: mybrain_<name>_postgres
    environment:
      POSTGRES_DB: mybrain
      POSTGRES_USER: mybrain
      POSTGRES_PASSWORD: mybrain
    ports:
      - "<pg-port>:5432"
    volumes:
      - mybrain_<name>_data:/var/lib/postgresql/data
      - ./schema.sql:/docker-entrypoint-initdb.d/schema.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U mybrain"]
      interval: 5s
      timeout: 5s
      retries: 5

  ollama:
    image: ollama/ollama
    container_name: mybrain_<name>_ollama
    profiles: [ollama]
    volumes:
      - mybrain_<name>_ollama:/root/.ollama
    environment:
      OLLAMA_MODEL: ${OLLAMA_MODEL:-gte-qwen2-1.5b-instruct}
    entrypoint: ["/bin/sh", "-c", "ollama serve & sleep 3 && ollama pull \"${OLLAMA_MODEL}\"; wait"]
    healthcheck:
      test: ["CMD-SHELL", "ollama list 2>/dev/null | grep -q \"${OLLAMA_MODEL}\" || exit 1"]
      interval: 15s
      timeout: 10s
      retries: 10
      start_period: 300s

  mcp:
    build: .
    container_name: mybrain_<name>_mcp
    environment:
      MCP_TRANSPORT: http
      PORT: "8787"
      DATABASE_URL: postgresql://mybrain:mybrain@postgres:5432/mybrain
      EMBEDDING_PROVIDER: ${EMBEDDING_PROVIDER:-openrouter}
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}
      OLLAMA_HOST: ${OLLAMA_HOST:-http://ollama:11434}
      OLLAMA_MODEL: ${OLLAMA_MODEL:-gte-qwen2-1.5b-instruct}
      BRAIN_SCOPE: ${BRAIN_SCOPE:-}
    ports:
      - "<mcp-port>:8787"
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:8787/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 3

volumes:
  mybrain_<name>_data:
  mybrain_<name>_ollama:
```

**.env**:
```env
EMBEDDING_PROVIDER=openrouter
OPENROUTER_API_KEY=<user's key>
# BRAIN_SCOPE=personal
# OLLAMA_MODEL=gte-qwen2-1.5b-instruct  # only when EMBEDDING_PROVIDER=ollama
MYBRAIN_ASYNC_STORAGE=<true|false>      # see D7 below
```

### D7: Async Memory Storage (ask)

Ask: **"Enable async memory storage? `capture_thought` returns instantly (~3ms) and embeddings run in the background. Trade-off: a thought becomes searchable ~1s after capture. Recommended if you chose Ollama in D2 (local embeddings are slower); optional for OpenRouter. (yes / no, default: no for OpenRouter, yes for Ollama)"**

- **Yes:** set `MYBRAIN_ASYNC_STORAGE=true` in `.env`.
- **No:** set `MYBRAIN_ASYNC_STORAGE=false` in `.env`.

Default to `yes` if the user chose Ollama in D2, `no` if OpenRouter.

### D8: Start and Verify

```bash
# OpenRouter (default)
cd .mybrain/<name> && docker compose up -d

# With Ollama
cd .mybrain/<name> && docker compose --profile ollama up -d
```

Register the MCP with **local scope** (this repo only — do not pass `--scope user` or `--scope project`):
```bash
claude mcp add mybrain --transport http --url "http://localhost:<mcp-port>"
```

Restart Claude Code. Test: "How many thoughts do I have?"

---

## Native Path

No Docker. Ollama runs directly on the host (Homebrew, the official installer, or whatever the user already uses), Postgres is whatever PG the user has installed locally or any remote PG they can reach, and the MCP server runs as a local process registered with `claude mcp add`.

### N1: Prerequisites

| Dependency | Check | Install (macOS) |
|------------|-------|-----------------|
| Ollama | `ollama --version` | `brew install ollama` then `ollama serve` (or run it as a launchd service) |
| Node.js (v18+) | `node --version` | `brew install node` |
| PostgreSQL with pgvector + ltree | `psql -c "SELECT extversion FROM pg_extension WHERE extname IN ('vector','ltree')"` | `brew install postgresql@16 pgvector` then enable extensions in your DB |

If any dependency is missing, give the install command and wait for confirmation. Do not proceed until Ollama is running and `ollama list` works without error.

### N2: Pull the Embedding Model

Default: `gte-qwen2-1.5b-instruct` (1536-dim native, matches the default schema).

```bash
ollama pull gte-qwen2-1.5b-instruct
```

If the user wants a 1024-dim local model (e.g. `mxbai-embed-large`), pull that instead AND substitute `{{EMBED_DIM}}=1024` in `schema.sql` at scaffold time.

### N3: Choose a Brain Name and Scope

- **Name** (default: `default`) — determines MCP server name: `mybrain` or `mybrain-<name>`
- **Scope** — ltree scope to isolate this brain (e.g. `personal`, `work.research`)

### N4: Construct DATABASE_URL

Ask the user for their Postgres connection string. Examples:

- Local Postgres on default port: `postgresql://<user>@localhost:5432/mybrain`
- Local Postgres with password: `postgresql://<user>:<password>@localhost:5432/mybrain`
- Any reachable remote PG: `postgresql://<user>:<password>@<host>:5432/<database>`

If the database is fresh, apply the schema. The schema ships with a `{{EMBED_DIM}}` placeholder — substitute at scaffold time:

```bash
# Default (1536-dim, matches gte-qwen2-1.5b-instruct and OpenRouter defaults)
sed 's/{{EMBED_DIM}}/1536/g' <path-to-plugin>/templates/schema.sql | psql "<DATABASE_URL>" -f -

# 1024-dim opt-in (mxbai-embed-large or similar)
sed 's/{{EMBED_DIM}}/1024/g' <path-to-plugin>/templates/schema.sql | psql "<DATABASE_URL>" -f -
```

If the database already has a `thoughts` table, do NOT re-apply the schema. The MCP server logs the detected dim at startup; existing installs are never auto-migrated.

### N5: Async Memory Storage (ask)

Ask: **"Enable async memory storage? `capture_thought` returns instantly and embeddings run in the background. Trade-off: a thought becomes searchable ~1s after capture. Recommended in Native mode since local Ollama is slower than cloud embeddings. (yes / no, default: yes)"**

### N6: Register the MCP Server (local scope, this repo only)

Both register commands below use **local scope** (the default for `claude mcp add`). Do **not** pass `--scope user` or `--scope project`.

Choose stdio (default) or http transport:

**Stdio (default)** — MCP runs as a child of Claude Code:
```bash
claude mcp add mybrain --transport stdio \
  -e DATABASE_URL="<constructed URL>" \
  -e EMBEDDING_PROVIDER=ollama \
  -e OLLAMA_HOST="http://localhost:11434" \
  -e OLLAMA_MODEL="gte-qwen2-1.5b-instruct" \
  -e BRAIN_SCOPE="<scope>" \
  -e MYBRAIN_ASYNC_STORAGE="<true|false>" \
  -- node <path-to-plugin>/server.mjs
```

**HTTP** — MCP runs as a long-lived local process on a port. Start it manually (or via launchd / systemd) and register the URL:
```bash
# Start the server (in a separate terminal or as a service)
DATABASE_URL="<constructed URL>" \
EMBEDDING_PROVIDER=ollama \
OLLAMA_HOST="http://localhost:11434" \
OLLAMA_MODEL="gte-qwen2-1.5b-instruct" \
BRAIN_SCOPE="<scope>" \
MYBRAIN_ASYNC_STORAGE="<true|false>" \
PORT=8787 \
  node <path-to-plugin>/server.mjs http

# Register with Claude Code (local scope)
claude mcp add mybrain --transport http --url "http://localhost:8787"
```

The path to `server.mjs` depends on how the plugin was installed:
- Plugin marketplace: `${CLAUDE_PLUGIN_ROOT}/server.mjs`
- Manual clone: wherever the user cloned the repo

### N7: Verify

Restart Claude Code. Test: "How many thoughts do I have?" — should call `brain_stats` and return a count scoped to the user's ltree scope. The MCP server logs `embedding dim: 1536 (detected)` (or `1024`) on startup; if the log shows a mismatch with the model the user pulled, stop and re-check N2 + N4.

---

## RDS Path

### R1: Gather Connection Details

Ask the user for:

1. **RDS host** — e.g. `my-brain.abc123.us-east-2.rds.amazonaws.com`
2. **Database name** — e.g. `projects_brain`
3. **Username**
4. **Password**
5. **SSL mode** — default: `?ssl=true&sslmode=no-verify`
6. **Scope** — ltree scope (e.g. `personal`, `myproject.app`)
7. **OpenRouter API key**

### R2: Construct DATABASE_URL

```
postgresql://<user>:<password>@<host>:5432/<database>?ssl=true&sslmode=no-verify
```

### R3: Async Memory Storage (ask)

Ask: **"Enable async memory storage? `capture_thought` returns instantly and embeddings run in the background. Trade-off: a thought becomes searchable ~1s after capture. In RDS/stdio mode the worker only runs while Claude Code is open — thoughts captured right before you close Claude may embed on the next launch instead. (yes / no, default: no)"**

If yes, add `-e MYBRAIN_ASYNC_STORAGE=true` to the `claude mcp add` command in R4.

### R4: Register MCP Server (local scope, this repo only)

Register with **local scope** — the default for `claude mcp add`. Do **not** pass `--scope user` or `--scope project`. The shared remote DB is namespaced per-repo by `BRAIN_SCOPE`, not by MCP scope.

```bash
claude mcp add mybrain --transport stdio \
  -e DATABASE_URL="<constructed URL>" \
  -e OPENROUTER_API_KEY="<key>" \
  -e BRAIN_SCOPE="<scope>" \
  -e MYBRAIN_ASYNC_STORAGE="<true|false>" \
  -- node <path-to-plugin>/server.mjs
```

### R5: Verify Schema

If the database is fresh, apply the schema. The schema ships with a `{{EMBED_DIM}}` placeholder — substitute at scaffold time (default `1536` for OpenRouter `text-embedding-3-small`):

```bash
sed 's/{{EMBED_DIM}}/1536/g' <path-to-plugin>/templates/schema.sql | psql "<DATABASE_URL>" -f -
```

If the database already has a `thoughts` table, do NOT re-apply the schema. The MCP server logs the detected dim at startup; existing installs are never auto-migrated.

### R6: Test

Restart Claude Code. Test: "How many thoughts do I have?"

---

## Summary Template

```
MyBrain installed successfully.

Scope:     local (this repo only — registration is not visible to other projects)
Backend:   {{Bundled | Docker | Native | RDS}}

{{if Bundled}}
Container: mybrain_<name> (PostgreSQL + Ollama + MCP — one container)
MCP:       http://localhost:<port>
Volumes:   mybrain_<name>_pgdata, mybrain_<name>_ollama_models
Embeddings: {{OLLAMA_MODEL}} (local Ollama — no API key needed)
{{/if}}

{{if Docker}}
Location:  .mybrain/<name>/
Database:  PostgreSQL + pgvector (port <pg-port>)
MCP:       http://localhost:<mcp-port>
Embeddings: {{OpenRouter | local Ollama ({{OLLAMA_MODEL}})}}
{{/if}}

{{if Native}}
Database:  <user-supplied DATABASE_URL>
Scope:     <scope>
Ollama:    host-installed at {{OLLAMA_HOST}} (model: {{OLLAMA_MODEL}})
MCP:       {{stdio | http://localhost:<port>}}
{{/if}}

{{if RDS}}
Database:  <host>/<database>
Scope:     <scope>
MCP:       stdio
Embeddings: OpenRouter (text-embedding-3-small, 1536-dim)
{{/if}}

Async memory storage: {{enabled | disabled}}

Tools:
  capture_thought   — Save a thought
  search_thoughts   — Semantic search
  browse_thoughts   — List recent thoughts (free)
  brain_stats       — Statistics (free)

Try: "Remember this: I just set up MyBrain"
```

---

## Important Notes

- **Install scope is always local — `--scope user` and `--scope project` are deprecated.** User scope made one `mybrain` registration visible in every project on the machine, which caused brains to fail to start (port races between repos sharing one URL) and thoughts to be attributed to the wrong project. Project scope shipped the registration to teammates via `.mcp.json`. Step 0 detects either and offers to remove it before installing. If `claude mcp add` complains "mybrain already exists" mid-install, that's the failure mode — back out, run Step 0, retry.
- **Removing a deprecated scope affects other projects on the same machine.** When Step 0 removes a `--scope user` registration, every other project that was using it loses its `mybrain` server. Each of those projects must re-run `/mybrain-setup` once. Brain *data* (DBs, containers, volumes) is untouched — only the Claude Code registration is removed.
- **Do NOT use `z.record(z.any())` in zod schemas.** Use `z.record(z.string(), z.unknown())`. The MCP SDK crashes on `z.any()` from zod v4.
- **`onsessioninitialized` is a constructor option**, not a property assignment.
- **Credentials must never be committed.** Ensure `.env` files are in `.gitignore`.
- **Bundled mode — first boot takes ~2-5 min** on a fast connection (image build + initial model pull). The default `gte-qwen2-1.5b-instruct` is ~1.7 GB; on a slow connection the container's healthcheck `start_period` (300s) may not cover the pull. If healthchecks fail on first boot, wait — Docker's restart policy will keep the container coming back, and the model is cached in the volume after first successful pull. Subsequent starts are under 10s.
- **Embedding dim and the schema** — the schema's `{{EMBED_DIM}}` placeholder is substituted at scaffold time (default `1536`). The default Ollama model (`gte-qwen2-1.5b-instruct`) and OpenRouter's `text-embedding-3-small` both produce 1536-dim vectors. Switching to a 1024-dim local model (e.g. `mxbai-embed-large`) requires substituting `{{EMBED_DIM}}=1024` AND setting `OLLAMA_MODEL=mxbai-embed-large` together — never one without the other. Existing installs are never auto-migrated; the MCP server logs the detected dim at startup and pgvector raises a clear error on dimension mismatch at insert time.
- **ltree scoping** — when `BRAIN_SCOPE` is set, all queries filter by `scope @> ARRAY['<scope>']::ltree[]`. Multiple users/projects can share one database without leaking thoughts.
- **Never write to the user's shell rc files** (`~/.zshrc`, `~/.bashrc`, etc.). Print the line and let the user add it.
- **Async memory storage (`MYBRAIN_ASYNC_STORAGE=true`)** — `capture_thought` inserts with `embedding=NULL` and returns in ~3ms; a background worker in the same Node process polls NULL-embedding rows every 500ms and fills them in. The `thoughts` table itself is the queue, so nothing is lost on crash. Trade-off: thoughts are not retrievable via `search_thoughts` until the embedding is generated (typically <1s). Recommended with local Ollama where the embedding call is the slow path.
