---
name: mybrain-setup
description: Use when users want to install or set up MyBrain -- a personal knowledge base with semantic search backed by local PostgreSQL. Guides them through database setup, MCP server installation, Claude Code configuration, and optional Claude Desktop access via Cloudflare Tunnel.
---

# MyBrain -- Setup

This skill installs MyBrain into the user's system. It sets up a local PostgreSQL database with vector search, an MCP server, and optionally a Cloudflare Tunnel for Claude Desktop access.

## Prerequisites

Before starting, verify these are installed. If any are missing, give the user the install command and wait for them to confirm before continuing.

| Dependency | Check Command | Install Command |
|------------|--------------|-----------------|
| Node.js (v18+) | `node --version` | `brew install node` (macOS) or https://nodejs.org |
| PostgreSQL | `psql --version` | `brew install postgresql@17` (macOS) |
| pgvector | `ls $(pg_config --sharedir)/extension/vector.control 2>/dev/null` | `brew install pgvector` (macOS) |

PostgreSQL must be running: `brew services start postgresql@17`

## Setup Procedure

### Step 1: Gather Information

Ask the user these questions **one at a time, conversationally**. Do not dump a list.

**Required:**

1. **Database name** -- What should the database be called? (default: `mybrain`)
2. **Database connection** -- Are you using the default local PostgreSQL with no password? If not, what is your connection string? (default: `postgresql://localhost:5432/mybrain`)
3. **OpenRouter API key** -- Do you have an OpenRouter API key? If not, sign up at https://openrouter.ai, go to https://openrouter.ai/keys, create a key, and add a few dollars in credits. The embedding model (`text-embedding-3-small`) costs fractions of a cent per call.

**Optional (for Claude Desktop access):**

