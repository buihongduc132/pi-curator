# Decision: spawn-log/ — BUILD NOW or DEFER?

> Date: 2026-07-07
> Decider: leader (after 2 sub-agent investigators went idle without writing file)
> Status: DECISION (DEFER)

## EVIDENCE

### What I read (from explore session)

1. **flow/findings/curator-observability/2026-07-07-turn2-layered-approaches-and-blackbox-reframe.md** — Tier 3 = spawn-log/. Assistant's own read: "T1+T2 = the floor. T3-T5 are real value but not urgent — wait until you hit the pain."

2. **flow/findings/curator-observability/2026-07-07-locked-decisions.yaml LD2** — locked the observability floor: pi session store + curatorSessionId pointer (LD1) + D11 stderr crash-catch. spawn-log is Tier 3, explicitly ABOVE the floor.

3. **openspec/changes/archive/2026-06-23-add-curator-lifecycle/proposal.md** — line 104 names `spawn-log/<mainSessionId>/` as a new runtime file. Never built.

4. **src/main/index.ts** — spawn hook currently records: childPid, mainSessionId, curator alias, phase (in pids file). Does NOT record: gate decision (why spawn / why skip), outcome, duration, signaled.

5. **src/util/team-attach-claim.ts** — CuratorClaim records: pid, mainSessionId, mainSessionName, curator, spawnedAt, heartbeatAt, phase, goalFile, curatorSessionId (just added). Does NOT record: gate reason, outcome, signaled.

6. **pi session JSONL** — curator's full reasoning, tool calls, results persist to `~/.pi/agent/sessions/`. Findable by `pi --resume` via `--name "curator:<alias>"`.

### Key facts

| What | Recorded? | Where |
|------|-----------|-------|
| Did curator X run? | ✅ YES | pids/<sess>/<cur>.json |
| Is it live/stale/dead? | ✅ YES | same file (heartbeatAt, phase) |
| What did it reason about? | ✅ YES | pi session JSONL (~/.pi/agent/sessions/) |
| What did it conclude? | ✅ YES | session JSONL + signal_main |
| Why did it crash? | ✅ YES (now) | D11 stderr → ~/.pi-curator/logs/ |
| Which session is curator X? | ✅ YES (now) | curatorSessionId pointer (LD1) |
| Spawn gate: did it fire? why? | ❌ NO | no spawn-log; can't tell "gate skipped" from "never tried" |
| History of past runs? | ⚠️ partial | pids-archive/<sess>/<cur>-<ts> (existence only, no outcome) |

## DECISION

**DEFER**

## RATIONALE

1. **LD2 locked the floor at Tier 1+2 (pointer + stderr).** spawn-log is Tier 3, explicitly above the floor. The assistant's read in turn-2 was explicit: "T3-T5 are real value but not urgent — wait until you hit the pain." No one has hit the pain yet.

2. **The gap is narrow.** The only thing spawn-log adds that no other mechanism covers is the spawn gate decision trail: "did the gate fire? why not?" This is useful for debugging spawn configuration, but it's not a crash or data-loss scenario. The curator's reasoning + conclusions are already fully observable via pi session JSONL (☀️, not 🌑).

3. **Cheaper alternative exists.** If the gate decision trail becomes critical, it can be added as a one-line append to the existing pids file (e.g., `lastGateDecision: "skipped: turnsSince=2 < everyTurns=5"`) without creating a new directory structure. This is ~5 lines, not a new subsystem.

4. **Gold-plating risk.** spawn-log/ is a structured JSONL with schema, writer, reader, GC, `/curator history` command. That's a non-trivial surface for a feature no one has asked for yet. YAGNI.

5. **Consistent with OT6 (suppressed.jsonl) = SKIP.** Both Tier 3+ are deferred. The floor (Tier 1+2) is the priority.

## IF DEFER: what trigger makes it worth building

- **A real debugging session where the spawn gate decision was needed and not recoverable** — concrete pain, not speculative. Example: "I configured `everyTurns: 10` but the curator never spawned, and I can't tell why."
- **Curator count scales up** — if 5+ curators per main become common, manually reasoning about gate decisions becomes tedious.
- **Gate logic becomes more complex** — if spawn gates gain more conditions (e.g., resource limits, dependency checks), the decision trail becomes more valuable.

## IF BUILD: minimal scope

N/A — decision is DEFER.

If revisited and flipped to BUILD, the minimal scope would be:
- New file: `~/.pi-curator/spawn-log/<mainSessionId>.jsonl`
- Schema: `{ts, curator, gateDecision: "spawned"|"skipped", gateReason: string, forkPath, childPid, curatorSessionId, outcome: "running"|"exited"|"crashed", durationMs?, signaled: boolean}`
- Writer: append in src/main/index.ts after spawn evaluation (one line per persona per turn)
- Reader: `src/main/spawn-log-reader.ts` for `/curator history`
- Janitor: GC spawn-log files older than forkTTL (24h) alongside fork artifacts
- Slash command: `/curator history [<curator>]` reads the log
