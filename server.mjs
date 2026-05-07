/**
 * mybrain -- MCP Server Entry Point
 * Personal semantic thought storage and retrieval, plus the 8 protocol tools
 * shared with atelier-brain (mybrain ADR-0001).
 *
 * This is the startup orchestrator. All logic lives in lib/ modules:
 *   config.mjs, db.mjs, embed.mjs, conflict.mjs, tools.mjs,
 *   rest-api.mjs, consolidation.mjs, ttl.mjs, static.mjs,
 *   crash-guards.mjs, hydrate.mjs, llm-provider.mjs, llm-response.mjs
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "http";
import crypto from "crypto";

import { resolveConfig, resolveIdentity, buildProviderConfig } from "./lib/config.mjs";
import { createPool, runMigrations } from "./lib/db.mjs";
import { installCrashGuards } from "./lib/crash-guards.mjs";
import { probeEmbeddingDim, startEmbedWorker } from "./lib/embed.mjs";
import { registerTools } from "./lib/tools.mjs";
import { createRestHandler } from "./lib/rest-api.mjs";
import { handleStaticFile } from "./lib/static.mjs";
import { startConsolidationTimer, stopConsolidationTimer } from "./lib/consolidation.mjs";
import { startTTLTimer, stopTTLTimer } from "./lib/ttl.mjs";

// Guarantee TLS relaxation reaches this process regardless of how it was launched.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED || "0";

// =============================================================================
// Configuration
// =============================================================================

const config = resolveConfig();
if (!config) {
  // No DATABASE_URL — CoWork plugin installed but not yet configured via userConfig.
  // Serve an empty MCP endpoint so the plugin is healthy; tools appear once the user
  // sets database_url in the plugin settings and restarts Claude Code.
  const _mode0 = process.env.MCP_TRANSPORT || process.argv[2] || "stdio";
  if (_mode0 !== "http") {
    await new McpServer({ name: "mybrain", version: "2.3.0" })
      .connect(new StdioServerTransport());
    // stdin keeps the event loop alive; zero tools are served until configured
  } else {
    console.error(
      "mybrain: no DATABASE_URL configured. Set DATABASE_URL or create brain-config.json."
    );
    process.exit(0);
  }
} else {

// Backward-compat: surface OPENROUTER_API_KEY from env into the config so
// pre-ADR-0054 setups (only `openrouter_api_key` configured) keep working.
if (!config.openrouter_api_key && process.env.OPENROUTER_API_KEY) {
  config.openrouter_api_key = process.env.OPENROUTER_API_KEY;
}

const DATABASE_URL = config.database_url;
const API_TOKEN =
  process.env.ATELIER_BRAIN_API_TOKEN ||
  process.env.MYBRAIN_API_TOKEN ||
  null;
const ASYNC_STORAGE = process.env.MYBRAIN_ASYNC_STORAGE === "true";

// =============================================================================
// Provider Config Resolution (ADR-0054)
// =============================================================================

const embedProviderConfig = buildProviderConfig(config, "embed");
const chatProviderConfig = buildProviderConfig(config, "chat");

if (embedProviderConfig.family === "anthropic") {
  console.error(
    "Configuration error: embedding_provider cannot be \"anthropic\" -- " +
    "Anthropic ships no embeddings API. Use openrouter, openai, github-models, " +
    "or local for embedding_provider."
  );
  process.exit(1);
}

if (embedProviderConfig.family !== "local" && !embedProviderConfig.apiKey) {
  console.error(
    `Missing API key for embedding provider "${embedProviderConfig.providerName}". ` +
    "mybrain cannot generate embeddings. Set the appropriate API key in brain-config.json " +
    "or environment, or switch embedding_provider to \"local\"."
  );
  process.exit(1);
}

if (chatProviderConfig.family !== "local" && !chatProviderConfig.apiKey) {
  console.error(
    `Missing API key for chat provider "${chatProviderConfig.providerName}". ` +
    "mybrain cannot run conflict classification or consolidation. Set the appropriate " +
    "API key in brain-config.json or environment, or switch chat_provider to \"local\"."
  );
  process.exit(1);
}

const CAPTURED_BY = resolveIdentity();

// =============================================================================
// Database Pool
// =============================================================================

const pool = createPool(DATABASE_URL);

// =============================================================================
// Process-Level Crash Guards (with embed-worker cleanup closure)
// =============================================================================
//
// Declare the worker handle BEFORE installCrashGuards so the cleanup closure
// captures the variable (not its current `undefined` value). We assign the
// handle below after probeEmbeddingDim + migrations succeed.

let embedWorkerHandle = null;

installCrashGuards({
  exitFn: process.exit.bind(process),
  stopConsolidation: () => {
    stopConsolidationTimer();
    if (embedWorkerHandle) {
      clearInterval(embedWorkerHandle);
      embedWorkerHandle = null;
    }
  },
  stopTTL: stopTTLTimer,
  poolEnd: () => pool.end(),
});

// =============================================================================
// Schema Init + Embed Probe + Background Workers
// =============================================================================

await runMigrations(pool);
await probeEmbeddingDim(pool);
await startTTLTimer(pool).catch((err) =>
  console.error("TTL timer start failed:", err.message)
);
await startConsolidationTimer(pool, {
  embedConfig: embedProviderConfig,
  chatConfig: chatProviderConfig,
}).catch((err) =>
  console.error("Consolidation timer start failed:", err.message)
);

if (ASYNC_STORAGE) {
  embedWorkerHandle = startEmbedWorker(pool, embedProviderConfig);
}

// =============================================================================
// Shared Runtime Config (passed to tool registration + REST handler)
// =============================================================================

const cfg = {
  ...config,
  openrouter_api_key: config.openrouter_api_key || null,
  embedProviderConfig,
  chatProviderConfig,
  brain_name: config.brain_name || "mybrain",
  capturedBy: CAPTURED_BY,
  apiToken: API_TOKEN,
  _source: config._source,
};

// =============================================================================
// Server Startup
// =============================================================================

const mode = process.env.MCP_TRANSPORT || process.argv[2] || "stdio";

if (mode === "http") {
  startHttpMode(pool, cfg);
} else {
  await startStdioMode(pool, cfg);
}

} // end else (config present)

// =============================================================================
// HTTP Mode
// =============================================================================

function startHttpMode(pool, cfg) {
  const PORT = process.env.PORT || 8787;
  const httpSessions = new Map();
  const handleRestApi = createRestHandler(pool, cfg);

  function createSessionTransport() {
    const transport = new StreamableHTTPServerTransport({
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

      // REST API + static UI route ahead of MCP session handling.
      if (req.url.startsWith("/api/")) {
        const handled = await handleRestApi(req, res);
        if (handled) return;
      }
      if (req.url.startsWith("/ui") && req.method === "GET") {
        if (handleStaticFile(req, res, cfg.apiToken)) return;
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
        const mcpServer = new McpServer({ name: "mybrain", version: "2.0.0" });
        registerTools(mcpServer, pool, cfg);
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
    console.error(`mybrain MCP server running on http://localhost:${PORT} (config: ${cfg._source})`);
    if (!cfg.apiToken) {
      console.warn(
        "WARNING: ATELIER_BRAIN_API_TOKEN / MYBRAIN_API_TOKEN not set — REST API running without authentication (dev mode)"
      );
    }
  });
}

// =============================================================================
// Stdio Mode
// =============================================================================

async function startStdioMode(pool, cfg) {
  const server = new McpServer({ name: "mybrain", version: "2.0.0" });
  registerTools(server, pool, cfg);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
