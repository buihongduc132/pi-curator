# Explore Turn 3 — Browse pi.dev/packages; confirm pi-until-done as Hermes port

> Date: 2026-06-27
> Phase: confirmation via official package directory
> Status: confirmed pi-until-done = Hermes `/goal` port; read full README incl. cross-model judge section

## [user] (verbatim — trust chain L1)

> **[user]** Search from here: https://pi.dev/packages

## [assistant]

Opened `https://pi.dev/packages` (page 53). Grepped page content for goal/judge/loop/sidecar/verifier/ralph/review. Found `@narumitw/pi-goal` and a reference to a Hermes `/goal` port.

Then ran two parallel calls:
- `mcp_hub_browser-os_tabs new` → `https://www.npmjs.com/package/@narumitw/pi-goal` (page 55)
- `mcp_hub_websearch-zai_web_search_prime` for "npm pi-goal-x code-yeongyu pi goal extension sidecar judge"

### Result: a WHOLE ecosystem found

Web search returned ~10 distinct goal plugins:
- `@narumitw/pi-goal` — keeps working on `/goal` until agent marks complete
- `pi-goal-x` — schema-gated tools, durable objective, visible lifecycle
- `@capyup/pi-goal` — fork of pi-goal-x
- `code-yeongyu/pi-goal` — ports Codex goal mode parts (session-scoped store, Codex TUI footer)
- `pi-codex-goal` — Codex-style goal tracking + continuation
- `@qhn/pi-goal` — setup-first autonomous goal mode
- `@zhushanwen/pi-goal` — Codex-style, evidence-based completion, token/time budgets, blocked detection
- `@ramarivera/pi-goal` — Codex-style persisted goals, hidden continuation pressure
- `@matheusbbarni/pi-goal-extension` — interactive Codex `/goal` sessions
- `@baggiiiie/pi-goal` — Codex-style persisted goals
- `pi-agent-goal` — persistent `/goal` workflows, branch-aware state, source imports
- **`pi-until-done`** — *"Pi extension that brings Hermes Agent's `/goal` (Ralph loop with judge) to Pi as /until-done. Pi self-judges every turn, runs verifyCommand to..."*

### pi-until-done full README (read via page 53 snapshot)

- Source: `srinitude/pi-until-done`, inspired by `srinitude/pi-config`, Hermes `/goal` docs.
- Install: `pi install npm:pi-until-done`. Requires Bun + mise.
- **8 tools**: `until_done_set`, `until_done_plan`, `until_done_replan`, `until_done_task_update`, `until_done_progress`, `until_done_complete`, `until_done_block`, `until_done_distill`.
- **Subcommands**: `/until-done <intent>`, `status`, `detail`, `tasks`, `plan`, `northstar`, `replan-log`, `pause`, `resume`, `cancel`, `budget <n>`, `ask <question>`, `autopilot`, `judge`, `judge <provider>/<modelId>`, `judge same`, `judge clear`, `help`.
- **CROSS-MODEL JUDGE (DEFAULT-ON, REQUIRED)**:
  - Every `until_done_complete` is gated by a different-model judge.
  - Uses `pi-ai`'s `complete()` for a one-shot LLM call, **kept out of Pi's session** so it doesn't pollute the executor's context.
  - Esc-cancelable via `ctx.signal`.
  - Judge model resolved via `ctx.modelRegistry`.
- **Hook coverage: 28/29 events subscribed** (one declarative). Notable:
  - `agent_end` = THE HEURISTIC JUDGE STEP (budget check, spin-guard, user-driven-turn detection, CI on stop, clean-end nudge, queue continuation). LLM cross-model judge fires inside `until_done_complete`, not here.
  - `before_agent_start` = append (never replace) goal-reminder block to system prompt.
  - `session_compact` = re-anchor verdict state + custom_message with evidence/learnings/current task.
  - `tool_call` = POLICY GATE (enforce ask-before list against bash).
- **North Star contract** (locked at `until_done_set`): `goal`, `doneCriteria`, `verifyCommand`, `askBefore`, `decisionStyle`. Mutable mid-execution: task list, per-task fields, phase, maxTurns.
- **Replan ops**: insert, remove, replace, split, merge, reorder.
- Live YAML on disk: `.until-done/tasks.yaml`.

### pi-until-done's own comparison table (verbatim from README)

|  | `@qhn/pi-goal` | Hermes `/goal` | `/until-done` |
|---|---|---|---|
| Setup flow | User-led interview | None — judge asks each turn | Pi-led interview |
| Judge | None — model self-decides | Auxiliary model judge call | Self-judge via tools by default; opt-in cross-model judge gates `until_done_complete` |
| State storage | Pi session entries | SessionDB.state_meta | Pi session entries |
| Hook coverage | 1–2 events | n/a (Hermes-internal) | 28/29 events subscribed |
| Conflict-safe | yes | n/a | yes (auto-detects qhn/pi-goal) |
| System-prompt mutation | none | none | append-only |

### Conclusion drawn at this turn

```
BEFORE:  "should goal-judge be a separate plugin or squeezed into curator?"
AFTER:   pi-until-done ALREADY IS that separate plugin.
         The real question: is the curator advisory-review role STILL worth building?
```

Two distinct value props remain that no `/goal` plugin covers:
1. **Advisory mid-task nudges** — pi-until-done's judge only fires *at completion*. Curator's `signal_main(steer)` fires *during* the loop.
2. **Skill/memory curation** — none of the `/goal` plugins touch skill lifecycle, provenance, overlap consolidation. Still a genuine gap per `gap-analysis.md`.

The fork worth thinking about:
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

Offered to pull pi-until-done actual source to verify the judge is genuinely out-of-process and reusable.

### Status at end of turn 3

Confirmed pi-until-done = the Hermes `/goal` faithful port with aux-LLM judge kept out of session. Asked if user wants source pull to verify reusability. Next: turn 4 — user raises the bar to "completely superset/reuse by 3rd party" + asks for authority-filtered comparison table with stars + downloads.
