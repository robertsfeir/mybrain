---
name: mybrain-setup
description: Use when users want to install or set up MyBrain -- a personal knowledge base with semantic search. Supports three modes -- Bundled (single container, no API key needed), Docker (multi-container with OpenRouter or Ollama), or RDS (shared remote database). Guides through setup, MCP registration, and optional install hooks.
---

# MyBrain -- Setup

This skill installs MyBrain. Three deployment modes are available:

- **Bundled** -- PostgreSQL, Ollama, and the MCP server all run inside a **single container**. No API key needed. One port. One volume. Recommended for personal use.
- **Docker** -- Multi-container: PostgreSQL + optional Ollama (compose profile) + MCP server. Uses OpenRouter or Ollama for embeddings.
- **RDS** -- Connect to a shared PostgreSQL database on AWS RDS. Supports ltree scoping to isolate thoughts per user/project.

## Step 1: Choose Deployment Mode

Ask the user: **"How do you want to run MyBrain?"**

> 1. **Bundled** — single container, self-contained, no API key (recommended)
> 2. **Docker** — multi-container, OpenRouter or Ollama for embeddings
> 3. **RDS** — remote PostgreSQL on AWS RDS or any shared Postgres

- If Bundled → follow the **Bundled Path** below
- If Docker → follow the **Docker Path** below
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
```

### B4: Build and Start

```bash
cd .mybrain/<name> && docker compose up -d --build
```

The first build downloads the Ollama binary and installs Node.js into the image (~500 MB). First boot pulls the `mxbai-embed-large` model into the volume (~700 MB, one-time). Watch logs: `docker compose logs -f mybrain`.

Wait for: `mybrain is ready — MCP HTTP at http://localhost:<port>`

### B5: Register MCP Server

Register as a **user-scoped** MCP server (available in all projects):

```bash
claude mcp add mybrain --scope user --transport http \
  --url "http://localhost:<port>"
```

Or project-scoped (only the current project):

```bash
claude mcp add mybrain --transport http --url "http://localhost:<port>"
```

### B6: Verify

Restart Claude Code. Test: "How many thoughts do I have?" — should call `brain_stats`.

### B7: Optional — Install Hooks

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

If Ollama: enable the `ollama` compose profile in D5 (`docker compose --profile ollama up -d`).

### D3: Get API Key (OpenRouter only)

If OpenRouter: ask for the **OpenRouter API key**. If they don't have one:
- Sign up at https://openrouter.ai — go to https://openrouter.ai/keys
- The embedding model (`text-embedding-3-small` at 1024 dims) costs fractions of a cent per call

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
    entrypoint: ["/bin/sh", "-c", "ollama serve & sleep 3 && ollama pull mxbai-embed-large; wait"]
    healthcheck:
      test: ["CMD-SHELL", "ollama list 2>/dev/null | grep -q mxbai-embed-large || exit 1"]
      interval: 15s
      timeout: 10s
      retries: 10
      start_period: 120s

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
```

### D7: Start and Verify

```bash
# OpenRouter (default)
cd .mybrain/<name> && docker compose up -d

# With Ollama
cd .mybrain/<name> && docker compose --profile ollama up -d
```

Register the MCP:
```bash
claude mcp add mybrain --transport http --url "http://localhost:<mcp-port>"
```

Restart Claude Code. Test: "How many thoughts do I have?"

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

### R3: Register MCP Server

```bash
claude mcp add mybrain --transport stdio \
  -e DATABASE_URL="<constructed URL>" \
  -e OPENROUTER_API_KEY="<key>" \
  -e BRAIN_SCOPE="<scope>" \
  -- node <path-to-plugin>/server.mjs
```

### R4: Verify Schema

If the database is fresh, apply the schema:

```bash
psql "<DATABASE_URL>" -f templates/schema.sql
```

### R5: Test

Restart Claude Code. Test: "How many thoughts do I have?"

---

## Summary Template

```
MyBrain installed successfully.

Mode:      {{Bundled | Docker | RDS}}

{{if Bundled}}
Container: mybrain_<name> (PostgreSQL + Ollama + MCP — one container)
MCP:       http://localhost:<port>
Volumes:   mybrain_<name>_pgdata, mybrain_<name>_ollama_models
Embeddings: mxbai-embed-large (local Ollama — no API key needed)
{{/if}}

{{if Docker}}
Location:  .mybrain/<name>/
Database:  PostgreSQL + pgvector (port <pg-port>)
MCP:       http://localhost:<mcp-port>
Embeddings: {{OpenRouter | local Ollama}}
{{/if}}

{{if RDS}}
Database:  <host>/<database>
Scope:     <scope>
MCP:       stdio
{{/if}}

Tools:
  capture_thought   — Save a thought
  search_thoughts   — Semantic search
  browse_thoughts   — List recent thoughts (free)
  brain_stats       — Statistics (free)

Try: "Remember this: I just set up MyBrain"
```

---

## Important Notes

- **Do NOT use `z.record(z.any())` in zod schemas.** Use `z.record(z.string(), z.unknown())`. The MCP SDK crashes on `z.any()` from zod v4.
- **`onsessioninitialized` is a constructor option**, not a property assignment.
- **Credentials must never be committed.** Ensure `.env` files are in `.gitignore`.
- **Bundled mode — first boot takes ~2-5 min** on a fast connection (image build + mxbai-embed-large model pull ~700 MB). Subsequent starts are under 10s.
- **ltree scoping** — when `BRAIN_SCOPE` is set, all queries filter by `scope @> ARRAY['<scope>']::ltree[]`. Multiple users/projects can share one database without leaking thoughts.
- **Never write to the user's shell rc files** (`~/.zshrc`, `~/.bashrc`, etc.). Print the line and let the user add it.
