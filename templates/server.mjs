import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import pg from "pg";
import pgvector from "pgvector/pg";
import { createServer } from "http";
import crypto from "crypto";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://localhost:5432/mybrain";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const EMBEDDING_PROVIDER = process.env.EMBEDDING_PROVIDER || "openrouter"; // "openrouter" | "ollama"
const BRAIN_SCOPE = process.env.BRAIN_SCOPE;

const pool = new pg.Pool({ connectionString: DATABASE_URL });

pool.on("connect", async (client) => {
  await pgvector.registerTypes(client);
});

async function getEmbedding(text) {
  let url, headers, body;
  if (EMBEDDING_PROVIDER === "ollama") {
    url = `${OLLAMA_HOST}/v1/embeddings`;
    headers = { "Content-Type": "application/json" };
    body = { model: "mxbai-embed-large", input: text };
  } else {
    url = "https://openrouter.ai/api/v1/embeddings";
    headers = { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" };
    body = { model: "openai/text-embedding-3-small", input: text, dimensions: 1024 };
  }
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Embedding API error: ${res.status} ${err}`);
  }
  const data = await res.json();
  return data.data[0].embedding;
}

function registerTools(srv) {
  srv.tool(
    "capture_thought",
    "Save a new thought, idea, note, or piece of information to the brain.",
    {
      content: z.string().describe("The thought content to save"),
      metadata: z.record(z.string(), z.unknown()).optional().describe("Optional metadata tags"),
    },
    async ({ content, metadata = {} }) => {
      const scopeArray = BRAIN_SCOPE ? [BRAIN_SCOPE] : ["default"];
      const embedding = await getEmbedding(content);
      const result = await pool.query(
        `INSERT INTO thoughts (content, embedding, metadata, scope, thought_type, source_agent, source_phase, importance)
         VALUES ($1, $2, $3, $4::ltree[], 'insight', 'robert', 'build', 0.5)
         RETURNING id, created_at`,
        [content, pgvector.toSql(embedding), JSON.stringify(metadata), `{${scopeArray.join(",")}}`]
      );
      const row = result.rows[0];
      return { content: [{ type: "text", text: `Thought captured (id: ${row.id}, created: ${row.created_at})` }] };
    }
  );

  srv.tool(
    "search_thoughts",
    "Search for thoughts using natural language semantic search.",
    {
      query: z.string().describe("Natural language search query"),
      threshold: z.number().optional().default(0.2).describe("Minimum similarity (0-1)"),
      limit: z.number().optional().default(10).describe("Max results"),
      filter: z.record(z.string(), z.unknown()).optional().describe("Optional metadata filter"),
    },
    async ({ query, threshold = 0.5, limit = 10, filter = {} }) => {
      const embedding = await getEmbedding(query);
      const result = await pool.query(
        `SELECT * FROM match_thoughts_scored($1, $2, $3, $4, $5, false)`,
        [pgvector.toSql(embedding), threshold, limit, JSON.stringify(filter), BRAIN_SCOPE || null]
      );
      if (result.rows.length === 0) return { content: [{ type: "text", text: "No matching thoughts found." }] };
      const formatted = result.rows
        .map((r) => `[${r.similarity.toFixed(3)}] (${new Date(r.created_at).toLocaleDateString()}) ${r.content}` +
          (Object.keys(r.metadata || {}).length > 0 ? `\n  metadata: ${JSON.stringify(r.metadata)}` : ""))
        .join("\n\n");
      return { content: [{ type: "text", text: formatted }] };
    }
  );

  srv.tool(
    "browse_thoughts",
    "Browse recent thoughts with optional filtering.",
    {
      limit: z.number().optional().default(20).describe("Number of thoughts"),
      offset: z.number().optional().default(0).describe("Offset for pagination"),
      filter: z.record(z.string(), z.unknown()).optional().describe("Optional metadata filter"),
    },
    async ({ limit = 20, offset = 0, filter = {} }) => {
      const conditions = [];
      const params = [limit, offset];
      let paramIdx = 3;
      if (BRAIN_SCOPE) { conditions.push(`scope @> ARRAY[$${paramIdx++}]::ltree[]`); params.push(BRAIN_SCOPE); }
      if (Object.keys(filter).length > 0) { conditions.push(`metadata @> $${paramIdx++}`); params.push(JSON.stringify(filter)); }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const result = await pool.query(
        `SELECT id, content, metadata, created_at FROM thoughts ${where} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        params
      );
      if (result.rows.length === 0) return { content: [{ type: "text", text: "No thoughts found." }] };
      const formatted = result.rows
        .map((r) => `(${new Date(r.created_at).toLocaleDateString()}) ${r.content}` +
          (Object.keys(r.metadata || {}).length > 0 ? `\n  metadata: ${JSON.stringify(r.metadata)}` : ""))
        .join("\n\n");
      return { content: [{ type: "text", text: formatted }] };
    }
  );

  srv.tool(
    "brain_stats",
    "Get statistics about stored thoughts.",
    {},
    async () => {
      const scopeFilter = BRAIN_SCOPE ? `WHERE scope @> ARRAY[$1]::ltree[]` : "";
      const scopeParams = BRAIN_SCOPE ? [BRAIN_SCOPE] : [];
      const countRes = await pool.query(`SELECT count(*) as total FROM thoughts ${scopeFilter}`, scopeParams);
      const dateRes = await pool.query(`SELECT min(created_at) as earliest, max(created_at) as latest FROM thoughts ${scopeFilter}`, scopeParams);
      const metaRes = await pool.query(`SELECT key, count(*) as cnt FROM thoughts, jsonb_each(metadata) AS kv(key, value) ${scopeFilter} GROUP BY key ORDER BY cnt DESC LIMIT 10`, scopeParams);
      const total = countRes.rows[0].total;
      const earliest = dateRes.rows[0].earliest;
      const latest = dateRes.rows[0].latest;
      const topKeys = metaRes.rows.map((r) => `${r.key}: ${r.cnt}`).join(", ");
      let text = `Total thoughts: ${total}`;
      if (earliest) text += `\nDate range: ${new Date(earliest).toLocaleDateString()} — ${new Date(latest).toLocaleDateString()}`;
      if (topKeys) text += `\nTop metadata keys: ${topKeys}`;
      return { content: [{ type: "text", text }] };
    }
  );
}

