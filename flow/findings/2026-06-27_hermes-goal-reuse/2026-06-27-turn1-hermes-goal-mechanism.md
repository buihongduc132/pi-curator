# Explore Turn 1 — Hermes /goal mechanism + curator squeeze question

> Date: 2026-06-27
> Phase: grounding + reframing
> Status: surfaced the inverse-authority insight; opened 4 threads

## [user] (verbatim — trust chain L1)

> **[user]** check hermes functionalities about the /goal cmd of it ; It is combining a sidecar LLM to review the works; 1. Can we squeeze that to the functionalities of the curator that we are planning? 2. should it be a separate plugins?

## [assistant]

Grounded by reading:
- `flow/findings/curator/README.md` (research-only, 2026-06-09)
- `flow/findings/curator/hermes-curator-reference.md`
- `flow/findings/curator/gap-analysis.md`
- `openspec/specs/curator-{config,lifecycle,runtime,signal}/spec.md`
- `openspec/changes/archive/2026-06-23-add-curator-crosscheck/design.md`
- Hermes kanban-orchestrator skill (`/goal` = Ralph-style goal loop)

### What Hermes `/goal` actually is

From the kanban-orchestrator skill — `/goal` = a **Ralph-style goal loop** with one distinctive mechanism: an **auxiliary judge** LLM that evaluates the worker's response vs the card's title+body (acceptance criteria) after EVERY turn. The judge is **authoritative** over the loop — its verdict *controls* whether the worker keeps going, stops, or gets blocked for human review. Worker has no autonomy to exit on its own judgment.

```
   ┌─ worker turn ─┐
   │               │
   ▼               │
┌──────────┐  ┌────┴─────────┐
│  worker  │→ │ AUX JUDGE     │  ← sidecar LLM, after EVERY turn
│ (same    │  │ evaluates vs  │
│  session)│  │ goal = title  │
│  full    │  │ + body        │
│  context)│  │ (acceptance)  │
└──────────┘  └──┬─────┬──────┘
     ▲         │     │
     │ not done │     │ done
     └──────────┘     ▼
                  stop loop
                  (or budget → BLOCK)
```

### Curator (as specced) vs goal-judge are INVERSES

```
CURATOR (advisory)              GOAL-JUDGE (authoritative)
─────────────────────           ─────────────────────────
main OWNS its own loop          judge OWNS the loop
curator ADVISES                 worker SERVES the judge
nudge → signal_main(steer/append) verdict → continue/stop/block
cannot block main               deterministically gates turns
curator decides IF to speak     judge decides IF to continue
spawn gate = everyTurns/Mins    runs after EVERY turn
one-shot review per spawn       tight per-turn coupling
```

Same *mechanism* (sidecar LLM reads trimmed main context, reviews, sends verdict back). **Opposite authority model.**

The curator's locked invariants (from `add-curator-crosscheck` design) literally forbid it from controlling main:
> "curator decides when to intercom" · "fail-open, never block" · "no majority vote, no consensus"

A goal-judge does the exact opposite — it *must* block (gate) and it *must* be authoritative. **Squeezing the judge into curator would violate its own founding invariants.**

So for Q1 ("squeeze into curator"): **No, not cleanly.** You'd either break the curator's advisory contract or hollow out the judge's authority.

### Where does goal-judge actually belong — three candidates

```
                    shared sidecar infra
                    (context fork, trim,
                     cheaper-model routing,
                     spawn, heartbeat)
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
     ADVISORY         AUTHORITATIVE      AUTHORITATIVE
     (curator)        inside ralph       new plugin
                      (loop-native)      (goal-judge)
```

- **Option A — ralph-wiggum gains a judge hook.** pi-ralph-wiggum today: single agent self-decides completion via `<promise>COMPLETE</promise>`. The gap is *exactly* the Hermes `/goal` mechanism. Most idiomatic fit.
- **Option B — new standalone goal-judge plugin.** Reinvents loop budgeting, completion markers, session continuity.
- **Option C — squeeze into curator.** (Q1) Wrong authority model.

The mechanism overlap (sidecar spawn + context fork + cheaper model + signal transport) is real and worth extracting — but the *behavior* (advisory vs authoritative) is not squeezable into one persona-config flag.

```
┌──────────────────────────────────────────────┐
│  shared layer (not a plugin — a lib/util):    │
│  • fork-and-trim main JSONL                    │
│  • spawn sidecar pi --print --model <cheap>    │
│  • heartbeat + phase FSM (curator runtime)     │
│  • signal transport (pi-intercom / file)       │
└───────────────┬──────────────────────────────┘
                │ consumed by
      ┌─────────┴──────────┐
      ▼                    ▼
  pi-curator          ralph-wiggum
  (advisory)          (+ authoritative judge hook)
```

### Open questions surfaced

1. Does ralph-wiggum want a judge at all? Today it trusts the agent's own `<promise>COMPLETE</promise>`.
2. Judge timing in pi's turn model — does any existing extension block turn progression?
3. Same-session vs fresh sidecar — Hermes `/goal` runs in worker's session; curator runs fresh forked.
4. Is there a 4th option — e.g. the `verifier-loop` skill might already be pi's goal-judge primitive, dissolving the question.

### Status at end of turn 1

Surfaced the inverse-authority reframe. Q1 (squeeze into curator) → No, not cleanly. Q2 (separate plugin) → likely, but Option A (ralph hook) may be more idiomatic. Opened 4 threads; offered to pull thread #4 (check verifier-loop skill). Next: turn 2 — user redirects to search remotely for existing goal-mode packages.
