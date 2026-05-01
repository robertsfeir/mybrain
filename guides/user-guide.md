# MyBrain User Guide

A friendly tour of what MyBrain is, what it remembers, how it finds things again, and why some memories fade while others stay forever.

This guide is written for **people using MyBrain** — through Claude Code, Claude Desktop, Cursor, or any MCP-aware client. There is no SQL or code in here. If you want the deep technical version, head to the [Technical Reference](technical-reference.md).

---

## Table of Contents

- [What MyBrain Is (and Isn't)](#what-mybrain-is-and-isnt)
- [The Mental Model: Thoughts](#the-mental-model-thoughts)
- [How a Thought Gets In](#how-a-thought-gets-in)
- [How Thoughts Come Back Out](#how-thoughts-come-back-out)
- [Why MyBrain Picks the Right Memory](#why-mybrain-picks-the-right-memory)
- [How Memories Fade](#how-memories-fade)
- [Spotting Duplicates and Contradictions](#spotting-duplicates-and-contradictions)
- [Reflections: Many Notes Become One Insight](#reflections-many-notes-become-one-insight)
- [Scopes: Keeping Personal and Project Memory Separate](#scopes-keeping-personal-and-project-memory-separate)
- [Linking Thoughts Together](#linking-thoughts-together)
- [Removing Things You Don't Want Anymore](#removing-things-you-dont-want-anymore)
- [The Eight Tools (At a Glance)](#the-eight-tools-at-a-glance)
- [Common Questions](#common-questions)

---

## What MyBrain Is (and Isn't)

MyBrain is a **personal long-term memory** that lives next to your assistant. When you tell Claude something worth remembering — a decision you made, a preference, a lesson learned, a pattern you spotted — Claude can save it into MyBrain. Later, when you ask a related question, Claude searches MyBrain in plain English and pulls up what you said before.

Think of it as a notebook that Claude takes notes in for you, and that Claude can re-read in seconds whenever it needs to remember something. The notebook lives in **your own database**, on **your own computer or cloud**. Nothing is sent to anyone you haven't configured.

**MyBrain is good at:**

- Remembering decisions you've made and the reasoning behind them
- Surfacing the right memory when you ask a related question — even if your wording is different from what you originally said
- Letting older, less-important notes drift to the background so you aren't drowning in old context
- Noticing when you tell it something that contradicts a prior decision, so you can resolve it deliberately

**MyBrain is not:**

- A chat history. It does not store every word you say to Claude — only the things Claude (or you) explicitly captured.
- A live stream of your project files. It stores text snippets and metadata, not your code.
- A search engine for the open web. It searches what you put into it, nothing else.

---

## The Mental Model: Thoughts

Everything inside MyBrain is a **thought**. A thought is a short piece of text plus some labels that describe what it's about. The labels matter — they tell MyBrain how to score, surface, and eventually retire the thought.

Every thought has:

| Field | Meaning |
|---|---|
| **Content** | The actual text you saved. One or two sentences is ideal. |
| **Type** | What kind of thought is this? Decision? Lesson? Preference? See the [type table](#thought-types) below. |
| **Importance** | A number from 0 to 1. The higher, the more it should outrank lesser thoughts in search results. |
| **Status** | Active, superseded, expired, invalidated, or conflicted. Active thoughts show up in search; the others are kept for history. |
| **Scope** | A label like `personal` or `work.acme.api` that says where this thought belongs. |
| **Captured by** | Who saved this thought. Resolved automatically from your git config or an env var. |
| **Created at / last accessed** | Timestamps MyBrain uses to make older notes feel a little quieter. |

### Thought types

MyBrain ships with eleven thought types. Each one has a sensible default lifespan and a default importance, so a casual note doesn't crowd out an architectural decision.

| Type | What it's for | Default importance | Default lifespan |
|---|---|---|---|
| **decision** | Architectural or product decisions you want to remember forever. | 0.9 | Never expires |
| **preference** | Your personal preferences and resolutions ("no modals", "use trunk-based"). | 1.0 | Never expires |
| **lesson** | Things you learned the hard way. | 0.7 | One year |
| **rejection** | Alternatives you considered and rejected. Useful so you don't reconsider them. | 0.5 | Six months |
| **drift** | A spec or doc has drifted from reality. | 0.8 | Three months |
| **correction** | A fix you applied after spotting drift. | 0.7 | Three months |
| **insight** | A mid-task discovery that's worth holding on to. | 0.6 | Six months |
| **reflection** | A higher-level synthesis MyBrain wrote itself by clustering related notes. | 0.85 | Never expires |
| **handoff** | A structured handoff brief — the summary a teammate would need to pick up where you left off. | 0.9 | Never expires |
| **pattern** | A reusable implementation pattern. | 0.7 | One year |
| **seed** | An out-of-scope idea you don't want to lose. | 0.5 | Never expires |

The lifespans and importance values are starting points. You can tune them in the Settings UI (when it ships) or by editing the `thought_type_config` table.

### Status

A thought is in exactly one of five states:

- **active** — alive, searchable, eligible for everything.
- **superseded** — a newer thought has replaced this one. The old thought is still there for the historical record, just not in default search results.
- **expired** — its lifespan ran out. Same idea: kept for history, hidden from default search.
- **invalidated** — it's no longer true and you (or MyBrain) marked it that way.
- **conflicted** — MyBrain found another thought that contradicts this one across scopes. Both stay alive but flagged so you can decide.

**Default search returns active only.** You can ask Claude for "all my thoughts including the old ones" if you want to see everything.

---

## How a Thought Gets In

You don't open a form. You don't fill in fields. You just talk to Claude.

```
> Remember this: we're using trunk-based branching for this repo, no long-lived feature branches.
```

Claude figures out the type (this is a `preference`), picks an importance, attaches your name, and saves it. From then on, anyone searching their brain for "branching strategy" or "feature branches" — even with totally different wording — will find it.

Behind the scenes, MyBrain does a few things to make sure your save is clean:

1. **It computes an embedding.** This is a long list of numbers that captures the *meaning* of your sentence, so MyBrain can later find it by meaning rather than keywords.
2. **It checks for duplicates.** If you've said something nearly identical before, MyBrain *merges* the new note into the existing one instead of creating a second copy. (See [Spotting Duplicates and Contradictions](#spotting-duplicates-and-contradictions).)
3. **It checks for contradictions.** If you've said the opposite before, MyBrain flags the conflict so you can resolve it deliberately.
4. **It writes it down.** The thought lands in your database with all its labels.

If your embedding provider is briefly slow or unreachable, MyBrain retries up to three times with growing delays before giving up. If you've turned on **async storage** (more on that below), the thought is saved instantly and the embedding is computed in the background.

### Async storage mode (optional)

Computing the embedding takes a moment — usually under a second with a cloud provider, sometimes longer with a local model. If you'd rather your `agent_capture` calls return instantly, you can enable async mode (`MYBRAIN_ASYNC_STORAGE=true`). In that mode:

- Capture returns in a few milliseconds. Your thought is in the database immediately, just without its embedding yet.
- A background worker scans for thoughts missing embeddings every half-second and fills them in.
- The very next time you search, MyBrain quickly finishes any pending embeddings before running your query — so a thought you captured a moment ago is searchable right away.

Either mode works fine. Async is nice when your embedding provider is the slow part of the loop.

---

## How Thoughts Come Back Out

When you ask Claude something like:

```
> What did I decide about authentication on the payments app?
```

…Claude turns your question into the same kind of meaning-vector and asks MyBrain "show me the most relevant active thoughts." MyBrain returns a ranked list, and Claude weaves those memories into its answer.

You can also browse directly:

```
> Show me my recent decisions.
> List all my preferences.
> How many thoughts do I have right now?
```

Claude will pick the right tool — `agent_search` for meaning-based queries, `atelier_browse` for filtered listings, `atelier_stats` for counts and health.

### Touching a thought makes it feel current

Every time a thought shows up in a search result, MyBrain quietly stamps it with "you were just looked at." That stamp affects the recency portion of the score — frequently-revisited thoughts feel newer than thoughts you haven't touched in months, even if they were captured at the same time.

This means **thoughts you actually use stay sharp**. Ones you never look at slide gently into the background.

---

## Why MyBrain Picks the Right Memory

When you search, MyBrain gives every candidate thought a single combined score and returns the top results sorted by that score. The score is a balance of three things:

```
score = (3.0 × relevance) + (2.0 × importance) + (0.5 × recency)
```

In plain English:

- **Relevance** (weight 3.0) — how close your question is to the thought, in meaning. This is the biggest factor. If you ask about Postgres and the thought is about Postgres, that's where the score comes from.
- **Importance** (weight 2.0) — how big a deal the thought is. A `decision` (default 0.9) outranks a `rejection` (default 0.5) when both are equally relevant. So the architectural reason wins over the casual aside.
- **Recency** (weight 0.5) — a small nudge that lifts thoughts you've recently touched and slowly dims thoughts you haven't. Recency decays gradually: a thought halves in recency-score about every six days. It's a tiebreaker, not a dominant force, so important old decisions still surface.

Then MyBrain filters out anything below the **similarity threshold** (0.2 by default) — so totally unrelated thoughts don't sneak in just because they're recent and important. You can lower or raise the threshold per query if you want broader or stricter results.

By default you only see **active** thoughts. If you want to dig through historical context (superseded decisions, expired lessons, invalidated notes), Claude can include them on request.

### What "relevance" really means

MyBrain doesn't match keywords. When you save *"we use trunk-based branching with no long-lived feature branches,"* a question like *"how do we handle release branches?"* will surface that thought even though none of your words match. The two sentences are about the same topic in meaning-space, and that's what MyBrain compares.

Side effect: very short or very generic captures (`"yes"`, `"do this"`) are hard to surface. Save full sentences with enough context that their meaning stands on its own.

---

## How Memories Fade

MyBrain has two gentle ways of letting old material recede.

### Lifespans (TTL)

Each thought type has a default lifespan. Once a thought is older than its type's lifespan, MyBrain marks it **expired**. Expired thoughts are not deleted — they're hidden from default search and kept for the historical record. You can always ask Claude to include them.

| Type | Default lifespan |
|---|---|
| decision, preference | Never expires |
| handoff, reflection, seed | Never expires |
| lesson, pattern | One year |
| insight, rejection | Six months |
| drift, correction | Three months |

A background job runs **once an hour** to expire anything past its lifespan. You don't have to do anything; it just happens.

If a default lifespan doesn't match how your team works, you can tune any type's lifespan in the Settings UI or directly in the `thought_type_config` table.

### Recency decay

Recency doesn't expire anything — it just gradually quiets thoughts you don't revisit. The math is a slow exponential:

- After **a day** of not being touched, a thought's recency score is ~0.89
- After **a week**, ~0.44
- After **a month**, ~0.0036

Recency only carries a weight of 0.5 in the combined score (relevance and importance carry much more), so a year-old `decision` with high relevance still beats a recent low-relevance note. Recency is a tiebreaker for similar candidates, not an eraser.

The recency clock resets every time a thought is returned in a search result. Thoughts you actually use stay fresh. Thoughts you don't drift quietly into the background.

---

## Spotting Duplicates and Contradictions

MyBrain only runs duplicate and contradiction checks for **decisions** and **preferences** — the two types you most want to keep clean. Everything else is allowed to repeat.

When you save a decision or preference, MyBrain checks the active thoughts in the same scope for anything semantically close. There are three zones:

### 1. Very close — looks like a duplicate (similarity > 0.9)

MyBrain merges the new note into the existing one. Specifically:
- The existing thought's importance is bumped to the higher of the two
- Any new metadata fields are merged in
- The content is updated only if the new importance is higher
- Its `last_accessed_at` is refreshed

You don't end up with two near-identical decisions. You end up with one cleaner one.

### 2. Sort of close — could be a contradiction (similarity 0.7 to 0.9)

This is the interesting zone. MyBrain calls a small LLM to classify the relationship:

- **DUPLICATE** → merge, same as above
- **SUPERSESSION** → the new thought replaces the old one. The old thought is marked `superseded` (kept but not searched) and a `supersedes` link is created from new to old.
- **CONTRADICTION** within the same scope → same as supersession (newer wins).
- **CONTRADICTION** across different scopes → both stay active, both are flagged `conflicted`, and a `contradicts` link is recorded between them. You decide what to do.
- **COMPLEMENT** or **NOVEL** → store the new thought normally, but record a relation to the candidate so you can see it was related.

If the LLM classifier is unavailable, MyBrain stores the new thought with a `conflictFlag` so you can review the candidate later. It never blocks your save — conflict detection is a flag, not a gate.

### 3. Not very close (similarity < 0.7)

Stored normally. No conflict check.

You can turn the LLM classifier on or off in the brain config. You can also raise or lower the duplicate and candidate thresholds if you want stricter or looser detection.

---

## Reflections: Many Notes Become One Insight

Every 30 minutes (configurable), MyBrain looks at your **active, recent thoughts** that haven't already been synthesized and asks: *do any of these cluster together?*

Here's how it works in spirit:

1. Take the most recent ~20 active, non-reflection thoughts.
2. Compute the pairwise similarity between every pair.
3. Group thoughts that are pairwise similar into clusters (anything with three or more members counts).
4. For each cluster, ask an LLM to write one higher-level insight that preserves the specific details — not a generalization.
5. Save that insight as a new **reflection** thought. Importance is set just above the highest-importance member of the cluster (capped at 1.0).
6. Link the reflection back to its source thoughts via a `synthesized_from` relation.

The original notes are **not deleted, hidden, or modified**. They stay searchable. The reflection is an *additional* thought that summarizes them.

The result: as you accumulate dozens of small drift findings, lessons, and corrections, MyBrain quietly produces synthesis layers above them. When you search broadly, the higher-level reflection rises to the top. When you search narrowly, you can still hit the original details.

You can disable consolidation entirely by turning off `brain_enabled`, or tune how often it runs and how big the cluster window is.

---

## Scopes: Keeping Personal and Project Memory Separate

A **scope** is a label like `personal`, `work.acme`, or `work.acme.payments.auth`. Every thought has at least one scope. The default is `default`.

Scopes are hierarchical. `work.acme.payments` is *inside* `work.acme`, which is *inside* `work`. When you search for `work`, you'll see thoughts at any sub-scope of `work`. When you search for `work.acme.payments`, you'll only see thoughts at that level or deeper.

A few practical patterns:

- **One brain, multiple projects** — give each project its own scope (`work.acme`, `work.beta`, `personal`). Each project's agents only see what's at or below their scope. No cross-talk.
- **Cross-project lessons** — capture lessons at a higher scope (`work`) so they're visible across all your work projects.
- **Personal vs work** — keep personal preferences at `personal` and work preferences at `work` (or finer). Searches stay focused on what you're working on.

Decisions and preferences are required to have **exactly one scope** — this keeps conflict detection unambiguous. Every other thought type can have multiple scopes if it spans areas.

Scope labels accept ASCII letters, digits, underscores, and hyphens (hyphens require Postgres 16 or newer).

---

## Linking Thoughts Together

Sometimes two thoughts are related and you want to record *how*. MyBrain has six relation types:

| Relation | Meaning |
|---|---|
| `supersedes` | This thought replaces another. The replaced thought is marked superseded automatically. |
| `evolves_from` | This thought is a refinement of another. Both stay active. |
| `triggered_by` | This thought was prompted by another. |
| `contradicts` | These two thoughts say opposite things. Used for cross-scope conflicts. |
| `supports` | This thought reinforces another. |
| `synthesized_from` | This thought (a reflection) was derived from a cluster of others. Created automatically by consolidation. |

You can ask Claude to **trace** the chain forward and backward from any thought:

```
> Show me everything that led to this decision and what came after it.
```

That walks the relation graph and returns the chain ordered by depth, with the relation type and any context recorded on each link.

Tracing is great for understanding *why* something is the way it is — especially after months of evolution.

---

## Removing Things You Don't Want Anymore

There are two kinds of removal: soft and hard.

### Soft removal (kept for history)

Most "removals" in MyBrain are soft. The thought stays in the database but its status changes:

- **superseded** — a newer thought replaced this. Created automatically by conflict detection or by an explicit `supersedes` relation.
- **invalidated** — manually marked as no longer true.
- **expired** — its lifespan ran out (TTL).
- **conflicted** — flagged for cross-scope contradiction; you should resolve it.

None of these statuses appear in default search. They're kept so you can trace history, see what evolved, and answer "what did we used to think?" questions.

### Hard removal (actually deleted)

Hard delete is rare and intentional. It's done through the Settings UI or the REST API:

- **Purge expired** — this permanently deletes every thought with status `expired` and any orphaned relation rows. Useful if you want to keep your database lean and you don't care about expired history.

Active, superseded, invalidated, and conflicted thoughts are **never** automatically deleted. If you want to hard-delete one of those, you do it manually through your database — and the recommended path is to invalidate first, see how things go, then delete only when you're sure.

---

## The Eight Tools (At a Glance)

You usually never call these by name. Claude picks the right one based on what you ask. But it's helpful to know they exist:

| Tool | When Claude reaches for it |
|---|---|
| **agent_capture** | You said something worth remembering. |
| **agent_search** | You asked a question that needs a meaning-based search across your brain. |
| **atelier_browse** | You asked for a filtered list ("show me my preferences", "what's expired?"). |
| **atelier_stats** | You asked how the brain is doing — totals, breakdowns, health. |
| **atelier_relation** | You're explicitly linking two thoughts ("this supersedes that"). |
| **atelier_trace** | You want the history forward and backward from a specific thought. |
| **atelier_hydrate** | You're importing telemetry from a Claude Code project's session files. |
| **atelier_hydrate_status** | You started a hydration and want to know if it's done. |

Hydration is mostly an atelier-pipeline / Darwin / dashboard feature. Day-to-day use is `capture` and `search`.

---

## Common Questions

**Where does my data live?**
In your own PostgreSQL database. Locally inside a Docker volume (Bundled mode), in a container next to MyBrain (Docker mode), on your laptop directly (Native mode), or on a shared Postgres you control (RDS mode). Nothing leaves that database except the embedding text you send to your configured provider.

**What gets sent to the embedding provider?**
The text of the thought you're saving (or the text of the search you're running) is sent to whichever embedding provider you've configured — OpenRouter, OpenAI, GitHub Models, or a local Ollama. If you use local Ollama (the default in Bundled and Native modes), nothing leaves your machine.

**What gets sent to the chat (LLM) provider?**
Two things, only when needed: the conflict classifier (when a decision/preference is in the candidate zone) and the consolidation synthesizer (when a cluster of related thoughts forms). You can turn either off in the brain config.

**Can I just turn the brain off?**
Yes. Set `brain_enabled` to false in the brain config. The MCP tools still respond, but consolidation and conflict detection stop running. Or remove the MCP server registration entirely; nothing in your project depends on it.

**Why didn't my search find something I know I saved?**
The default similarity threshold (0.2) is conservative; broader queries usually surface more. Try lowering the threshold ("search with threshold 0.1") or rephrasing closer to how you originally captured the note. Also confirm the thought is `active` — expired and superseded thoughts are excluded by default. If async storage is on, very recent captures take a moment to embed, and `agent_search` flushes them automatically before searching.

**How do I tell who saved what?**
Every thought records a `captured_by` field, resolved automatically from your `git config user.name` or the `MYBRAIN_USER` / `ATELIER_BRAIN_USER` env var. `atelier_stats` and `atelier_browse` both expose it, so you can filter by author.

**My thoughts are getting noisy. What do I do?**
A few options. Lower the default importance for type `lesson` or `insight` if those dominate. Tighten the conflict-duplicate threshold so near-duplicates merge more aggressively. Run "purge expired" to clean out the long tail. And keep capturing — clusters that hit three members get reflections, which raise the abstraction level automatically.

**What if I want to migrate my brain to a different machine?**
Dump the Postgres database, restore on the new machine, point MyBrain at it. The schema is portable; the embeddings are stored as numeric vectors and don't need re-computation as long as you keep the same embedding model.

**Does MyBrain work without the rest of the atelier-pipeline?**
Yes. MyBrain is a standalone plugin. The atelier-pipeline integrates with it when both are installed, but MyBrain works fine on its own as a personal knowledge base for any Claude Code session.

---

## Where to Next?

- Want the deep specs — schema, scoring math, conflict thresholds, full tool reference? See the [Technical Reference](technical-reference.md).
- Setting up MyBrain for the first time? Run `/mybrain-setup` inside Claude Code, or read the install section in the [README](../README.md).
- Curious how the broader atelier-pipeline uses MyBrain? See the atelier-pipeline user guide.
