# Hermes Curator — Reference Architecture

> Source: `../hermes-configuration/flow/findings/hermes-curator.md`, `hermes-architecture-overview.md`, `HERMES-KNOWLEDGE-BASE.md`
> Upstream: [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) — `agent/curator.py`, `agent/background_review.py`

## Two Autonomous Background Systems

Hermes runs **two** background agents inside the same Python process:

### 1. Background Review Fork

| Property | Value |
|----------|-------|
| Trigger | After **every** user turn |
| Mechanism | Forked `AIAgent` in daemon thread |
| Inherits | Provider, model, credentials, own prompt cache |
| Tool whitelist | `memory` + `skill_manage` only |
| Can do | Create/update skills, recall/forget memories |
| Cannot do | Touch main conversation, modify main prompt cache |
| Runs on | Main model (inherits) |

### 2. Curator

| Property | Value |
|----------|-------|
| Trigger | Inactivity-based: agent idle ≥ `min_idle_hours` (default 2h) AND ≥ `interval_hours` since last run (default 168h / 7d) |
| Mechanism | Forked `AIAgent` in daemon thread, separate `auxiliary.curator` model slot |
| Phase 1 | Deterministic (no LLM): unused ≥30d → `stale`, unused ≥90d → archive |
| Phase 2 | LLM review (max 8 iterations): consolidate overlapping, patch drift, archive dead |
| Scope | **Agent-created skills only** — never touches bundled, hub-installed, or user-owned skills |
| Model | `auxiliary.curator` slot (can use cheaper model like gemini-3-flash) |

## Provenance System

Python `ContextVar` per-thread:
- Main thread → `write_origin = "assistant_tool"` → NOT curated
- Background fork → `write_origin = "background_review"` → curated

After `_create_skill()` succeeds, checks provenance → if background, calls `mark_agent_created()`.

## Invariants

- Never auto-deletes — only archives to `~/.hermes/skills/.archive/` (recoverable)
- Pinned skills bypass all auto-transitions
- `hermes curator restore <skill>` to un-archive
- Runs in daemon thread — does NOT block CLI or gateway startup
- Fork-join concurrency model — if background agent crashes, main session unaffected

## Config

```yaml
curator:
  enabled: true
  interval_hours: 168       # 7 days
  min_idle_hours: 2
  stale_after_days: 30
  archive_after_days: 90

auxiliary:
  curator:
    provider: openrouter
    model: google/gemini-3-flash-preview
```

## CLI Surface

```bash
hermes curator status        # last run, counts, pinned, LRU top 5
hermes curator run           # trigger now
hermes curator run --dry-run # preview only
hermes curator pin <skill>   # protect from auto-transitions
hermes curator restore <skill>  # un-archive
```

## Key Files in Hermes Source

| File | Purpose |
|------|---------|
| `agent/background_review.py` | Post-turn fork: memory + skill review |
| `agent/curator.py` | Inactivity-triggered skill lifecycle maintenance |
| `tools/skill_manager_tool.py` | `skill_manage` tool (create/edit/patch/delete) |
| `tools/skill_usage.py` | Telemetry, `mark_agent_created()`, lifecycle states |
| `tools/skill_provenance.py` | ContextVar distinguishing foreground vs background writes |

## Architecture Diagram

```
Main Session (AIAgent, main thread)
│
├── Every turn → spawn_background_review() [daemon thread]
│   └── Forked AIAgent (inherits provider/model/credentials, own prompt cache)
│       ├── Tool whitelist: memory + skill_manage only
│       ├── Reviews conversation → may create/update skills
│       └── Never touches main conversation or prompt cache
│
└── Idle check (≥2h + ≥7d since last run) → maybe_run_curator() [daemon thread]
    └── Forked AIAgent (auxiliary curator model slot)
        ├── Phase 1: deterministic lifecycle transitions
        └── Phase 2: LLM review (consolidate/patch/archive)
```

## RFC Discussion Highlights (Issue #16077)

Key design concerns raised during review:

1. **LLM does too much discovery work** — should precompute "needs review" list in Python first (hash comparison, overlap detection, validation), then send only evidence packet to LLM for judgment.
2. **`terminal mv` bypasses pinned protection** — `skill_manage` checks pinned flag but `terminal` does not. Bug: 5 pinned skills were archived via `terminal mv` on first curation pass.
3. **Enabled-by-default spend** — every user gets periodic aux-model spend unless turned off. Debate whether this should be opt-in.
4. **Archive vs delete** — community strongly favors archive-only. No auto-delete.
5. **Companion PR #16026** — reframes skill-creation prompt to be class-first (survey existing → generalize → create as last resort). Together they form a create/retire loop.

## Two-Tier Strategy (from DEV.to article)

The curator uses a **generational GC** analogy:

| Tier | Analogy | Cost | Frequency |
|------|---------|------|-----------|
| Phase 1: Deterministic FSM | Compacting generational GC | Zero tokens | Every run |
| Phase 2: LLM semantic review | Manual defragmenter | API tokens (capped at 8 iterations) | Every run |

Phase 1 handles bulk tidying. Phase 2 handles "umbrella-building" — restructuring flat skill libraries into hierarchical, discoverable directories.
