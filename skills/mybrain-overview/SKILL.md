---
name: mybrain-overview
description: Use when users ask about MyBrain, what it does, how it works, what tools are available, or how to use the personal knowledge base. Covers architecture, tools, and usage.
---

# MyBrain -- Overview

MyBrain is a personal knowledge base with semantic search. It stores thoughts, ideas, notes, and context in a local PostgreSQL database with vector embeddings, making everything searchable by meaning -- not just keywords.

It works as an MCP (Model Context Protocol) server, accessible from:
- **Claude Code CLI** -- via stdio transport
- **Claude Desktop app (claude.ai)** -- via Streamable HTTP transport through a Cloudflare Tunnel

## How It Works

### Storing a thought

1. You say "remember this: ..." to Claude
2. Claude calls `capture_thought` with your text
3. The server sends your text to OpenRouter (`text-embedding-3-small`) which returns a 1536-dimension vector representing the semantic meaning
4. The text, vector, and metadata are stored in PostgreSQL
5. The HNSW index on the embedding column indexes it for fast search

### Searching

1. You ask "what do I know about X?"
2. Claude calls `search_thoughts` with your query
3. The server sends your query to OpenRouter to get its vector
4. PostgreSQL uses cosine distance (`<=>`) to compare your query vector against all stored vectors
5. The HNSW index makes this fast (approximate nearest neighbor, not full scan)
6. Results come back sorted by similarity (1.0 = identical meaning, 0.0 = unrelated)

### What hits OpenRouter (costs money)

- `capture_thought` -- one embedding call per save
- `search_thoughts` -- one embedding call per search

### What stays local (free)

- `browse_thoughts` -- pure SQL, lists recent thoughts
- `brain_stats` -- pure SQL, counts and aggregations

## Tools

| Tool | Description | Uses OpenRouter |
|------|-------------|-----------------|
| `capture_thought` | Save a thought with optional metadata | Yes |
| `search_thoughts` | Semantic search across all thoughts | Yes |
| `browse_thoughts` | List recent thoughts, filter by metadata | No |
| `brain_stats` | Total count, date range, top metadata keys | No |

## Usage Examples

These work in both Claude Code and Claude Desktop:

- "Remember this: Sarah mentioned she wants to start a consulting business"
- "What do I know about Sarah?"
- "Show me my recent thoughts"
- "How many thoughts do I have?"
- "Search for anything about project architecture"
- "Capture thought: The deploy pipeline needs a staging gate before prod"

## Architecture

```
Claude Code CLI ──stdio──> server.mjs ──> PostgreSQL (mybrain)
                                      ──> OpenRouter (embeddings)

Claude Desktop ──HTTPS──> Cloudflare Tunnel ──> server.mjs (HTTP :8787)
                                            ──> PostgreSQL (mybrain)
                                            ──> OpenRouter (embeddings)
```

### Key components

| Component | Purpose |
|-----------|---------|
| `server.mjs` | MCP server -- dual mode: stdio (CLI) or HTTP (Desktop) |
| PostgreSQL + pgvector | Storage + vector similarity search |
| OpenRouter | Embedding generation (text-embedding-3-small, 1536 dims) |
| Cloudflare Tunnel | HTTPS proxy so Claude Desktop can reach localhost |
| launchd agents | Keep the HTTP server and tunnel running in the background |

## State

All data lives in the `thoughts` table in your local PostgreSQL `mybrain` database. There is no cloud dependency for storage -- OpenRouter is only used for generating embeddings.

The database has:
- **HNSW index** on embeddings for fast vector search
- **GIN index** on metadata for fast JSON filtering
- **B-tree index** on created_at for fast chronological browsing
- **Auto-updating** `updated_at` trigger
