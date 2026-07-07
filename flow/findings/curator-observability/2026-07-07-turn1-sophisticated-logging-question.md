# Explore Turn 1 — sophisticated-logging-question

> Date: 2026-07-07
> Phase: problem-space exploration
> Status: question answered (NO logging); gaps surfaced; 5 threads opened

## [user]

Invoked `/opsx-explore` with provided argument (verbatim — trust chain L1):

> **[user]** Do we currently having the sophisticate logging mechanism yet? What if we are installed this plugins and need to to check the logs of what been run and what are result for troubleshoot and finding bugs , how can we do it ?

Intent: does pi-curator ship a sophisticated logging mechanism? If installed, how does an operator check what ran / what the results were, for troubleshooting and bug-finding?

## [assistant]

Investigated the codebase for observability surfaces (console/stdio/ui.notify/log paths, `~/.pi-curator/` dir references, spec mentions of logs).

### Finding — NO sophisticated logging; D11 decision not honored

Short answer: **No.** And worse than "not built yet" — the design *specified* a logging decision (D11) the builder did not follow.

#### What the design decided (D11, lifecycle design.md)

```
stdio: ['ignore', openSync('/dev/null','w'), openSync('<log>','a')]
                                          stdin     stdout → /dev/null      stderr → FILE

stderr → ~/.pi-curator/logs/<mainSessionId>/<curator>-<ts>.stderr
janitor GCs log files @ 24h (alongside fork artifacts)
```

Reasoning was sound: curator stderr carries diagnostic noise (MCP init spam, deprecation warnings) useless in the main turn but gold for post-mortem. stdout is the LLM stream — curators communicate via `signal_main`, not stdout capture, so discard it.

#### What actually shipped (src/main/index.ts)

```
stdio: ["ignore", "ignore", "ignore"]   ← all three streams thrown away
```

No `~/.pi-curator/logs/` dir. No stderr capture. The doer took the spec's parenthetical *"(or piped to a per-curator log file)"* and chose the lazy branch.

**And the runtime spec references a path that doesn't exist** — `curator-runtime/spec.md:66`: *"log the absence via stderr (visible in `~/.pi-curator/logs/`)"*. Spec assumes lifecycle created it. It didn't. Cross-spec inconsistency.

### Current observability map

```
┌─ YOU WANT TO KNOW ────────────────┬─ WHERE IT IS TODAY ──────────────┬─ ANSWERABLE? ─┐
│ Did curator X run?                │ pids/<sess>/<cur>.json           │ ✅ yes        │
│ Is it alive / stale / dead?       │ same file (heartbeatAt, phase)   │ ✅ yes        │
│ What did it conclude?             │ signal → main conversation       │ ⚠️ only if it │
│                                   │  (or findings fallback if broker │    signaled   │
│                                   │   down — degraded path only)     │               │
│ Why did it crash?                 │ ── nowhere ──                    │ ❌ NO         │
│ What did it reason about?         │ ── nowhere (stdout ignored) ──   │ ❌ NO         │
│ Spawn gate: did it fire? why not? │ ── nowhere ──                    │ ❌ NO         │
│ History of past runs?             │ pids-archive/<sess>/<cur>-<ts>   │ ⚠️ partial    │
│                                   │  (swept dead pids — existence    │    (existence │
│                                   │   only, no outcome)              │    not outcome)│
│ Findings suppressed by crosscheck?│ mailbox shared.jsonl has kept;   │ ⚠️ kept only  │
│                                   │  suppressed ones not recorded    │    (suppressed│
│                                   │                                   │    invisible) │
│ Janitor tick results?             │ pm2 logs (IF pm2-managed)        │ ⚠️ janitor    │
│                                   │                                   │    only       │
└───────────────────────────────────┴──────────────────────────────────┴───────────────┘
```

The proposal also named a **`spawn-log/<mainSessionId>/`** dir (distinct from `logs/`) — for structured run records (what ran, when, result). **Neither `spawn-log/` nor `logs/` was built.**

### The black-box problem, visualized

