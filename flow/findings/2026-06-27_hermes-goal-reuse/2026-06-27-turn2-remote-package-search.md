# Explore Turn 2 — Remote search for existing goal-mode packages

> Date: 2026-06-27
> Phase: remote discovery
> Status: found the pi `/goal` ecosystem; surfaced `pi-until-done` as the Hermes port candidate

## [user] (verbatim — trust chain L1)

> **[user]** Search remotely and find out if there is any packages / plugins available as that goal mode for pi or not.

## [assistant]

Tools tried: `mcp_hub_grep-app_searchGitHub` (504 gateway timeout x2, 1 no-result), `npm search pi-coding-agent` / `pi-extension`, `mcp_hub_websearch-zai_web_search_prime`.

### npm search hits (initial)

- `pi-coding-agent` (placeholder, mitsuhiko)
- `pi-acp` (ACP adapter)
- `pi-mcp-adapter`
- `@remnic/plugin-pi` (memory)
- `@a5c-ai/babysitter-pi` (orchestration)
- `@agentuity/coder-tui`
- `@plannotator/pi-extension`
- `@ayulab/pi-rewind` (checkpoint nav)
- various others — none goal-mode

### Web search surfaced the `/goal` ecosystem

- `@narumitw/pi-goal` — "Pi extension that keeps working on a /goal until the agent marks it complete."
- `pi-goal-x` — "long-running goal extension for pi... schema-gated tools"
- `code-yeongyu/pi-goal` — "ports the useful parts of Codex goal mode into a pi package"
- `@matheusbbarni/pi-goal-extension` — "Interactive Codex /goal sessions for Pi"
- `@qhn/pi-goal` — "Setup-first autonomous goal mode for Pi"
- `@zhushanwen/pi-goal` — "Codex-style /goal command for Pi... evidence-based completion"
- `@ramarivera/pi-goal` — "Codex-style persisted goals... hidden continuation pressure"

### Read `@narumitw/pi-goal` npm page (3,468 weekly downloads at time)

Key features:
- `/goal <goal_to_complete>` starts goal mode
- `goal_complete` tool for explicit completion
- Rejects plainly contradictory completion summaries ("not complete", "tests still fail") — **regex/string-match only, NOT an LLM judge**
- Token budgets (`/goal --tokens 100k`)
- States: active, paused, budget_limited, complete
- Session-scoped goal state (Codex thread-owned model)

**Critical: NO sidecar LLM judge.** Completion = `goal_complete` tool + regex rejection of contradictory summaries.

### Ecosystem map (drawn at this turn)

```
SELF-DECIDE (no judge)              AUX JUDGE / VERIFIED
──────────────────────              ──────────────────────
@narumitw/pi-goal     ← regex-rejects contradictory   pi-until-done     ← cross-model judge (Hermes port)
  "not done" summaries                                              • gates until_done_complete
code-yeongyu/pi-goal   ← Codex port                                    • kept out of session context
@qhn/pi-goal           ← no judge at all                              • Esc-cancelable via ctx.signal
@ramarivera/pi-goal    ← persisted goals                       
@matheusbbarni/...     ← Codex /goal sessions            SCHEMA/VERIFY-GATED
@baggiiiie/pi-goal                                       ──────────────────────
                                                          pi-goal-x / @capyup/pi-goal  ← schema-gated tools
                                                          pi-codex-goal                ← npm run verify gate
                                                          @zhushanwen/pi-goal          ← evidence-based completion
```

### Two real findings

1. **`pi-until-done`** is literally described as "brings Hermes Agent's `/goal` (Ralph loop with judge) to Pi." Cross-model judge is **default-on**, uses `pi-ai`'s `complete()` for a one-shot LLM call **kept out of Pi's session**.
2. The `/goal` plugins split into: self-decide (no judge) vs schema/verify-gated vs true aux-LLM-judge.

### What this does to original Q1/Q2

Collapses the build question for the goal-judge half. `pi-until-done` ALREADY IS that separate plugin. The real question becomes: is the curator advisory-review role STILL worth building, given goal-judge is solved? Two distinct value props remain that no `/goal` plugin covers:
1. Advisory mid-task nudges (curator's `signal_main(steer)` fires during the loop; `/goal` plugins only judge at completion).
2. Skill/memory curation (the Hermes Curator proper, still a genuine gap per `gap-analysis.md`).

```
                     sidecar-LLM-review need
                              │
              ┌───────────────┼────────────────┐
              ▼               ▼                ▼
        AUTHORITATIVE     ADVISORY         CURATION
        (gate the loop)   (nudge mid-loop) (govern skills/memory)
              │               │                │
       pi-until-done     ???               ???
       (DONE — exists)   (gap)            (gap — curator specs)
```

### Status at end of turn 2

Found the ecosystem. `pi-until-done` is the only true Hermes `/goal` authority port (aux LLM judge, out-of-session). Offered to pull actual source to verify judge is genuinely out-of-process and reusable. Next: turn 3 — user redirects to search from pi.dev/packages specifically.
