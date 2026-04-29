/**
 * Embedding generation + async storage worker (mybrain ADR-0001 Wave 2).
 *
 * Merges atelier-pipeline's provider-abstracted embedding module with
 * mybrain's async storage worker (formerly inline in server.mjs).
 *
 * Public surface:
 *   - getEmbedding(text, embedProviderConfig)
 *       Provider-abstracted, with retry/backoff. Routes through
 *       llm-provider.mjs (ADR-0054). Backward-compat shim accepts a bare
 *       string apiKey -> coerces to OpenRouter openai-compat config.
 *
 *   - probeEmbeddingDim(pool)
 *       Informational schema introspection. Reads the actual `embedding`
 *       column dimension from information_schema and logs it. Never gates
 *       behavior. Lifted from server.mjs unchanged (apart from accepting
 *       `pool` as a parameter rather than closing over a module-level pool).
 *
 *   - startEmbedWorker(pool, embedProviderConfig)
 *       Async storage worker. Polls thoughts WHERE embedding IS NULL,
 *       generates embeddings via provider-abstracted getEmbedding, and
 *       UPDATEs the row. Self-bounded: each row has MAX_ATTEMPTS=5 retries
 *       tracked in an in-memory Map capped at 1000 ids (oldest evicted on
 *       overflow) so permanently-failing rows don't starve the queue.
 *
 *       Configuration via env vars (ported forward from mybrain):
 *         MYBRAIN_WORKER_POLL_MS  poll interval, default 500
 *         MYBRAIN_WORKER_BATCH    rows per tick, default 8
 *
 *       Whether to call this is server.mjs's decision (driven by
 *       MYBRAIN_ASYNC_STORAGE env var) -- this module just exports it.
 *
 * The retry/backoff loop in getEmbedding is the embed-specific layer; the
 * worker's MAX_ATTEMPTS=5 is row-level retry across worker ticks. Both layers
 * cooperate: getEmbedding retries 3x for transient HTTP/network errors
 * within a single tick; the worker counts ticks-with-failure per row and
 * skips after 5.
 */

import pgvector from "pgvector/pg";
import { embed as providerEmbed } from "./llm-provider.mjs";
import { EMBEDDING_MODEL } from "./config.mjs";

// =============================================================================
// Retry Configuration (in-call)
// =============================================================================

const CALL_MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 2000, 4000];

