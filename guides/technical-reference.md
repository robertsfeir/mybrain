# MyBrain Technical Reference

Deep reference for the MyBrain MCP server — schema, ingestion pipeline, scoring math, conflict detection, consolidation, TTL enforcement, removal semantics, relations, scope rules, configuration, the LLM provider abstraction, and the full tool surface.

This document describes **what the code actually does** (verified against `lib/` modules and `templates/schema.sql`). Where the spec or README differs from the code, the divergence is called out inline. For a friendly, non-technical tour, see the [User Guide](user-guide.md).

---

## Table of Contents

- [Architecture and Source Layout](#architecture-and-source-layout)
- [Database Schema](#database-schema)
- [Ingestion Pipeline (`agent_capture`)](#ingestion-pipeline-agent_capture)
- [Embedding Subsystem](#embedding-subsystem)
- [Three-Axis Scoring](#three-axis-scoring)
- [Conflict Detection](#conflict-detection)
- [Consolidation Engine](#consolidation-engine)
- [TTL Enforcement](#ttl-enforcement)
- [Removal Semantics](#removal-semantics)
- [Relations and Graph Traversal](#relations-and-graph-traversal)
- [Scope (ltree) Semantics](#scope-ltree-semantics)
- [Configuration](#configuration)
- [LLM Provider Abstraction](#llm-provider-abstraction)
- [MCP Tool Reference](#mcp-tool-reference)
- [REST API](#rest-api)
- [Hydration Pipeline](#hydration-pipeline)
- [Migrations](#migrations)
- [Observed Divergences](#observed-divergences)

---

## Architecture and Source Layout

MyBrain is an MCP server written in Node.js (ESM). It wraps a PostgreSQL database (with `pgvector` and `ltree` extensions) and exposes eight tools over either stdio or Streamable HTTP transport.

```
server.mjs              startup orchestrator (~250 lines): transport + wiring only
lib/
  config.mjs            resolveConfig, buildProviderConfig, identity, enums
  db.mjs                createPool, runMigrations
  crash-guards.mjs      installCrashGuards (signal/error handlers)
  embed.mjs             getEmbedding, probeEmbeddingDim, startEmbedWorker, flushEmbedQueue
  llm-provider.mjs      embed/chat adapters: openai-compat, anthropic, local
  llm-response.mjs      assertLlmContent (LLM response validation)
  conflict.mjs          detectConflicts, classifyConflict, getBrainConfig
  consolidation.mjs     startConsolidationTimer, runConsolidation
  ttl.mjs               startTTLTimer, runTTLEnforcement
  tools.mjs             registerTools (8 protocol tools)
  rest-api.mjs          createRestHandler (Settings UI REST endpoints)
  static.mjs            handleStaticFile (Settings UI asset serving)
  hydrate.mjs           re-exports of scripts/hydrate-telemetry.mjs
migrations/             auto-applied SQL migrations (idempotent)
scripts/                out-of-band utilities (hydrate-telemetry.mjs)
templates/              Docker deployment scaffolding (schema.sql is canonical)
ui/                     Settings UI static assets (currently empty — see Divergences)
tests/brain/            node:test integration tests (require DATABASE_URL)
```

The server runs in two transport modes:

- **stdio** — `node server.mjs` (or no argument). Used by Claude Code's `claude mcp add` registration.
- **HTTP** — `node server.mjs http`. Streamable HTTP transport on `PORT` (default 8787), plus the REST API and `/health`.

`MCP_TRANSPORT` env var overrides `argv[2]`.

---

## Database Schema

The canonical schema is `templates/schema.sql`. It's substituted at scaffold time: `{{EMBED_DIM}}` defaults to 1536 but can be set to 1024 for local 1024-dim models like `mxbai-embed-large`.

### Extensions

- `vector` (pgvector) — embedding storage and cosine-distance operator (`<=>`)
- `ltree` — hierarchical scope paths

### Enums

| Enum | Values |
|---|---|
| `thought_type` | `decision`, `preference`, `lesson`, `rejection`, `drift`, `correction`, `insight`, `reflection`, `handoff`, `pattern`, `seed` |
| `thought_status` | `active`, `superseded`, `invalidated`, `expired`, `conflicted` |
| `relation_type` | `supersedes`, `triggered_by`, `evolves_from`, `contradicts`, `supports`, `synthesized_from` |
| `source_agent` | `eva`, `robert`, `robert-spec`, `sable`, `sable-ux`, `sarah`, `colby`, `agatha`, `ellis`, `poirot`, `distillator`, `sherlock`, `sentinel` |
| `source_phase` | `design`, `build`, `qa`, `review`, `reconciliation`, `setup`, `handoff`, `devops`, `telemetry`, `ci-watch`, `pipeline`, `product`, `ux`, `commit` |

The fresh-install schema **deliberately drops** the legacy `cal` and `roz` source-agent values that exist in migrated v1 databases. Migrated and fresh-install enums are **not isomorphic** on this point.

### `thoughts`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` default |
| `content` | TEXT | The thought text |
| `embedding` | `vector({{EMBED_DIM}})` | Nullable; populated synchronously or by the async worker |
| `metadata` | JSONB | Default `{}`; provenance lives under `metadata.provenance` |
| `thought_type` | `thought_type` | NOT NULL |
| `source_agent` | `source_agent` | NOT NULL |
| `source_phase` | `source_phase` | NOT NULL |
| `importance` | FLOAT | NOT NULL, CHECK 0 ≤ x ≤ 1 |
| `trigger_event` | TEXT | What prompted the capture |
| `captured_by` | TEXT | Resolved from `MYBRAIN_USER` / `ATELIER_BRAIN_USER` / `git config user.name` |
| `origin_pipeline` | TEXT | Pipeline run id (if any) |
| `origin_context` | TEXT | Free-form origin tag |
| `trigger_when` | TEXT | Trigger condition (used by `seed` thoughts) |
| `status` | `thought_status` | Default `active` |
| `scope` | `ltree[]` | Default `ARRAY['default']::ltree[]` |
| `invalidated_at` | TIMESTAMPTZ | Set when status leaves `active` |
| `last_accessed_at` | TIMESTAMPTZ | Default `now()`; updated on every search hit |
| `created_at` | TIMESTAMPTZ | Default `now()` |
| `updated_at` | TIMESTAMPTZ | Trigger-maintained on UPDATE |

Indexes:

- `thoughts_embedding_idx` — HNSW on `embedding vector_cosine_ops`
- `thoughts_metadata_idx` — GIN on `metadata`
- `thoughts_scope_idx` — GIST on `scope`
- B-tree on `status`, `thought_type`, `source_agent`, `created_at DESC`
- Partial index on `invalidated_at` WHERE NOT NULL

### `thought_relations`

Typed edges between thoughts. **Convention:** `source_id` is the newer/derived thought, `target_id` is the older/original.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `source_id` | UUID | FK → thoughts.id ON DELETE CASCADE |
| `target_id` | UUID | FK → thoughts.id ON DELETE CASCADE |
| `relation_type` | `relation_type` | |
| `context` | TEXT | Free-form note explaining the link |
| `created_at` | TIMESTAMPTZ | |
| | | `UNIQUE (source_id, target_id, relation_type)` |

### `thought_type_config`

Lookup table for per-type defaults.

| Column | Type | Notes |
|---|---|---|
| `thought_type` | `thought_type` PK | |
| `default_ttl_days` | INTEGER | NULL = never expires |
| `default_importance` | FLOAT | Default 0.5 |
| `description` | TEXT | |

Seeded values:

| Type | TTL (days) | Importance | Description |
|---|---|---|---|
| decision | NULL | 0.9 | Architectural or product decisions |
| preference | NULL | 1.0 | Human preferences and HALT resolutions |
| lesson | 365 | 0.7 | Retro learnings and patterns |
| rejection | 180 | 0.5 | Alternatives considered and discarded |
| drift | 90 | 0.8 | Spec/UX drift findings |
| correction | 90 | 0.7 | Fixes applied after drift detection |
| insight | 180 | 0.6 | Mid-task discoveries |
| reflection | NULL | 0.85 | Consolidation-generated synthesis |
| handoff | NULL | 0.9 | Structured handoff briefs |
| pattern | 365 | 0.7 | Reusable implementation patterns |
| seed | NULL | 0.5 | Out-of-scope ideas with trigger conditions |

### `brain_config`

Singleton row (CHECK `id = 1`). All knobs:

| Column | Type | Default |
|---|---|---|
| `brain_enabled` | BOOL | false |
| `consolidation_interval_minutes` | INT | 30 |
| `consolidation_min_thoughts` | INT | 3 |
| `consolidation_max_thoughts` | INT | 20 |
| `conflict_detection_enabled` | BOOL | true |
| `conflict_duplicate_threshold` | FLOAT | 0.9 |
| `conflict_candidate_threshold` | FLOAT | 0.7 |
| `conflict_llm_enabled` | BOOL | true |
| `default_scope` | `ltree` | `'default'` |

The config is read with a 10-second in-memory cache (`getBrainConfig` in `lib/conflict.mjs`).

### `schema_migrations`

Tracks applied migrations by version + checksum. Auto-managed by `runMigrations(pool)` at startup.

---

## Ingestion Pipeline (`agent_capture`)

The full flow is in `lib/tools.mjs` (`handleAgentCapture` and helpers).

### Inputs (Zod-validated)

| Param | Required | Notes |
|---|---|---|
| `content` | yes | Min length 1 |
| `thought_type` | yes | Enum |
| `source_agent` | yes | Enum |
| `source_phase` | yes | Enum |
| `importance` | yes | 0–1 float |
| `trigger_event` | no | |
| `supersedes_id` | no | UUID; if present, force-creates a `supersedes` relation |
| `scope` | no | Array of ltree strings; defaults to `["default"]` |
| `metadata` | no | Free-form JSON |
| `decided_by` | no | `{ agent, human_approved }` provenance object |
| `alternatives_rejected` | no | `[{ alternative, reason }]` |
| `evidence` | no | `[{ file, line }]` |
| `confidence` | no | 0–1 float; low values flag for retro review |

### Flow

1. **Single-scope guard (ADR-0058 BUG-002)** — if `thought_type` is `decision` or `preference` and `scope.length > 1`, capture is rejected before opening the transaction. Conflict detection only inspects `scope[0]`, so multi-scope captures of these types would silently lose the safeguard.
2. **`BEGIN`** transaction.
3. **Compute embedding** via `getEmbedding(content, embedConfig)`. Failure → `ROLLBACK` and return error.
4. **Load brain config** (`getBrainConfig`, 10s cached).
5. **Conflict detection** — only for `decision` and `preference` types. See [Conflict Detection](#conflict-detection) below.
6. **Build provenance metadata** — collect `decided_by`, `alternatives_rejected`, `evidence`, `confidence` into `metadata.provenance` if any are present.
7. **Branch on conflict result:**
   - **`merge`** — UPDATE the existing thought (importance = max, content overridden only if new importance is higher, metadata merged via `||`, `last_accessed_at = now()`); COMMIT; return the existing id with `action: "merged"`.
   - **`store` / `supersede` / `conflict`** — INSERT a new thoughts row. Status is `conflicted` if `action === "conflict"`, otherwise `active`.
8. **Create relations:**
   - If `supersedes_id` was passed → `supersedes` relation new→old; old marked `superseded` with `invalidated_at = now()`.
   - If conflict result was `supersede` → same as above with the candidate id.
   - If conflict result was `conflict` → mark candidate `conflicted`; insert `contradicts` relation new→candidate.
   - If conflict result has a `relatedId` (COMPLEMENT/NOVEL classification) → tracked in `related_ids` (no relation row inserted automatically).
9. **`COMMIT`**.
10. **Return** `{ thought_id, created_at, captured_by, conflict_flag, related_ids, warning? }`.

### Error handling

Any error inside the try → `ROLLBACK`, return `isError: true`. The connection is always released in `finally`.

---

## Embedding Subsystem

Defined in `lib/embed.mjs`. Provider-abstracted via `lib/llm-provider.mjs`.

### `getEmbedding(text, providerConfigOrApiKey)`

In-call retry policy:

- **3 attempts** total
- Backoff: `[1000, 2000, 4000]` ms
- Retry on HTTP 429 or ≥ 500
- Retry on network errors (`TypeError`, `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `UND_ERR_CONNECT_TIMEOUT`)
- Non-retryable HTTP statuses (4xx other than 429) throw immediately

Backwards-compat shim: if a bare string is passed instead of a provider config, it's coerced into an OpenRouter openai-compat config with the default model (`openai/text-embedding-3-small`).

### `probeEmbeddingDim(pool)`

Logged-only diagnostic. Reads `format_type(a.atttypid, a.atttypmod)` for `thoughts.embedding` from `pg_attribute` and prints e.g. `embedding dim: 1536 (detected)`. Never gates behavior — pgvector raises a clear error at insert time on dimension mismatch.

### Async storage worker

Enabled by `MYBRAIN_ASYNC_STORAGE=true`. Implemented as `startEmbedWorker(pool, embedProviderConfig)`.

- Polls every `MYBRAIN_WORKER_POLL_MS` ms (default 500)
- Selects up to `MYBRAIN_WORKER_BATCH` rows (default 8) where `embedding IS NULL`, ordered by `created_at`
- Per row: calls `getEmbedding`, runs `UPDATE thoughts SET embedding = $1 WHERE id = $2 AND embedding IS NULL`
- Tracks per-row attempt count in a module-shared `failedIds` Map; **5 attempts** maximum per row
- The Map is capped at 1000 ids; on overflow, the oldest entry is evicted first (Map preserves insertion order)
- A `running` flag prevents concurrent ticks

### `flushEmbedQueue(pool, embedProviderConfig)`

Synchronous drain used by `agent_search` in async-storage mode. Eliminates the capture-then-search race: a thought captured ~500 ms ago may not have been picked up by the background worker yet.

- Outer loop iterates until the queue is empty or every row in the current batch is permanently failed
- Hard cap: 1000 outer iterations (defensive)
- Shares the `failedIds` Map with the background worker — so already-abandoned rows aren't given a fresh 5 retries on every search call

### Single-user assumption

`flushEmbedQueue` assumes no concurrent writer is racing rows in behind it; "drain to empty" is therefore well-defined. If you run multiple writers against the same database, the assumption no longer holds and you may see drains that briefly miss in-flight inserts.

---

## Three-Axis Scoring

Implemented as the SQL function `match_thoughts_scored(query_embedding, similarity_threshold, max_results, metadata_filter, scope_filter, include_invalidated)`.

### Formula

```
score = (3.0 × cosine_similarity)
      + (2.0 × importance)
      + (0.5 × recency_decay)

cosine_similarity = 1 - (embedding <=> query_embedding)
recency_decay     = 0.995 ^ hours_since_last_access
hours             = EXTRACT(EPOCH FROM (now() - COALESCE(last_accessed_at, created_at))) / 3600
```

### Weight rationale

- **Relevance (3.0)** — what you're asking about matters most.
- **Importance (2.0)** — decisions outrank tactical findings.
- **Recency (0.5)** — tiebreaker, not dominant. Old decisions still surface if relevance is high.

### Recency decay characteristics

`0.995^h`:

| Hours | Recency score |
|---|---|
| 0 | 1.000 |
| 24 (1 day) | 0.886 |
| 168 (1 week) | 0.434 |
| 720 (1 month) | 0.0274 |
| 720 × 6 ≈ 138 days | 0.0036 (≈ noise floor) |

Half-life ≈ 138 hours ≈ 5.76 days.

### Filtering

```sql
WHERE
  embedding IS NOT NULL
  AND (1 - (embedding <=> query_embedding)) >= similarity_threshold
  AND (include_invalidated OR status = 'active')
  AND (metadata_filter = '{}' OR metadata @> metadata_filter)
  AND (scope_filter IS NULL OR scope @> ARRAY[scope_filter])
```

Default `similarity_threshold` is 0.2; `max_results` is 10.

### Validation

- `query_embedding` NOT NULL → exception
- `max_results >= 0` → exception otherwise
- `0 <= similarity_threshold <= 1` → exception otherwise

### Touch-on-search

`agent_search` tool (in `lib/tools.mjs`) issues `UPDATE thoughts SET last_accessed_at = now() WHERE id = ANY($ids)` for every returned id. This refreshes the recency clock on hits, so frequently-revisited thoughts feel newer than equally-old, never-revisited siblings.

### Index usage

The HNSW index (`thoughts_embedding_idx`) accelerates the `<=>` operator. Recall depends on the HNSW build parameters (defaults applied at extension level).

---

## Conflict Detection

Implemented in `lib/conflict.mjs`. Runs **only** for `decision` and `preference` thought types, **only** when `brain_config.conflict_detection_enabled` is true.

### Candidate retrieval

```sql
SELECT id, content, scope, source_agent
FROM match_thoughts_scored($embedding, $candidate_threshold, 5, '{}', $scope[0], false)
WHERE thought_type IN ('decision', 'preference')
```

Notes:

- Top **5** candidates above `conflict_candidate_threshold` (default 0.7).
- Filtered to `decision`/`preference` only.
- Scope filter is **`scope[0]` only** — single-scope by ADR-0058 precondition. Multi-scope captures of these types are rejected upstream in `agent_capture`.
- Uses `match_thoughts_scored`, so combined-score ordering applies (most relevant first by combined score, not raw similarity). `topMatch` is the first row.

### Re-fetching exact similarity

The combined-score ordering makes the top match's raw similarity ambiguous, so a second query computes it explicitly:

```sql
SELECT (1 - (embedding <=> $1))::float AS sim FROM thoughts WHERE id = $2
```

This `similarity` value drives the threshold branches.

### Decision tree

| Condition | Action |
|---|---|
| `similarity > conflict_duplicate_threshold` (default 0.9) | **merge** — UPDATE existing |
| `conflict_candidate_threshold < similarity ≤ conflict_duplicate_threshold` AND `conflict_llm_enabled = false` | **store** with `conflictFlag = true` and `candidateId` |
| `conflict_candidate_threshold < similarity ≤ conflict_duplicate_threshold` AND `conflict_llm_enabled = true` | call LLM classifier → see below |
| `similarity ≤ conflict_candidate_threshold` | **store** (no conflict) |

### LLM classifier

Prompts a chat model to classify `(thoughtA, thoughtB)` as `DUPLICATE`, `CONTRADICTION`, `COMPLEMENT`, `SUPERSESSION`, or `NOVEL` and to return JSON. The prompt is verbatim:

```
You are a conflict classifier for an institutional memory system. Compare these two
thoughts and classify their relationship.

Thought A (existing): <existing.content>
Thought B (new): <new.content>

Classify as exactly one of: DUPLICATE, CONTRADICTION, COMPLEMENT, SUPERSESSION, or NOVEL

Respond in JSON format:
{"classification": "...", "confidence": 0.0-1.0, "reasoning": "..."}
```

Response is parsed via `assertLlmContent`. On any error, the result is null and capture proceeds with `{ action: "store", warning: "Conflict classification failed" }`.

### Classification → action map

| Classification | Same scope as candidate? | Action |
|---|---|---|
| `DUPLICATE` | n/a | `merge` |
| `CONTRADICTION` | yes | `supersede` (newer wins) |
| `CONTRADICTION` | no | `conflict` (both flagged, `contradicts` relation) |
| `SUPERSESSION` | n/a | `supersede` |
| `COMPLEMENT` / `NOVEL` / unknown | n/a | `store` with `relatedId` set |

The `sameScope` check uses `normalizeLtreeArray(topMatch.scope).some(s => scope.includes(s))`. The defensive `normalizeLtreeArray` exists because the pg driver currently returns `ltree[]` columns as JS arrays of strings, and a future driver regression that flips representation would surface as a TypeError instead of silently returning wrong results.

### Action effects

| Action | Effect |
|---|---|
| `store` | Insert new row with status `active`. |
| `merge` | UPDATE existing row's importance, content (conditional), metadata; do not insert. |
| `supersede` | Insert new row with status `active`; old row → `superseded` + `invalidated_at = now()`; insert `supersedes` relation new→old. |
| `conflict` | Insert new row with status `conflicted`; old row → `conflicted`; insert `contradicts` relation new→old. |

### Configurability

Knobs live in `brain_config`:

- `conflict_detection_enabled` — global on/off.
- `conflict_duplicate_threshold` — default 0.9. Above this, auto-merge without consulting the LLM.
- `conflict_candidate_threshold` — default 0.7. Below this, no conflict check at all.
- `conflict_llm_enabled` — if false, in the candidate zone we skip the classifier and store with a flag.

---

## Consolidation Engine

Implemented in `lib/consolidation.mjs`. Runs on a timer (default every 30 minutes) once `brain_enabled` is true.

### Candidate selection

The most recent ≤ `consolidation_max_thoughts` (default 20) thoughts that are:

- `status = 'active'`
- `thought_type != 'reflection'`
- not already `synthesized_from` target

```sql
SELECT t.id, t.content, t.thought_type, t.importance
FROM thoughts t
WHERE t.status = 'active'
  AND t.thought_type != 'reflection'
  AND NOT EXISTS (
    SELECT 1 FROM thought_relations r
    WHERE r.target_id = t.id AND r.relation_type = 'synthesized_from'
  )
ORDER BY t.created_at DESC
LIMIT $1
```

If `< consolidation_min_thoughts` (default 3), the run is a no-op.

### Pairwise similarity

Single SQL query against the same candidate set:

```sql
SELECT a.id AS id_a, b.id AS id_b,
  (1 - (a.embedding <=> b.embedding))::float AS similarity
FROM candidates a
JOIN candidates b ON a.id < b.id
WHERE (1 - (a.embedding <=> b.embedding)) > 0.6
```

The similarity floor (`CONSOLIDATION_PAIR_SIMILARITY_FLOOR = 0.6`) is hard-coded.

### Clustering

Union-find on the surviving pairs. For each pair, `union(id_a, id_b)`. Groups (`getClusters`) of size ≥ 3 proceed; smaller groups are dropped.

### Synthesis

For each cluster:

1. Format the cluster contents as a numbered list with `[type]` prefixes.
2. Call the chat provider with:
   ```
   Synthesize these N observations into a single higher-level insight. Preserve specific
   details, decisions, and reasoning. Do not generalize away the useful specifics.
   ```
3. Validate with `assertLlmContent` and embed the synthesis with `getEmbedding`.
4. INSERT the reflection: `thought_type = 'reflection'`, `source_agent = 'eva'`, `source_phase = 'reconciliation'`, `importance = min(1.0, max(cluster.importance) + 0.05)`, `scope = ARRAY['default']::ltree[]`.
5. INSERT a `synthesized_from` relation from reflection → each source thought (idempotent on conflict).

The transaction wraps the INSERT block. LLM/embed errors abort the cluster but don't stop other clusters.

### Source-thought lifecycle

Source thoughts are **not modified**. They remain `active`, retain their importance, and stay searchable. The reflection is purely additive.

### Disabling consolidation

Set `brain_enabled = false` (the default for fresh installs). The timer still ticks, but each tick early-returns. No reflections are produced.

---

## TTL Enforcement

Implemented in `lib/ttl.mjs`. Runs once per hour and once on startup.

### One pass

```sql
UPDATE thoughts t
SET status = 'expired', invalidated_at = now()
FROM thought_type_config ttc
WHERE t.thought_type = ttc.thought_type
  AND ttc.default_ttl_days IS NOT NULL
  AND t.status = 'active'
  AND t.created_at < now() - (ttc.default_ttl_days || ' days')::interval
RETURNING t.id
```

The clock is **`created_at`**, not `last_accessed_at` — accessing a thought refreshes recency-score but does not extend its lifespan. A frequently-searched lesson is still expired at day 365.

### Effects

- Status flips to `expired`. Default search excludes it.
- `invalidated_at` is set so partial indexes pick it up.
- The thought is **not deleted**. Trace traversals and `include_invalidated: true` searches still see it.

### Hard delete

`POST /api/purge-expired` (REST) deletes status=`expired` rows and any orphaned relations:

```sql
DELETE FROM thoughts WHERE status = 'expired';
DELETE FROM thought_relations
WHERE source or target no longer exists in thoughts;
```

This is the only built-in path to permanent deletion. Active, superseded, invalidated, and conflicted thoughts are **never** automatically removed.

---

## Removal Semantics

| Status | How a thought enters this status | Searchable by default? | Hard-deletable via REST? |
|---|---|---|---|
| `active` | Insert | ✅ | ❌ |
| `superseded` | Auto from conflict-detection `supersede`, or manual via `atelier_relation` with `relation_type = 'supersedes'`, or `supersedes_id` on `agent_capture` | ❌ (visible with `include_invalidated`) | ❌ |
| `invalidated` | Manual UPDATE only — no built-in path | ❌ | ❌ |
| `expired` | TTL pass | ❌ | ✅ via `/api/purge-expired` |
| `conflicted` | Cross-scope CONTRADICTION classification | ❌ | ❌ |

Notes:

- The `invalidated` status has no built-in transition path. It exists for manual or future use; today, supersedes/expires/conflicts cover real flows.
- `invalidated_at` is set when status leaves `active`. The partial index on it accelerates filters that exclude invalidated rows.
- Hard deletes cascade through `thought_relations` via `ON DELETE CASCADE`. The orphan-relation cleanup in `/api/purge-expired` handles edge cases where relations reference rows that were deleted by another path.

---

## Relations and Graph Traversal

### Insertion

`atelier_relation` (in `lib/tools.mjs`):

- Self-loop check: `source_id == target_id` → 400.
- For `supersedes`: cycle check via recursive CTE up to depth 20. If a cycle would form, rolled back with "Cycle detected".
- INSERT with `ON CONFLICT (source_id, target_id, relation_type) DO UPDATE SET context = $4` (idempotent, latest context wins).
- For `supersedes`, the target is also UPDATEd to status=`superseded` + `invalidated_at = now()`.

### Traversal — `atelier_trace`

Bidirectional BFS via two recursive CTEs:

- **Backward**: starting from `thought_id`, follow `source_id → target_id` edges (i.e., walk to older thoughts the start thought was derived from).
- **Forward**: starting from `thought_id`, follow `target_id → source_id` edges (walk to newer thoughts that derived from the start).

Each row carries `via_relation` and `via_context` so callers can reconstruct *why* the link exists. Depth is capped by `max_depth` (default 10, max 50).

The traversal is `DISTINCT ON (id)` so a thought reached via multiple paths only appears once, at its shortest depth.

### Superseded-by enrichment

After traversal, a single GROUP BY query collects all the `supersedes` relations targeting any node in the chain:

```sql
SELECT target_id, array_agg(source_id) AS superseded_by
FROM thought_relations
WHERE target_id = ANY($chainIds) AND relation_type = 'supersedes'
GROUP BY target_id
```

Each chain node gets a `superseded_by: [...]` field so callers can see what eventually replaced an old thought without separate queries.

### Provenance projection

The trace response strips raw `metadata` and exposes only `metadata.provenance`. This keeps the response focused on decision evolution rather than incidental tags.

---

## Scope (ltree) Semantics

Every thought has `scope ltree[]` (default `['default']`). Scopes are hierarchical dot-separated paths, e.g. `work.acme.payments.auth`.

### Filter rule

Search uses `scope @> ARRAY[scope_filter]::ltree[]`. The `@>` ltree-array contains operator returns true when the supplied filter is an ancestor of (or equal to) any path in the row's scope. Practical effect: filtering by `work.acme` matches thoughts at `work.acme`, `work.acme.payments`, and deeper.

### Single-scope precondition

Decision and preference captures are restricted to **at most one scope** by `agent_capture`. This is because conflict detection only inspects `scope[0]`; multi-scope captures of these types would silently lose the safeguard on non-first scopes.

Other thought types (lesson, insight, drift, correction, pattern, seed, handoff, reflection, rejection) can carry multiple scopes.

### Default scope

A fresh install seeds `default_scope = 'default'` in `brain_config`. If a capture omits `scope`, `["default"]` is used.

### Label rules

ltree labels accept ASCII letters (case-sensitive), digits, and underscores. Hyphens require **PostgreSQL 16+ / ltree 1.2+**. Older Postgres versions reject hyphenated labels.

---

## Configuration

### Resolution order

Implemented in `lib/config.mjs` (`resolveConfig`):

1. `BRAIN_CONFIG_PROJECT` env var (explicit project path)
2. `./.claude/brain-config.json` (cwd)
3. `BRAIN_CONFIG_USER` env var (explicit user path)
4. `~/.claude/brain-config.json`
5. `DATABASE_URL` / `ATELIER_BRAIN_DATABASE_URL` (bare-env-var path; v1 compatibility)

The first match wins; the `_source` field on the resolved config records which path was used.

### `brain-config.json` shape

A typical config file:

```json
{
  "database_url": "postgresql://user:pass@host:5432/mybrain",
  "embedding_provider": "openrouter",
  "embedding_model": "openai/text-embedding-3-small",
  "embedding_api_key": "sk-or-...",
  "chat_provider": "openrouter",
  "chat_model": "openai/gpt-4o-mini",
  "chat_api_key": "sk-or-...",
  "brain_scope": "work.myproject",
  "brain_name": "Work Brain"
}
```

Per-provider base URLs and extra headers can be set explicitly (`embedding_base_url`, `chat_base_url`, etc.); otherwise they're filled from `PROVIDER_PRESETS`.

### Environment variables

| Var | Purpose |
|---|---|
| `DATABASE_URL` / `ATELIER_BRAIN_DATABASE_URL` | Postgres connection string |
| `OPENROUTER_API_KEY` | Legacy single-provider fallback |
| `ATELIER_BRAIN_API_TOKEN` / `MYBRAIN_API_TOKEN` | REST API auth bearer token |
| `MYBRAIN_ASYNC_STORAGE` | `"true"` to enable async storage worker |
| `MYBRAIN_WORKER_POLL_MS` | Async worker poll interval (default 500) |
| `MYBRAIN_WORKER_BATCH` | Async worker batch size (default 8) |
| `BRAIN_CONFIG_PROJECT` | Explicit project config path |
| `BRAIN_CONFIG_USER` | Explicit user config path |
| `MYBRAIN_USER` / `ATELIER_BRAIN_USER` | Override identity for `captured_by` |
| `PORT` | HTTP server port (default 8787) |
| `MCP_TRANSPORT` | `stdio` or `http` (overrides argv[2]) |

### Identity resolution (`captured_by`)

In order: `MYBRAIN_USER` → `ATELIER_BRAIN_USER` → `git config user.name` → null.

---

## LLM Provider Abstraction

`lib/llm-provider.mjs` exposes two entry points: `embed(text, providerConfig)` and `chat(messages, providerConfig, opts)`. Three adapter families:

| Family | Embeddings | Chat |
|---|---|---|
| `openai-compat` | ✅ | ✅ |
| `anthropic` | ❌ (rejected) | ✅ |
| `local` | ✅ (Ollama-style) | ✅ (Ollama-style) |

### Provider presets (`PROVIDER_PRESETS` in `lib/config.mjs`)

| Provider | Family | Base URL | Embedding model | Chat model |
|---|---|---|---|---|
| `openrouter` | openai-compat | `https://openrouter.ai/api/v1` | `openai/text-embedding-3-small` | `openai/gpt-4o-mini` |
| `openai` | openai-compat | `https://api.openai.com/v1` | `text-embedding-3-small` | `gpt-4o-mini` |
| `github-models` | openai-compat | `https://models.github.ai/inference` | `openai/text-embedding-3-small` | `openai/gpt-4o-mini` |
| `anthropic` | anthropic | (Anthropic API) | — | (per-config) |
| `local` | local | (configurable) | (configurable) | (configurable) |

`github-models` injects extra headers (`Accept: application/vnd.github+json`, `X-GitHub-Api-Version`).

### Override fields

Explicit overrides in `brain-config.json` win over presets:

- `embedding_base_url`, `embedding_model`, `embedding_api_key`, `embedding_extra_headers`
- `chat_base_url`, `chat_model`, `chat_api_key`, `chat_extra_headers`

---

## MCP Tool Reference

All eight tools are registered by `registerTools` in `lib/tools.mjs`.

### `agent_capture`

Store a thought. See [Ingestion Pipeline](#ingestion-pipeline-agent_capture) for the full flow.

**Required:** `content`, `thought_type`, `source_agent`, `source_phase`, `importance`.
**Optional:** `trigger_event`, `supersedes_id`, `scope`, `metadata`, `decided_by`, `alternatives_rejected`, `evidence`, `confidence`.

**Returns:**
```json
{
  "thought_id": "uuid",
  "created_at": "iso8601",
  "captured_by": "string",
  "conflict_flag": false,
  "related_ids": ["uuid", ...],
  "warning": "...optional..."
}
```

For `merge` actions, the `thought_id` is the **existing** thought's id and the response also includes `action: "merged"` and `similarity`.

### `agent_search`

Semantic search with three-axis scoring.

**Inputs:** `query` (required), `threshold` (default 0.2), `limit` (default 10, max 100), `scope`, `include_invalidated` (default false), `filter` (metadata jsonb).

**Behavior:**
- In async-storage mode, runs `flushEmbedQueue` in parallel with the query embedding.
- Calls `match_thoughts_scored` with the supplied parameters.
- UPDATEs `last_accessed_at = now()` for every returned id (touch-on-search).

**Returns:** `{ results: [...] }` with `id, content, metadata, thought_type, source_agent, source_phase, importance, status, scope, captured_by, created_at, similarity, recency_score, combined_score`. Scores are rounded to 4 decimals.

### `atelier_browse`

Paginated listing with structured filters.

**Inputs:** `limit` (1-100, default 20), `offset` (default 0), `status`, `thought_type`, `source_agent`, `captured_by`, `scope`.

**Returns:** `{ thoughts: [...], total, limit, offset }` with rows ordered by `created_at DESC`.

The response is a fully-described row (no embedding) — useful for diagnostics, UI listings, "show me everything by agent X."

### `atelier_stats`

Brain health and aggregate counts.

**Returns:**
```json
{
  "brain_enabled": bool,
  "brain_name": "string",
  "config_source": "...",
  "total": int,
  "active": int,
  "expired": int,
  "invalidated": int,
  "by_type": { "decision": 12, ... },
  "by_status": { "active": 45, ... },
  "by_agent":  { "eva": 30, ... },
  "by_human":  { "robert": 50, ... },
  "consolidation_interval_minutes": 30
}
```

### `atelier_relation`

Create or update a typed edge between two thoughts.

**Inputs:** `source_id` (newer), `target_id` (older), `relation_type` (enum), `context` (optional).

**Behavior:**
- Self-loop → 400.
- For `supersedes`: cycle check (depth 20) → 400 if cycle.
- Idempotent on `(source_id, target_id, relation_type)`; on conflict, `context` is overwritten.
- For `supersedes`: target → status `superseded`, `invalidated_at = now()`.

**Returns:** `{ created: true, source_id, target_id, relation_type }`.

### `atelier_trace`

Walk the relation graph. See [Relations and Graph Traversal](#relations-and-graph-traversal).

**Inputs:** `thought_id`, `direction` (`backward`/`forward`/`both`, default `both`), `max_depth` (0–50, default 10).

**Returns:** `{ chain: [...] }` where each entry includes `id, content, thought_type, source_agent, source_phase, importance, status, scope, captured_by, created_at, depth, via_relation, via_context, direction, provenance, superseded_by`. The root entry has `depth: 0`, `direction: "root"`.

### `atelier_hydrate`

Background-queue ingest of JSONL telemetry from a Claude Code project sessions directory. See [Hydration Pipeline](#hydration-pipeline).

**Inputs:** `session_path` (absolute or `~`-prefixed).

**Returns:** `{ status: "queued", session_path }`. Returns immediately; processing happens via `setImmediate`.

### `atelier_hydrate_status`

Poll the in-memory status map for a previous `atelier_hydrate` call.

**Inputs:** `session_path` (must match the value passed to `atelier_hydrate`; `~` is expanded).

**Returns:**
```json
{
  "status": "idle" | "running" | "completed" | "error",
  "session_path": "...",
  "started_at": "iso8601 | undefined",
  "completed_at": "iso8601 | undefined",
  "files_processed": int,
  "files_skipped": int,
  "thoughts_inserted": int,
  "errors": [string, ...]
}
```

The status map is **per-process and in-memory**. A server restart loses queued status. The hydration itself is idempotent — re-queuing the same path skips already-hydrated files.

---

## REST API

Mounted only when running in HTTP transport mode. Implemented in `lib/rest-api.mjs`. All endpoints require bearer token auth (`Authorization: Bearer <token>`) when `MYBRAIN_API_TOKEN` / `ATELIER_BRAIN_API_TOKEN` is set.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Connection probe + brain summary (count, brain_enabled, brain_name, last/next consolidation timestamps) |
| GET | `/api/config` | Read `brain_config` row |
| PUT | `/api/config` | Update `brain_config` fields |
| GET | `/api/thought-types` | Read `thought_type_config` lookup table |
| PUT | `/api/thought-types/:type` | Update `default_ttl_days`, `default_importance`, `description` for one type |
| POST | `/api/purge-expired` | Hard-delete `status='expired'` rows + orphan relations |
| GET | `/api/stats` | `by_type`, `by_status`, `by_agent`, `by_human` counts |
| GET | `/api/telemetry/scopes` | Distinct telemetry scopes |
| GET | `/api/telemetry/summary` | Telemetry aggregate (cost, duration, tokens) |
| GET | `/api/telemetry/agents` | Per-agent telemetry rollup |
| GET | `/api/telemetry/agent-detail` | Drill-down into one agent's telemetry |

Static file serving (`lib/static.mjs`) is wired but the `ui/` directory in this repo currently contains only a `.gitkeep`. Settings UI assets are expected to be installed separately (see [Observed Divergences](#observed-divergences)).

---

## Hydration Pipeline

Implemented in `scripts/hydrate-telemetry.mjs` and re-exported by `lib/hydrate.mjs`. Triggered via `atelier_hydrate`; the same logic also runs as a standalone CLI script.

### Inputs

A Claude Code project sessions directory, typically `~/.claude/projects/-Users-<you>-<project>`. The path can include `~` and is expanded via `expandHome()`.

### Discovery

Two discovery passes:

- `discoverSubagentFiles(path)` — JSONL files for subagent invocations.
- `discoverEvaFiles(path)` — JSONL files for the orchestrator (Eva).

### Per-file ingestion

For each file:

- `alreadyHydrated(pool, path)` short-circuits on already-processed files (idempotent).
- `parseJsonl` reads the JSONL stream.
- `insertTelemetryThought` inserts a thought row tagged with telemetry metadata (cost, tokens, duration, agent, model, pricing).

### Tier-3 summaries

`generateTier3Summaries(pool, cfg)` runs after per-file ingestion. It produces aggregate insights across the hydrated set (per-pipeline rollups, cost/rework rates, EvoScore inputs).

### State files

`parseStateFiles` and `stateItemAlreadyHydrated` capture pipeline-state items (decisions from `context-brief.md`, etc.) so cross-session preferences land in the brain alongside telemetry.

### Cost computation

`computeCost(usage, pricing)` and `lookupPricing(model)` produce per-row cost figures using the model's published per-token rates.

### Background-queue model

`atelier_hydrate` schedules processing via `setImmediate` and returns immediately. Status is tracked in `hydrateStatusMap` (a `Map<expandedPath, status>`); it survives within a process but is **not persistent** across restarts. Long hydrations should be polled via `atelier_hydrate_status`.

---

## Migrations

Applied automatically by `runMigrations(pool)` at server startup (idempotent, tracked in `schema_migrations`).

| Migration | Purpose |
|---|---|
| `001-mybrain-v1-to-merged.sql` | Atelier-brain merge: adds `captured_by`, `origin_pipeline`, `origin_context`, `trigger_when` columns; expands `thought_type`/`source_agent`/`source_phase`/`relation_type` enums; introduces `thought_relations`. Purely additive. |
| `002-match-thoughts-scored-captured-by.sql` | Adds `captured_by` to the `match_thoughts_scored` return table. |
| `003-brain-config.sql` | Introduces the `brain_config` singleton. |
| `004-thought-type-config.sql` | Introduces the `thought_type_config` lookup. |

Re-running on an already-migrated database is a no-op. v1 databases must run migration 001 before first use of v2 tools — fresh installs apply it automatically.

---

## Observed Divergences

Per Agatha protocol: the code, schema, and shipped behavior match the user-facing description in the User Guide. The following written-vs-actual gaps were observed during this doc pass:

| Divergence | Spec / README says | Code does | Requires |
|---|---|---|---|
| README §"What You Get" lists four legacy tools (`capture_thought`, `search_thoughts`, `browse_thoughts`, `brain_stats`) with cost notes | Four-tool legacy API | Eight-tool protocol API (the legacy four-tool surface is **removed** per the same README's v2.0 Tool Rename note); v1 tool names return "tool not found" | Robert (README rewrite — the v2.0 section already exists; the §"What You Get" and §"Usage Examples" tables are stale legacy-API copy that should be replaced with the eight-tool surface) |
| `CLAUDE.md` source-layout claim: `ui/` contains "Settings UI static assets (HTML/CSS/JS)" | UI assets present in repo | `ui/` contains only `.gitkeep`; static handler exists (`lib/static.mjs`) but has no assets to serve | Robert/Sable (decision: ship UI in repo, vend from a separate package, or remove the static handler wiring until UI is ready) |
| User Guide / Settings section refers to "the Settings UI when it ships" | UI lives in `ui/` | Same as above — UI is not in this repo today | Same as above |
| README's `## How Semantic Search Works` writes the formula as `(3.0 × cosine_similarity) + (2.0 × importance) + (0.5 × recency_decay)` | Equivalent ordering | Schema function `match_thoughts_scored` writes the formula as `(0.5 × recency) + (2.0 × importance) + (3.0 × similarity)` — same arithmetic, different visual ordering | None (the math is identical; flagging only because future readers cross-referencing source may be confused if they expect literal correspondence). |

---

## Where to Next?

- For end-user concepts and friendly walkthroughs, see the [User Guide](user-guide.md).
- Setup walkthroughs and deployment modes (Bundled / Docker / Native / RDS) live in the [README](../README.md).
- The atelier-pipeline's view of MyBrain integration is in `atelier/docs/guide/user-guide.md` (`## The Atelier Brain`) and `atelier/docs/guide/technical-reference.md` (`## Brain Architecture`).
