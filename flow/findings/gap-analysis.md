# Gap Analysis: Hermes Curator vs Pi Ecosystem

> Date: 2026-06-09

## Capability Matrix

| Capability | Hermes Curator | Best Pi Match | Gap? |
|-----------|:-:|:-|:---:|
| **Skill usage telemetry** (use_count, view_count, last_used_at) | ✅ `.usage.json` | ❌ Nobody | **Missing** |
| **Skill lifecycle FSM** (active→stale→archived) | ✅ 30d/90d thresholds | ❌ Nobody | **Missing** |
| **Skill provenance** (agent-created vs user-owned) | ✅ ContextVar | ❌ Nobody | **Missing** |
| **Periodic background trigger** (idle + interval) | ✅ Built-in | `pi-routines` (cron/hook) | Assembly needed |
| **Background LLM skill review** (consolidate overlaps, patch drift) | ✅ Forked agent, max 8 iterations | ❌ Nobody does this for *skills* | **Missing** |
| **Archive-with-recovery** (not delete) | ✅ `.archive/` dir | ❌ Nobody | **Missing** |
| **Pinning** (protect from auto-transitions) | ✅ | ❌ Nobody | **Missing** |
| **Separate model slot** (cheap model for curator) | ✅ auxiliary.curator | `pi-persistent-intelligence` (PI_MEMORY_CONSOLIDATION_MODEL) | Exists for memory, not skills |
| **Memory record curation** (facts, preferences, lessons) | ✅ (via background review) | `pi-persistent-intelligence` ✅ | Covered |
| **Session-end extraction** | ✅ | `@samfp/pi-memory`, `pi-persistent-intelligence` | Covered |
| **Correction detection** | ✅ | `@samfp/pi-memory`, `pi-hermes-memory` | Covered |
| **Background periodic review** (per-turn or per-interval) | ✅ | `pi-hermes-memory` (every 10 turns), `pi-routines` (cron) | Partially covered |

## What Would Be Needed to Build a Pi Curator

### New Components (don't exist anywhere)

1. **Skill Usage Tracker** — hook into skill loading/invocation, maintain `.usage.json` per skill with `use_count`, `last_used_at`, `view_count`
2. **Skill Provenance Layer** — mark skills as `created_by: "agent"` vs `"user"` vs `"bundled"` at creation time
3. **Lifecycle FSM** — deterministic transitions: `active` → (30d idle) `stale` → (90d idle) `archived`
4. **Archive Mechanism** — move skills to `.archive/` dir, `restore` command, never delete
5. **Pin System** — user can pin skills to exempt from auto-transitions
6. **Background LLM Review** — periodic agent pass that surveys skills, detects overlaps, proposes consolidation

### Existing Building Blocks (can reuse)

| Component | Package | Role |
|-----------|---------|------|
| Scheduling | `pi-routines` | Cron/hook triggers for periodic curator runs |
| Memory governance | `pi-persistent-intelligence` | Curation model, inbox pattern, patch governance |
| Background LLM calls | `pi --print` subprocess | Standard pattern for child agent work |
| Context isolation | `pi --print` with own session | Background work doesn't pollute main session |

### Architecture Sketch

```
pi-routines (session_shutdown hook, once: daily)
  → checks idle time + interval
  → spawns curator routine
    → Phase 1: deterministic
      ├── Read skill usage stats from .usage.json
      ├── Apply lifecycle transitions (active→stale→archived)
      └── Skip pinned skills
    → Phase 2: LLM (if changes detected)
      ├── pi -p subprocess (cheaper model)
      ├── Survey agent-created skills
      ├── Detect overlaps (embedding/name similarity)
      ├── Propose consolidation/patch/archive
      └── Write REPORT.md + run.json audit trail
```

### Config Sketch

```json
{
  "pi-curator": {
    "enabled": true,
    "intervalHours": 168,
    "minIdleHours": 2,
    "staleAfterDays": 30,
    "archiveAfterDays": 90,
    "model": "bailian-coding-plan/qwen3-235b-a22b",
    "maxLlmIterations": 8,
    "archiveDir": ".archive"
  }
}
```

## Risk / Considerations

1. **Skill discovery in pi is filesystem-based** — skills live in multiple directories (`~/.pi/agent/skills/`, `.agents/skills/`, `.pi/skills/`, packages). Any curator must scan all discovery paths.
2. **pi has no `auxiliary` model slot concept** — unlike Hermes, there's no built-in way to route specific work to a cheaper model. Would need explicit `pi --print --model <cheaper>` subprocess.
3. **No provenance in pi core** — would need extension-level tracking (e.g., a `.provenance.json` file alongside each skill).
4. **`pi-routines` is session-bound** — routines only run while pi is running. Unlike Hermes gateway (always-on), pi has no daemon mode. Curator would only run when a pi session is active.
5. **Skill format is simple** — pi skills are just `SKILL.md` + optional frontmatter. No structured metadata like Hermes' `plugin.yaml`. Usage tracking would need a sidecar file.
6. **Our project has 138 skills** — any curator would need to handle scale. Hermes' max 8 LLM iterations may not be enough.
7. **`pi-persistent-intelligence` is the most mature** — if building anything, consider extending it rather than creating from scratch. Its curation/governance model is well-designed.

## Recommended Approach (If Ever Building This)

1. Start with `pi-persistent-intelligence` as the governance engine (inbox, verification, patch, curator config)
2. Add a skill-specific layer on top (usage tracking, provenance, lifecycle FSM)
3. Use `pi-routines` for scheduling (session_shutdown hook, once: daily)
4. Use `pi --print --model <cheap>` for background LLM work
5. Keep audit trail (REPORT.md + run.json) following Hermes pattern
6. Archive to `.archive/` — never auto-delete
