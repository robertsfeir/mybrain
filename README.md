# MyBrain

Personal knowledge base with semantic search for Claude.

Store thoughts, ideas, notes, and context in a local PostgreSQL database with vector embeddings. Search by meaning, not just keywords. Works with **Claude Code CLI** and **Claude Desktop** (claude.ai).

## Quick Start

Point Claude Code at this repo:

```bash
claude plugins add /path/to/mybrain
```

Then say:

```
/mybrain-setup
```

Claude will walk you through setup step by step.

## What It Does

- **4 MCP tools:** capture thoughts, semantic search, browse recent, get stats
- **Local PostgreSQL** with pgvector for storage and vector search
- **OpenRouter** for embedding generation (text-embedding-3-small)
- **Optional Cloudflare Tunnel** for Claude Desktop access via HTTPS

## Requirements

- macOS (Linux support possible but launchd steps need adaptation)
- Node.js 18+
- PostgreSQL with pgvector extension
- OpenRouter API key (https://openrouter.ai)
- Cloudflare account + domain (only if you want Claude Desktop access)

## Architecture

```
Claude Code CLI --stdio--> server.mjs --> PostgreSQL (local)
                                      --> OpenRouter (embeddings)

Claude Desktop --HTTPS--> Cloudflare Tunnel --> server.mjs (HTTP)
                                            --> PostgreSQL (local)
                                            --> OpenRouter (embeddings)
```

## Plugin Structure

```
.claude-plugin/
  plugin.json                 # Plugin manifest
skills/
  mybrain-setup/SKILL.md      # Interactive setup wizard
  mybrain-overview/SKILL.md   # How it works, tools, usage
templates/
  server.mjs                  # MCP server (dual mode: stdio + HTTP)
  package.json                # Node.js dependencies
  schema.sql                  # PostgreSQL schema with pgvector
```

## License

MIT