function isRetryable(status) {
  return status >= 500 || status === 429;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Backward-compat: lift a bare apiKey string into a providerConfig
// =============================================================================

function coerceProviderConfig(providerConfigOrApiKey) {
  if (
    providerConfigOrApiKey != null &&
    typeof providerConfigOrApiKey === "object"
  ) {
    return providerConfigOrApiKey;
  }
  // Legacy: string apiKey -> default OpenRouter openai-compat config.
  return {
    family: "openai-compat",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: providerConfigOrApiKey || null,
    model: EMBEDDING_MODEL,
    extraHeaders: {},
  };
}

// =============================================================================
// getEmbedding(text, embedProviderConfig)
// =============================================================================

async function getEmbedding(text, providerConfigOrApiKey) {
  const providerConfig = coerceProviderConfig(providerConfigOrApiKey);
  let lastError;

  for (let attempt = 0; attempt < CALL_MAX_ATTEMPTS; attempt++) {
    try {
      return await providerEmbed(text, providerConfig);
    } catch (err) {
      lastError = err;

      // HTTP errors carry a numeric .status from llm-provider.mjs
      if (typeof err.status === "number") {
        if (!isRetryable(err.status)) {
          throw err;
        }
        if (attempt < CALL_MAX_ATTEMPTS - 1) {
          await sleep(BACKOFF_MS[attempt]);
          continue;
        }
        throw lastError;
      }

      // Network-class errors -- retry up to CALL_MAX_ATTEMPTS
      const isNetworkError =
        err.name === "TypeError" ||
        err.code === "ECONNRESET" ||
        err.code === "ECONNREFUSED" ||
        err.code === "ETIMEDOUT" ||
        err.code === "UND_ERR_CONNECT_TIMEOUT";

      if (isNetworkError && attempt < CALL_MAX_ATTEMPTS - 1) {
        await sleep(BACKOFF_MS[attempt]);
        continue;
      }
      throw lastError;
    }
  }

  throw lastError;
}

// =============================================================================
// probeEmbeddingDim(pool)
// =============================================================================
//
// Reads the actual `embedding` column dimension from information_schema and
// logs it. Informational only -- never gates behavior. pgvector itself raises
// a clear error on dimension mismatch at insert time.

async function probeEmbeddingDim(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT format_type(a.atttypid, a.atttypmod) AS col_type
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'thoughts'
          AND a.attname = 'embedding'
          AND a.attnum > 0
          AND NOT a.attisdropped
        LIMIT 1`
    );
    if (rows.length === 0) {
      console.error("embedding dim: thoughts.embedding column not found (schema not applied?)");
      return;
    }
    const colType = rows[0].col_type; // e.g. "vector(1536)"
    const m = /vector\((\d+)\)/.exec(colType);
    if (m) {
      console.error(`embedding dim: ${m[1]} (detected)`);
    } else {
      console.error(`embedding dim: unparsable column type "${colType}"`);
    }
  } catch (err) {
    console.error(`embedding dim: probe failed (${err.message})`);
  }
}

// =============================================================================
// startEmbedWorker(pool, embedProviderConfig)
// =============================================================================

function startEmbedWorker(pool, embedProviderConfig) {
  const POLL_MS = Number(process.env.MYBRAIN_WORKER_POLL_MS || 500);
  const BATCH = Number(process.env.MYBRAIN_WORKER_BATCH || 8);
  const MAX_ATTEMPTS = 5;
  const FAILED_IDS_CAP = 1000;
  // In-memory attempt tracking: id -> attempt count.
  // Prevents permanently-failing rows (dim mismatch, API error) from being
  // retried every POLL_MS forever and starving the queue. Map preserves
  // insertion order, so eviction of the oldest entry is O(1).
  const failedIds = new Map();
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const { rows } = await pool.query(
        `SELECT id, content FROM thoughts
         WHERE embedding IS NULL
         ORDER BY created_at
         LIMIT $1`,
        [BATCH]
      );
      async function processRow(r) {
        const attempts = failedIds.get(r.id) || 0;
        if (attempts >= MAX_ATTEMPTS) return;
        try {
          const vec = await getEmbedding(r.content, embedProviderConfig);
          await pool.query(
            `UPDATE thoughts SET embedding = $1 WHERE id = $2 AND embedding IS NULL`,
            [pgvector.toSql(vec), r.id]
          );
          if (failedIds.has(r.id)) failedIds.delete(r.id);
        } catch (err) {
          const next = attempts + 1;
          if (!failedIds.has(r.id) && failedIds.size >= FAILED_IDS_CAP) {
            const oldest = failedIds.keys().next().value;
            if (oldest !== undefined) failedIds.delete(oldest);
          }
          failedIds.set(r.id, next);
          if (next >= MAX_ATTEMPTS) {
            console.error(`embed worker: row ${r.id} permanently failed after ${MAX_ATTEMPTS} attempts — skipping (last error: ${err.message})`);
          } else {
            console.error(`embed worker: row ${r.id} failed (attempt ${next}/${MAX_ATTEMPTS}):`, err.message);
          }
        }
      }
      await Promise.allSettled(rows.map(r => processRow(r)));
    } catch (err) {
      console.error("embed worker tick error:", err.message);
    } finally {
      running = false;
    }
  }

  const handle = setInterval(tick, POLL_MS);
  console.error(`embed worker started (poll ${POLL_MS}ms, batch ${BATCH}, max-attempts ${MAX_ATTEMPTS})`);
  return handle;
}

// =============================================================================
// Exports
// =============================================================================

export { getEmbedding, probeEmbeddingDim, startEmbedWorker };
