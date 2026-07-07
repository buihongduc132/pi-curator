# Explore Turn 2 — layered-approaches-and-blackbox-reframe

> Date: 2026-07-07
> Phase: reframing + option comparison
> Status: black-box premise CORRECTED by user; approaches layered; 5 decisions surfaced (none locked)

## [user]

Invoked `/opsx-explore` with provided argument (verbatim — trust chain L1):

> **[user]** Give me approach to resolve these , layered them from least effort to most ; Then also the one that still need my decision ; Also , currently we are keeping the curator is to be blackbox , we always be able to read the pi session data in the ~/.pi anyway ;

Three asks:
1. Approaches to resolve the gaps, layered least→most effort.
2. Which approaches still need a user decision.
3. Assertion/correction: curator is intentionally a black box, because the curator is a pi session and pi session data is always readable from `~/.pi`.

## [assistant]

Grounded the user's claim against the codebase before reasoning. **Verified: `pi --fork` creates a NEW session that persists to `~/.pi/agent/sessions/`.** The curator is NOT a black box — it is a first-class pi session with full persistence.

### The reframe (user is right)

```
                 YOUR POINT, verified:
                 
  pi --fork <filtered.jsonl> ──▶ creates a NEW session
                                        │
                                        ▼
                 ~/.pi/agent/sessions/<cwd>/<ts>_<uuid>.jsonl
                                        │
                    ┌───────────────────┴───────────────────┐
                    │  ✅ reasoning (thinking blocks)        │
                    │  ✅ tool calls + results               │
                    │  ✅ assistant messages                 │
                    │  ✅ everything pi records for ANY      │
                    │     normal session                     │
                    └───────────────────────────────────────┘
                                        │
                 Also named: "curator:<alias>"  (--name flag, already shipped)
                 So: `pi --resume` → find it by name
```

So reasoning visibility = **already solved by pi itself.** Assistant's turn-1 "black box" framing was wrong. The real gap is **correlation**, not **capture**.

### What's ACTUALLY still dark (honest re-audit)

```
┌─ ASPECT ─────────────────────┬─ DARK? ──┬─ WHY ─────────────────────────────┐
│ Curator reasoning            │   ☀️     │ pi session JSONL has it all       │
│ Curator tool calls/results   │   ☀️     │ same session JSONL                │
│ Curator's final conclusion   │   ☀️     │ session JSONL + signal_main       │
│──────────────────────────────│──────────│───────────────────────────────────│
│ WHICH session is curator X?  │   🌑     │ pids file has no curatorSessionId │
│                              │          │ → must hunt by name+timestamp     │
│──────────────────────────────│──────────│───────────────────────────────────│
│ Curator crashed at startup   │   🌑     │ if pi dies before writing session │
│ (MCP init explosion)         │          │ → NO session JSONL exists at all  │
│                              │          │ stderr was IGNORE/IGNORE/IGNORE   │
│──────────────────────────────│──────────│───────────────────────────────────│
│ Spawn gate decision trail    │   🌑     │ no spawn-log; can't tell "gate    │
│                              │          │ skipped" from "never tried"       │
│──────────────────────────────│──────────│───────────────────────────────────│
│ Crosscheck ate my finding    │   🌑     │ suppressed findings not recorded  │
└──────────────────────────────┴──────────┴───────────────────────────────────┘
```