```
                    ┌─────────────────────────────────┐
                    │       MAIN pi session            │
                    │  ┌──────────────────────────┐    │
   turn_end ──────▶ │  │ curator-main extension    │    │
                    │  │  filter+trim → fork.jsonl │    │
                    │  │  spawn(pi --fork ...) ─────────┼──▶ stdio: IGNORE/IGNORE/IGNORE
                    │  └──────────────────────────┘    │         │
                    │                                  │         ▼
                    │                          ┌───────┴────────────────┐
                    │                          │  CURATOR child (forked)│  ← this is a
                    │                          │  reasoning happens HERE│     BLACK BOX
                    │                          │  crashes/erros vanish  │
                    │  ┌──────────────────┐    │  reasoning vanishes   │
                    │  │ curator-receiver  │◀───┼── signal_main only    │
                    │  │ (if it signals)   │    │   exit path           │
                    │  └──────────────────┘    └────────────────────────┘
                    └─────────────────────────────────┘
```

The only light escaping the box is `signal_main`. Everything else — crashes, errors, "ran but found nothing", tool failures, reasoning — is lost.

### Honest troubleshooting today

If you installed this and a curator misbehaved, here's what you'd actually do:

| Symptom | Can you diagnose? | How |
|---|---|---|
| Curator never spawned | ⚠️ partial | Check `pids/<sess>/` — no file = never claimed. But can't tell *why* (gate? filter fail? config disable?) |
| Curator spawned, hung | ✅ yes | `pids` file heartbeat stale → janitor archives it |
| Curator crashed at startup | ❌ no | stdio ignored. Looks identical to "ran fine, found nothing" |
| Curator ran, wrong conclusion | ❌ no | No reasoning log. Only see the signal if it sent one |
| Crosscheck ate my finding | ⚠️ partial | `shared.jsonl` shows kept entries; suppressed ones are invisible |
| Spawn gate never fires | ❌ no | No spawn-log. Have to manually reason about `everyTurns`/`everyMins` |

### Threads surfaced (5)

1. **Just honor D11 (minimal fix).** Wire stderr → file in `spawn-args.ts`/`index.ts`. ~10 lines. Unblocks crash diagnosis. Doesn't help reasoning-visibility.

2. **Structured run-log (the `spawn-log/` the proposal named).** Each spawn appends a JSONL line: `{ts, curator, mainSessionId, gateReason, forkPath, childPid, outcome, durationMs, signaled}`. This is the "what ran and what was the result" — a proper audit trail. `/curator history` reads it.

3. **Structured logging library (the "sophisticated" word).** A real logger with levels (debug/info/warn/error), context (curator/session/phase), sinks (file + ui + maybe stderr). Heavier; pays off if curators multiply. Pattern question: does pi core have a logger to reuse, or roll our own?

4. **Crosscheck suppression recording.** Right now suppressed findings vanish. A `suppressed.jsonl` alongside `shared.jsonl` would make dedup debuggable — "why wasn't my finding surfaced?"

5. **The deeper question: is the curator a black box *by design*?** D11 deliberately discarded stdout (the reasoning stream) to avoid re-introducing blocking/context pollution. That's a real tradeoff. But it means curators are fundamentally less debuggable than in-process extensions. Worth naming explicitly: *curators trade observability for isolation.* Is that the right default, or should there be an opt-in `captureReasoning: true` for dev/debug personas?

Assistant instinct stated: **#1 + #2 together** give ~80% of troubleshooting value for low cost — D11 was already decided just unbuilt; `spawn-log` was already proposed just dropped. #5 is the interesting design conversation underneath it all.

## Status at end of turn 1

- Direct question answered: NO sophisticated logging mechanism exists.
- Drift identified: D11 (stderr→logs) decided in design, not honored in code.
- 5 threads opened (see `2026-07-07-open-threads.yaml` OT1–OT5).
- No decisions locked by user.
- Pointer to next turn → `2026-07-07-turn2-layered-approaches-and-blackbox-reframe.md`.
