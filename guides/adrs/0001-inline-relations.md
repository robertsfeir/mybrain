# ADR 0001 — Inline relations on `agent_capture`

**Status:** Accepted
**Date:** 2026-05-11
**Scope:** mybrain MCP server `lib/tools.mjs`

## Context

The dominant brain-capture pattern in practice is "capture a thought + relate
it to an existing thought." Today this requires two MCP round-trips:

1. `agent_capture(...)` — inserts the thought, returns `thought_id`.
2. `atelier_relation(source_id, target_id, relation_type, context)` — inserts the relation.

`agent_capture` already supports one inline relation type via the
`supersedes_id` field; the other five (`triggered_by`, `evolves_from`,
`supports`, `contradicts`, `synthesized_from`) require the follow-up call.

On Ollama-backed installs (where embedding is sub-second) the dominant
per-capture cost is no longer embedding — it is the calling agent's second
planning pass that reasons about which relation to create. A combined
endpoint collapses the common case to one tool call and one planning pass.

## Decision

`agent_capture` accepts an optional `relations` array. Each element targets
an existing thought and declares the relation type and (optional) context:

```json
{
  "content": "...",
  "thought_type": "lesson",
  "source_agent": "colby",
  "source_phase": "qa",
  "importance": 0.6,
  "relations": [
    { "target_id": "<uuid>", "relation_type": "evolves_from", "context": "..." }
  ]
}
```

### Semantics

- **Single transaction.** Relation inserts share the same `BEGIN` / `COMMIT`
  block as the thought insert. Any failure (FK violation against
  `thoughts.id`, supersedes cycle, etc.) rolls back the entire capture —
  the thought row is *not* persisted.
- **Pre-flight target existence check** issues one `SELECT id FROM thoughts
  WHERE id = ANY($targets)` before any relation insert, so a typo in
  `target_id` produces a readable error naming the missing id rather than a
  raw FK constraint message.
- **Cycle check** runs for each `relation_type='supersedes'` entry, using the
  same recursive CTE that `atelier_relation` uses (`checkSupersedeCycle`).
- **Idempotent on `(source_id, target_id, relation_type)`** via
  `ON CONFLICT … DO UPDATE SET context = EXCLUDED.context`, matching
  `atelier_relation` semantics.
- **Supersedes side-effects mirror the existing path**: the target row is
  marked `status = 'superseded'`, `invalidated_at = now()` when the
  relation is `supersedes`.
- **Duplicate (target_id, relation_type) entries within `relations[]` are
  rejected** at the API boundary with an actionable error rather than
  collapsing them silently.

### Precedence with `supersedes_id`

`supersedes_id` and `relations[]` containing a `supersedes` entry are
**rejected as ambiguous**. The error message names both fields and points the
caller at `relations[]` (preferred) or `supersedes_id` (legacy). Rationale:
the two fields could name *different* target ids, and silently letting one
win produces hard-to-debug captures. Errors are cheap; mistaken supersessions
are not.

`supersedes_id` continues to work standalone — no behavior change for any
existing caller.

### Merge case

When conflict detection fires the `merge` path (similarity > 0.9 against an
existing `decision` / `preference`), the new thought is *not* inserted —
the existing row is updated in place. `relations[]` would target the merge
result, not a freshly-inserted thought. To avoid silent data loss, the merge
response now carries `warning: "agent_capture relations[] ignored: capture
was merged into existing thought <uuid>"` when `relations[]` was passed.
Callers that want explicit relations on a merge can call `atelier_relation`
on the returned `thought_id`.

### Backwards compatibility

`relations` is optional with default `[]`. Every pre-existing call signature
(no `relations` field) executes the identical code path with the identical
response shape.

### `atelier_relation` is unchanged

The standalone tool stays available and unmodified. It is still the right
tool when both source and target already exist (neither is being captured).

## Consequences

### Positive

- One round-trip + one planning pass for the dominant capture pattern.
- Schema-enforced validation (`Zod`) catches malformed inline relations
  before any DB work.
- Transactional all-or-nothing semantics make partial-failure invisible to
  the caller — there is no half-written state to clean up.

### Negative

- `agent_capture` surface area grows. The tool description must be updated
  to mention the field; the docs must teach the recommended pattern.
- `handleAgentCapture` gains one more conditional branch (the
  `supersedes_id` + inline `supersedes` ambiguity check).

## Alternatives rejected

1. **Auto-prefer `relations[]` over `supersedes_id` silently.**
   Rejected: silent precedence rules are exactly the bug class the explicit
   error prevents.
2. **Allow inline relations during merge by re-targeting them at the
   merge-result id.** Rejected for this iteration: the merge happens *to*
   an existing thought the caller doesn't necessarily know about, so
   creating relations on its behalf is surprising. Warning + opt-out is
   safer.
3. **Bulk-insert relations via a single `INSERT … VALUES ($1,…),($n,…)`
   statement instead of a per-row loop.** Rejected as premature optimization
   — the per-relation work (cycle check, supersedes status update) makes a
   loop the natural shape, and `relations[]` length is small in practice.