const mode = process.env.MCP_TRANSPORT || process.argv[2] || "stdio";

if (mode === "http") {
  const PORT = process.env.PORT || 8787;
  const httpSessions = new Map();

  function createSessionTransport() {
    let transport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId) => {
        console.log(`  session initialized: ${sessionId}`);
        httpSessions.set(sessionId, transport);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        console.log(`  session closed: ${transport.sessionId}`);
        httpSessions.delete(transport.sessionId);
      }
    };

    return transport;
  }

  const httpServer = createServer(async (req, res) => {
    try {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      console.log(`${req.method} ${req.url} session=${req.headers["mcp-session-id"] || "none"}`);

      const sessionId = req.headers["mcp-session-id"];

      if (sessionId && httpSessions.has(sessionId)) {
        console.log(`  -> existing session`);
        await httpSessions.get(sessionId).handleRequest(req, res);
        return;
      }

      if (sessionId && !httpSessions.has(sessionId)) {
        console.log(`  -> session expired`);
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Session not found" }, id: null }));
        return;
      }

      if (req.method === "POST") {
        const transport = createSessionTransport();
        const mcpServer = new McpServer({ name: "mybrain", version: "1.0.0" });
        registerTools(mcpServer);
        await mcpServer.connect(transport);
        console.log(`  -> new session, handling initialize`);
        await transport.handleRequest(req, res);
        return;
      }

      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
    } catch (err) {
      console.error("Request error:", err.message);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  });

  httpServer.listen(PORT, () => {
    console.log(`mybrain MCP server running on http://localhost:${PORT}`);
  });
} else {
  const server = new McpServer({ name: "mybrain", version: "1.0.0" });
  registerTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