Only **4 real gaps** remain, not 5+. The biggest (#1: correlation) is a *pointer* problem, not a *capture* problem.

### Layered approaches (least → most effort)

#### Tier 0 — Do nothing (your default)
Curator reasoning lives in `~/.pi`. Troubleshoot via `pi --resume`, find `curator:<alias>`. Manual but functional.
**Cost:** 0. **Covers:** reasoning, conclusions, tool calls. **Misses:** crashes-before-session-write, gate trail, suppression trail.

#### Tier 1 — One missing pointer (~5 lines)
Add `curatorSessionId` to the `CuratorClaim` (pids file). The curator's own runtime adapter (`runtime/index.ts`) knows its session id at startup — write it back on first heartbeat. Then `/curator status` shows the link: `curator:spec → ses_abc123`.
**Cost:** tiny. **Covers:** one-click jump from pids → full session. **Decision needed:** pids schema changes — migration for existing files (treat missing field = legacy, look up by name+ts).

#### Tier 2 — D11 stderr capture (~10 lines, already decided)
The one genuinely-unbuilt thing. `stdio: ['ignore', '/dev/null', <log-file>]` so startup crashes land in `~/.pi-curator/logs/<sess>/<curator>-<ts>.stderr`. Only covers the "pi died before writing a session" edge — but that's the *only* case Tier 0 can't handle.
**Cost:** small. **Covers:** pre-session-write crashes. **Already designed** (D11), just not followed by the doer.

#### Tier 3 — Structured run-log (spawn-log/, already proposed)
JSONL per main session: `{ts, curator, gateReason, forkPath, childPid, curatorSessionId, outcome, durationMs, signaled}`. Gives `/curator history` — the "what ran and what was the result" audit trail.
**Cost:** medium (new file + writer + reader + slash cmd). **Covers:** full spawn decision trail, historical analysis.

#### Tier 4 — Crosscheck suppression recording
`suppressed.jsonl` next to `shared.jsonl`. Makes dedup debuggable.
**Cost:** small. **Covers:** "why wasn't my finding surfaced?"

#### Tier 5 — Full logging library (levels, sinks, context)
Real logger. Only worth it if curators multiply and you want structured querying.
**Cost:** high. **Covers:** everything, uniformly. **Verdict:** premature given Tier 0 already covers reasoning.

### Effort visualization

```
EFFORT ──▶
0         1         2         3         4         5
│─────────┼─────────┼─────────┼─────────┼─────────┼────
│         │         │         │         │         │
T0        T1        T2        T3        T4        T5
do        +pointer  +stderr   +run-log  +suppress +logger
nothing   to pids   capture   spawn-log .jsonl    library
          file      (D11)
          
└── reasoning ──┘  ← already free (pi sessions)
                   └── crashes ──┘  ← T2 is the only thing that catches pre-session death
                                  └── audit/history ─┘
                                                   └── crosscheck debug ─┘
```

### Decisions still yours (5 surfaced, NONE locked)

| # | Decision | Context |
|---|----------|---------|
| **D-A** | T1: add `curatorSessionId` to pids schema? | Breaks nothing if field is optional. Tiny win, high value. Assistant lean: yes. |
| **D-B** | T2: honor D11 (stderr→file) or accept "early crash = unsolvable"? | D11 was already decided in design — this is "do we follow our own decision." Edge case is rare but catastrophic when it hits (curator silently dies, you have *nothing*). |
| **D-C** | T3: is `/curator history` worth it now, or wait until curators multiply? | Gold-plating risk. But it's the only thing that answers "did the gate ever fire?" without manual math. |
| **D-D** | T4: do suppressed findings matter enough to record? | Depends how much you trust the first-finding-wins dedup. If you never question it, skip. |
| **D-E** | Is "black box by design" actually the *intended* posture? | User phrasing suggests yes. If so: T1+T2 are the floor (pointer + crash-catch), T3-T5 optional polish. Formalizing this as a design decision prevents future "why can't I debug X" surprises. |

### Assistant read

T1 + T2 together = the floor. ~15 lines total. Covers: one-click correlation + the one true blind spot (early crashes). Everything else is reasoning you already have via pi sessions. T3-T5 are real value but not urgent — wait until you hit the pain.

Meta-question **D-E**: should we *formalize* "curator observability = pi session store + pids correlation + stderr crash-catch, nothing more" as an explicit design decision? That turns a drift (doer ignored D11) into a principled stance. Worth capturing in design.md either way — because right now the code says "black box" while the design said "stderr→logs", and that contradiction is the actual bug.

Assistant offered: capture as design decision, or spin up a change proposal for T1+T2. Kept open.

## Status at end of turn 2

- Black-box premise corrected: curator is a pi session; reasoning persists to `~/.pi`.
- Real gaps narrowed to 4 (correlation, early-crash, gate trail, suppression).
- 6 tiers layered least→most effort.
- 5 decisions surfaced (D-A..D-E); user has NOT yet locked any.
- New threads opened: OT6 (pointer schema), OT7 (formalize black-box-by-design).
- Explore ongoing — awaiting user pick of which thread to pull.