4. **Claude Desktop access** -- Do you want MyBrain accessible from the Claude Desktop app (claude.ai)? This requires a Cloudflare Tunnel. (default: no)
5. **Cloudflare domain** -- If yes to above: What domain do you have on Cloudflare? We will create a subdomain like `brain.yourdomain.com`. (Only ask if they said yes to #4)

Store all answers for use in later steps.

### Step 2: Create the Database

Run these commands:

```bash
psql -d postgres -c "CREATE DATABASE {{DATABASE_NAME}};"
psql -d {{DATABASE_NAME}} -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

If the database already exists, ask the user if they want to use the existing one or drop and recreate it.

### Step 3: Create the Schema

Read the template file `templates/schema.sql` from the plugin directory and execute it against the database:

```bash
psql -d {{DATABASE_NAME}} -f path/to/templates/schema.sql
```

Or paste the contents into a `psql -d {{DATABASE_NAME}}` session.

### Step 4: Install the MCP Server

Choose an installation directory. Default: `~/.mybrain/`

```bash
mkdir -p ~/.mybrain
```

1. Copy `templates/server.mjs` to `~/.mybrain/server.mjs`
2. Copy `templates/package.json` to `~/.mybrain/package.json`
3. Run `npm install` in `~/.mybrain/`

```bash
cd ~/.mybrain && npm install
```

Verify the server starts:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | DATABASE_URL={{DATABASE_URL}} OPENROUTER_API_KEY={{OPENROUTER_KEY}} node ~/.mybrain/server.mjs
```

You should see a JSON response with `"serverInfo":{"name":"mybrain"}`. Press Ctrl+C to stop.

### Step 5: Configure Claude Code CLI

Run this command (replace the placeholder values):

```bash
claude mcp add mybrain --transport stdio \
  -e DATABASE_URL={{DATABASE_URL}} \
  -e OPENROUTER_API_KEY={{OPENROUTER_KEY}} \
  -- node ~/.mybrain/server.mjs
```

This registers MyBrain as an MCP server in Claude Code. Restart Claude Code (`/exit` and relaunch) to pick it up.

**Test it:** In a new Claude Code session, say "How many thoughts do I have?" -- Claude should call `brain_stats` and report 0 thoughts.

### Step 6: Set Up Background HTTP Server (only if Claude Desktop access requested)

This step is only needed if the user wants Claude Desktop (claude.ai) access.

#### 6a: Create the launchd agent for the MCP HTTP server

Write this file to `~/Library/LaunchAgents/com.mybrain.mcp.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.mybrain.mcp</string>
    <key>ProgramArguments</key>
    <array>
        <string>{{NODE_PATH}}</string>
        <string>{{HOME}}/.mybrain/server.mjs</string>
        <string>http</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>DATABASE_URL</key>
        <string>{{DATABASE_URL}}</string>
        <key>OPENROUTER_API_KEY</key>
        <string>{{OPENROUTER_KEY}}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/mybrain-mcp.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/mybrain-mcp.log</string>
</dict>
</plist>
```

Replace `{{NODE_PATH}}` with the output of `which node` (e.g., `/opt/homebrew/bin/node`).
Replace `{{HOME}}` with the user's home directory.

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.mybrain.mcp.plist
```

Verify: `tail -1 /tmp/mybrain-mcp.log` should show "mybrain MCP server running on http://localhost:8787"

#### 6b: Cloudflare Tunnel Setup

**Print the following instructions verbatim for the user to follow manually.** Do NOT attempt to run `cloudflared tunnel login` or any command that opens a browser.

---

**CLOUDFLARE TUNNEL SETUP (manual steps)**

These steps create a permanent HTTPS tunnel from `brain.{{DOMAIN}}` to your local MCP server. You need a free Cloudflare account with at least one domain.

**1. Install cloudflared**

```bash
brew install cloudflared
```

**2. Log in to Cloudflare**

Run this command. It will open your browser.

```bash
cloudflared tunnel login
```

- Your browser will open to Cloudflare's dashboard
- You will see a list of your domains -- **click on `{{DOMAIN}}`**
- After clicking, you should see "You have successfully logged in"
- If it says "Failed to write the certificate", check your Downloads folder for `cert.pem` and move it:
  ```bash
  mv ~/Downloads/cert.pem ~/.cloudflared/cert.pem
  ```

**3. Create the tunnel**

```bash
cloudflared tunnel create mybrain
```

This prints a tunnel ID (a UUID like `4caab124-556c-4ca0-...`). **Save this ID.**

**4. Route your subdomain to the tunnel**

```bash
cloudflared tunnel route dns mybrain brain.{{DOMAIN}}
```

**5. Create the tunnel config**

Create the file `~/.cloudflared/config.yml` with this content (replace YOUR_TUNNEL_ID with the UUID from step 3):

```yaml
tunnel: YOUR_TUNNEL_ID
credentials-file: /Users/YOUR_USERNAME/.cloudflared/YOUR_TUNNEL_ID.json

ingress:
  - hostname: brain.{{DOMAIN}}
    service: http://localhost:8787
  - service: http_status:404
```

**6. Test the tunnel manually**

```bash
cloudflared tunnel run mybrain
```

In another terminal, test it:

```bash
curl -s "https://brain.{{DOMAIN}}/sse" -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

You should see a response with `"serverInfo":{"name":"mybrain"}`. Press Ctrl+C in the first terminal to stop.

**7. Make the tunnel run automatically**

Create the file `~/Library/LaunchAgents/com.cloudflare.mybrain.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.cloudflare.mybrain</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/cloudflared</string>
        <string>tunnel</string>
        <string>run</string>
        <string>mybrain</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/mybrain-tunnel.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/mybrain-tunnel.log</string>
</dict>
</plist>
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.cloudflare.mybrain.plist
```

Verify: `tail -5 /tmp/mybrain-tunnel.log` should show "Registered tunnel connection".

**8. Add the connector in Claude Desktop**

- Open Claude Desktop (claude.ai app)
- Go to **Settings** (click your name, bottom left)
- Click **Connectors**
- Click **Add custom connector** (or the **+** button)
- Enter URL: `https://brain.{{DOMAIN}}/sse`
- Click the connector name to see its tools -- you should see 4 tools: `capture_thought`, `search_thoughts`, `browse_thoughts`, `brain_stats`

If it says "no tools available", check `/tmp/mybrain-mcp.log` for errors. The most common issue is the HTTP server not running (Step 6a).

---

After the user confirms the tunnel is working, continue to the summary.

### Step 7: Print Summary

After installation, print:

1. What was installed
2. How to use it
3. How to verify it works

**Example summary:**

```
MyBrain installed successfully.

Components:
  ~/.mybrain/server.mjs       -- MCP server
  ~/.mybrain/node_modules/     -- dependencies
  PostgreSQL database: {{DATABASE_NAME}}
  Claude Code MCP: configured (stdio transport)
  [if Desktop] HTTP server: localhost:8787 (launchd)
  [if Desktop] Cloudflare Tunnel: brain.{{DOMAIN}} -> localhost:8787

Tools available:
  capture_thought   -- Save a thought with optional metadata
  search_thoughts   -- Semantic search across all thoughts
  browse_thoughts   -- List recent thoughts
  brain_stats       -- Get statistics

Try it now:
  "Remember this: I just set up MyBrain"
  "What do I know about MyBrain?"
  "How many thoughts do I have?"
```

## Important Notes

- **Do NOT use `z.record(z.any())` in zod schemas.** Use `z.record(z.string(), z.unknown())` instead. The MCP SDK's zod-compat layer crashes on `z.any()` from zod v4 Classic when serializing tool schemas. This silently breaks tool discovery and Claude shows "no tools available."
- **`onsessioninitialized` is a constructor option**, not a property. Pass it in the `StreamableHTTPServerTransport` constructor options object.
- **`cloudflared service install` creates a broken launchd plist** that is missing `tunnel run mybrain` arguments. Always create the plist manually.
- **PostgreSQL must be running** for the MCP server to work. If the server crashes, check `pg_isready`.
- **OpenRouter credits** are needed for capture and search operations. Browse and stats are free.
- **The server runs in two modes:** `node server.mjs` (stdio, for Claude Code) and `node server.mjs http` (HTTP on port 8787, for Claude Desktop). Both share the same database.

## Placeholder Reference

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `{{DATABASE_NAME}}` | PostgreSQL database name | `mybrain` |
| `{{DATABASE_URL}}` | Full connection string | `postgresql://localhost:5432/mybrain` |
| `{{OPENROUTER_KEY}}` | OpenRouter API key | `sk-or-v1-abc123...` |
| `{{DOMAIN}}` | Cloudflare domain | `sfeir.design` |
| `{{NODE_PATH}}` | Absolute path to node binary | `/opt/homebrew/bin/node` |
| `{{HOME}}` | User's home directory | `/Users/sfeirr` |
