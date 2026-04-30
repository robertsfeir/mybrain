/**
 * Conflict detection and brain config cache.
 * Depends on: db.mjs (pool passed as parameter), embed.mjs (indirectly, caller provides embedding).
 */

import pgvector from "pgvector/pg";
import { assertLlmContent } from "./llm-response.mjs";
import { chat as providerChat } from "./llm-provider.mjs";

function coerceChatProviderConfig(providerConfigOrApiKey) {
  if (providerConfigOrApiKey != null && typeof providerConfigOrApiKey === "object") {
    return providerConfigOrApiKey;
  }
  return {
    family: "openai-compat",
    baseUrl: "https://openrouter.io/api/v1",
    apiKey: providerConfigOrApiKey || null,
    model: "openai/gpt-4o-mini",
    extraHeaders: {},
  };
}

let brainConfigCache = null;
let brainConfigCacheTime = 0;

async function getBrainConfig(clientOrPool) {
  const now = Date.now();
  if (brainConfigCache && now - brainConfigCacheTime < 10000) return brainConfigCache;
  const result = await clientOrPool.query("SELECT * FROM brain_config WHERE id = 1");
  brainConfigCache = result.rows[0];
  brainConfigCacheTime = now;
  return brainConfigCache;
}

function resetBrainConfigCache() {
  brainConfigCache = null;
  brainConfigCacheTime = 0;
}

async function classifyConflict(thoughtA, thoughtB, providerConfigOrApiKey) {
  try {
    const providerConfig = coerceChatProviderConfig(providerConfigOrApiKey);
    const messages = [{
      role: "user",
      content: `You are a conflict classifier for an institutional memory system. Compare these two thoughts and classify their relationship.\n\nThought A (existing): ${thoughtA}\nThought B (new): ${thoughtB}\n\nClassify as exactly one of: DUPLICATE, CONTRADICTION, COMPLEMENT, SUPERSESSION, or NOVEL\n\nRespond in JSON format:\n{"classification": "...", "confidence": 0.0-1.0, "reasoning": "..."}`,
    }];
    const data = await providerChat(messages, providerConfig, {
      responseFormat: { type: "json_object" },
    });
    return JSON.parse(assertLlmContent(data, 'conflict'));
  } catch (err) {
    console.error("Conflict classification failed:", err.message);
    return null;
  }
}

async function detectConflicts(client, embedding, content, scope, brainConfig, providerConfigOrApiKey) {
  if (!brainConfig.conflict_detection_enabled) return { action: "store" };

  const result = await client.query(
    `SELECT id, content, scope, source_agent
     FROM match_thoughts_scored($1, $2, 5, '{}', $3, false)
     WHERE thought_type IN ('decision', 'preference')`,
    // Single-scope by precondition (ADR-0058 BUG-002)
    [pgvector.toSql(embedding), brainConfig.conflict_candidate_threshold, scope?.[0] || null]
  );

  if (result.rows.length === 0) return { action: "store" };

  const topMatch = result.rows[0];
  const similarity = parseFloat(
    (await client.query(
      `SELECT (1 - (embedding <=> $1))::float AS sim FROM thoughts WHERE id = $2`,
      [pgvector.toSql(embedding), topMatch.id]
    )).rows[0].sim
  );

  if (similarity > brainConfig.conflict_duplicate_threshold) {
    return { action: "merge", existingId: topMatch.id, similarity };
  }

  if (similarity > brainConfig.conflict_candidate_threshold) {
    if (!brainConfig.conflict_llm_enabled) {
      return { action: "store", conflictFlag: true, candidateId: topMatch.id, similarity };
    }
    const classification = await classifyConflict(topMatch.content, content, providerConfigOrApiKey);
    if (!classification) {
      return { action: "store", warning: "Conflict classification failed" };
    }
    return handleClassification(classification, topMatch, scope);
  }

  return { action: "store" };
}

// ADR-0058 BUG-003: defensive normaliser for ltree[] columns surfaced via
// match_thoughts_scored. The pg driver in this project (pg ^8.20.0) returns
// ltree[] as a JS Array of strings — that is the only handled path. A future
// driver regression that flips representation would surface as a TypeError
// (loud) rather than silently returning wrong results. Without this guard,
// .some(...) on a non-array throws TypeError and the CONTRADICTION
// classification silently drops to the conflict branch.
function normalizeLtreeArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  return [];
}

function handleClassification(classification, topMatch, scope) {
  switch (classification.classification) {
    case "DUPLICATE":
      return { action: "merge", existingId: topMatch.id, similarity: 0 };
    case "CONTRADICTION": {
      const sameScope = normalizeLtreeArray(topMatch.scope).some(s => (scope ?? []).includes(s));
      if (sameScope) {
        return { action: "supersede", existingId: topMatch.id, classification };
      }
      return { action: "conflict", existingId: topMatch.id, classification };
    }
    case "SUPERSESSION":
      return { action: "supersede", existingId: topMatch.id, classification };
    case "COMPLEMENT":
    case "NOVEL":
    default:
      return { action: "store", relatedId: topMatch.id, classification };
  }
}

export { classifyConflict, detectConflicts, getBrainConfig, resetBrainConfigCache };
