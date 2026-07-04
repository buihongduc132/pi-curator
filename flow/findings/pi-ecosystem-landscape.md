# Pi Ecosystem — Memory Consolidation / Curator Landscape

> Searched: npm registry, Exa web search, grep.app GitHub code search, Hindsight bank
> Date: 2026-06-09

## Tier 1: Full Memory Governance with Curation

### `pi-persistent-intelligence` (Mont3ll) — v0.9.0

**The closest thing to a Hermes-style curator for pi.**

| Property | Detail |
|----------|--------|
| npm | `pi-persistent-intelligence` |
| GitHub | `Mont3ll/pi-persistent-intelligence` |
| License | MIT |
| Deps | `@earendil-works/pi-tui`, `@sinclair/typebox` |
| Updated | 2026-06-02 (1 week ago) |

**Architecture:**
- L1 (Identity), L2 (Playbooks), L3 (Session) — canonical JSONL with patch governance
- Evidence records, trust classes (`direct_user_instruction`, `user_correction`, `agent_inference`, `repository_text`), durability signals
- Inbox candidate system → verification → curation → patch-governed mutation
- Tombstones prevent re-promotion of deleted records
- Meta-consolidation: clusters stable L2 records, proposes L1 patterns (review-only, never auto-applied)
- Session-end LLM extraction via `pi --print` subprocess
- Inbox review panel (TUI overlay) at session start when ≥3 pending candidates

**Curator config:**
```json
{
  "curator": {
    "minConfidence": 0.75,
    "minEvidenceCount": 2,
    "autoCurate": "high-only",
    "autoCurateHighThreshold": 0.85,
    "inboxPromptThreshold": 3
  },
  "maintainer": {
    "semiStableDecay": 0.15,
    "stableDecay": 0.05
  }
}
```

**Commands:** `/curate-memory`, `/maintain-memory`, `/consolidate-memory`, `/meta-consolidation`, `/memory-handoff`, `/memory-inbox`, `/memory-learnings`

**Gap vs Hermes:** Manages **memory records** (facts, preferences, lessons). Does NOT manage **skills** (SKILL.md files). No skill usage telemetry, no skill lifecycle FSM, no skill provenance.

---

### `@samfp/pi-memory` — v1.3.4

| Property | Detail |
|----------|--------|
| npm | `@samfp/pi-memory` |
| GitHub | `samfoy/pi-memory` |
| License | MIT |
| Zero deps | — |
| Updated | 2026-06-02 |

**Architecture:**
- SQLite-backed (WAL mode): `semantic` (key-value facts + confidence), `lessons` (corrections + dedup), `events` (audit log)
- Session-end LLM consolidation via `pi -p --print`
- Correction detection (immediate save on user correction)
- Jaccard similarity dedup (≥0.7 threshold), confidence ≥0.8 for storage
- Context injection: 8KB cap, once at `session_start` via hidden custom message
- Selective lesson injection mode (per-turn, prompt-relevant)
- Configurable consolidation model (supports any provider)

**Gap vs Hermes:** No skill management at all. Memory-only. No periodic background review (consolidation only at session end). No lifecycle states.

---

### `pi-hermes-memory` (chandra447 / weichenw) — forks

| Property | Detail |
|----------|--------|
| npm | `pi-hermes-memory` |
| GitHub | `chandra447/pi-hermes-memory`, `weichenw/pi-hermes-memory` |
| Updated | 2026-04-23 / 2026-05-08 |

**Explicitly Hermes-inspired. Architecture:**
- Background learning: reviews every 10 turns OR 15 tool calls
- Correction detection: immediate save
- Failure memory: stores what didn't work
- Procedural skills: saves *how* problems were solved
- Auto-consolidation: when memory hits capacity, spawns `pi.exec()` to merge
- Secret scanning: blocks API keys/tokens from persistence
- Two-tier: global + per-project memory
- FTS5 session search across all past conversations
- Configurable LLM model override for child processes

**Gap vs Hermes:** Closest in spirit — background review loop, auto-consolidation. But manages **memory files**, not skills. No lifecycle FSM, no provenance, no pinning.

---

### `@jeffs-brain/memory-pi` — v0.2.7

| Property | Detail |
|----------|--------|
| npm | `@jeffs-brain/memory-pi` |
| GitHub | `jeffs-brain/memory` |
| License | Apache-2.0 |
| Updated | 2026-05-23 |

**Architecture:**
- Part of `@jeffs-brain/memory` pipeline
- 4 lifecycle hooks + 11 `memory_*` tools
- Recall, extract, reflect, consolidate on every session
- RAG-backed retrieval with embeddings

**Gap vs Hermes:** RAG-focused memory pipeline. No skill lifecycle management.

---

## Tier 2: Observation / Compaction-Adjacent

### `pi-observational-memory` (elpapi42)

- Background observer compresses ~1k token chunks into timestamped, relevance-tagged observations
- Compaction-time assembly: reflections + observations, mechanically concatenated (no LLM rewrite)
- Relevance tiers: low/medium/high/critical
- Reflections crystallize once and persist across compactions
- Configurable cheap model for background work (`compactionModel`)
- Zero LLM calls when observation pool < threshold
- **Different approach, same goal:** survives compaction without drift

### `pi-mem` (George Bashi / gcb)

- LanceDB-backed vector + full-text search
- Auto observation capture from `tool_result` events
- LLM-powered observation extraction
- Session summarization with checkpoint compression
- Project-aware (git remote scoping)

### `pi-self-learning` (mcollina)

- Git-backed memory with auto task-level reflections
- Daily logs, monthly summaries, core learnings file
- Scored `core/index.json` (frequency + recency)
- `/learning-redistill` to rewrite all core entries
- Configurable summarization model (branch-level and global)

### `@pi-unipi/memory` (Neuron-Mr-White) — v2.0.13

- SQLite-vec vector search, cross-session persistence
- Pure storage + retrieval layer, no consolidation

---

## Tier 3: Scheduling Infrastructure (Building Blocks)

### `pi-routines` (Davidcreador)

- **Could schedule a curator routine.** Supports: pulse, cron, oneoff, hook (session_start/agent_end/session_shutdown), API, GitHub events
- 11 bundled templates (ci-watch, pomodoro, morning-briefing, session-wrap, etc.)
- State across ticks (`RoutineSetState` + `userState`)
- `maxRunsPerDay` soft cap, pause/resume, hot-reload safe
- ~170 tests

### `pi-loop` (ArtemisAI)

- Lighter alternative: recurring prompt scheduling, cron tools, `schedule_wakeup` for dynamic pacing
- Idle gating, durable tasks, missed task recovery, anti-thundering-herd jitter

---

## Our Existing Stack (pi-plugins project)

| Extension | Role | Curator-like? |
|-----------|------|:---:|
| `hindsight-pi-local` | Session-end tagging to Hindsight bank | ❌ Tagging only |
| `immediate-compaction` | Context overflow management | ❌ Compaction only |
| `scold-reminder` | Retrieval of past reminders | ❌ Retrieval only |
| `pi-memory-guard` | RSS/CPU monitoring | ❌ Resource monitoring |
| `session-title-interval` | Periodic title generation | ❌ Metadata only |

**None do skill lifecycle management or autonomous background curation.**
