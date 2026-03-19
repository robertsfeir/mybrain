---
name: mybrain-init
description: Scaffold a project-local MyBrain instance. Creates .mybrain/ with all server files, compose, env, and schema, then wires it into .mcp.json. Supports multiple named brains per project.
---

# MyBrain -- Init

Scaffold a project-local MyBrain instance with minimal effort. Creates a fully self-contained directory with everything needed to build and run, then wires it into `.mcp.json` so Claude Code picks it up on next session start.

## Init Procedure

### Step 1: Choose a Brain Name

Ask the user what they want to name this brain. The name determines:
- The subdirectory: `.mybrain/<name>/`
- The MCP server name in `.mcp.json`: `mybrain` (for default) or `mybrain-<name>`
- Container names: `mybrain_<name>_postgres`, `mybrain_<name>_mcp`

Default name is `default`. Suggest alternatives if the user has a specific use case (e.g. `research`, `tasks`, `notes`, `work`).

If `.mybrain/` already exists, check which brains are already set up and show them. Help the user pick a name that doesn't conflict.

### Step 2: Assign Ports

Each brain needs two ports: one for PostgreSQL and one for the MCP HTTP server.

**Port allocation scheme:**
- `default` brain: MCP 8787, PostgreSQL 5433
- Additional brains: increment from there (8788/5434, 8789/5435, ...)

Check existing `.mybrain/*/compose.yml` files to see which ports are taken. Pick the next available pair.

### Step 3: Get OpenRouter API Key

Check if another brain already exists in `.mybrain/`. If so, offer to reuse its `.env` API key.

If this is the first brain, ask the user for their **OpenRouter API key**. If they don't have one:
- Sign up at https://openrouter.ai
- Go to https://openrouter.ai/keys
- Create a key and add a few dollars in credits
- The embedding model (`text-embedding-3-small`) costs fractions of a cent per call

That's the only credential needed.

### Step 4: Scaffold Files

The scaffolded directory must be **fully self-contained** — everything needed to `podman compose up` without any external references. Copy all server files from the plugin's `templates/` directory.

**Show the user what you're about to create and ask for confirmation before writing.**

```
.mybrain/
  <name>/
    compose.yml       # PostgreSQL + MCP server, with assigned ports
    .env              # OpenRouter API key
    schema.sql        # Database schema (copied from plugin templates/schema.sql)
    Dockerfile        # Container build (copied from plugin templates/Dockerfile)
    package.json      # Dependencies (copied from plugin templates/package.json)
    server.mjs        # MCP server source (copied from plugin templates/server.mjs)
```

**How to find the plugin source files:** The plugin's `templates/` directory is located relative to this skill file. Use the plugin installation path to locate these files and copy their contents into the scaffolded directory.

**compose.yml** — use this template, replacing `<name>`, `<mcp-port>`, and `<pg-port>`:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
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

  mcp:
    build: .
    container_name: mybrain_<name>_mcp
    environment:
      MCP_TRANSPORT: http
      PORT: "8787"
      DATABASE_URL: postgresql://mybrain:mybrain@postgres:5432/mybrain
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY}
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
```

Note: `build: .` points to the scaffolded directory itself, which contains the Dockerfile, server.mjs, and package.json.

**.env** — just the API key:

```env
OPENROUTER_API_KEY=<user's key>
```

Also add `.mybrain/*/.env` to the project's `.gitignore` if not already there.

### Step 5: Update .mcp.json

Read the existing `.mcp.json` in the project root (create it if it doesn't exist). Add the new brain:

For the `default` brain:
```json
{
  "mcpServers": {
    "mybrain": {
      "url": "http://localhost:8787/mcp"
    }
  }
}
```

For a named brain (e.g. `research`):
```json
{
  "mcpServers": {
    "mybrain-research": {
      "url": "http://localhost:8788/mcp"
    }
  }
}
```

Merge with any existing entries — do not overwrite other MCP servers.

**Show the user the `.mcp.json` change and ask for confirmation before writing.**

### Step 6: Start It Up

Ask the user if they want to start the brain now:

```bash
cd .mybrain/<name>
podman compose up -d
```

Wait for healthy status:

```bash
podman compose ps
```

### Step 7: Print Summary

```
MyBrain "<name>" initialized.

Location:   .mybrain/<name>/
MCP server: http://localhost:<mcp-port>/mcp
Database:   PostgreSQL + pgvector on port <pg-port>
Registered: .mcp.json as "mybrain" (or "mybrain-<name>")

To start:   podman compose -f .mybrain/<name>/compose.yml up -d
To stop:    podman compose -f .mybrain/<name>/compose.yml down
To logs:    podman compose -f .mybrain/<name>/compose.yml logs -f mcp

Restart Claude Code to activate the tools.
```

If multiple brains exist, list them all with their ports and status.

## Important Notes

- **Always confirm before writing files or modifying `.mcp.json`.** This is a guided process.
- **The scaffolded directory must be self-contained.** All files needed to build and run must be inside `.mybrain/<name>/`. Do not reference paths outside the scaffolded directory.
- **`.env` files must not be committed.** Ensure `.gitignore` covers `.mybrain/*/.env`.
- **Port conflicts:** If the assigned port is in use, try the next one. Check with `podman compose ps` or `lsof -i :<port>`.
- **OpenRouter credits:** capture and search cost fractions of a cent per call. Browse and stats are free (pure SQL).
