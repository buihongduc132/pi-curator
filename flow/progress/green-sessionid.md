# GREEN Phase — curatorSessionId pointer (LD1)

**Agent**: green-sessionid
**Task**: #15 — Implement `curatorSessionId` pointer (LD1) to pass RED tests written by red-sessionid
**Date**: 2026-07-07
**Status**: ✅ COMPLETE — all 18 LD1 tests now PASS; full suite 439/439 PASS; `tsc --noEmit` exit 0.

## What was implemented

LD1 locked decision: an optional `curatorSessionId` pointer on `CuratorClaim` that flows from
parse → heartbeat tick → writer → status rendering. Fully non-breaking: a missing/empty/non-string
value is treated as absent (`undefined`), never a hard error. Legacy claims parse unchanged.

### Source files changed (3 — NO test files modified)

| File | Change | Lines |
|------|--------|-------|
| `src/util/team-attach-claim.ts` | `CuratorClaim.curatorSessionId?: string`; `parseCuratorClaim` preserves it via `getOptionalString`; `heartbeatCuratorClaim` stamps it when provided (else preserves via `…current`) | +15 |
| `src/runtime/heartbeat.ts` | `TickResult.curatorSessionId?`; `tickHeartbeat` opts accept + surface it; `StartHeartbeatOpts.curatorSessionId?`; writer opts typed; `runTick` threads it to the writer | +19 |
| `src/main/slash-commands.ts` | `formatStatusOutput` renders `curator:<alias> → ses_<id>` when present; omits arrow for legacy | +5 |

`src/util/staleness.ts` required **no edit** — `readPidEntries` already does `{ …entry, liveness, ageMs }`,
so once `parseCuratorClaim` preserves the field, it surfaces automatically (and `StalePidEntry extends
CuratorPidEntry = CuratorClaim` inherits the optional field).

## RED → GREEN resolution (all 8 originally-failing tests now pass)

1. **team-attach-claim** `parseCuratorClaim preserves curatorSessionId` → `getOptionalString` round-trips non-empty strings; empty/non-string/absent → `undefined`. ✅
2. **heartbeat** `tickHeartbeat accepts curatorSessionId in opts / surfaces in TickResult` → added to opts + `TickResult`. ✅
3. **heartbeat** `tickHeartbeat carries curatorSessionId alongside a phase event` → same path; phase FSM unaffected. ✅
4. **heartbeat** `startHeartbeat writes curatorSessionId on the first heartbeat tick` → `StartHeartbeatOpts.curatorSessionId` threaded via `runTick` → writer (first tick fires `start_review` + the pointer). ✅
5. **staleness** `readPidEntries surfaces curatorSessionId` → automatic via spread once parse preserves it. ✅
6. **staleness** `readPidEntries mixes legacy + pointer-bearing entries` → legacy → `undefined`, pointer → value. ✅
7. **slash-commands** `formatStatusOutput includes the link / omits for legacy / renders a mix` → conditional `curator:<alias> → ses_<id>` suffix. ✅
8. **team-attach-claim** type-shape assertions (optional field, omittable) → interface has `curatorSessionId?: string`. ✅

## Design notes

- **Non-breaking by construction.** `getOptionalString` rejects `""` and non-strings (consistent with
  `mainSessionName`/`goalFile`), so a corrupt or empty pointer degrades to legacy `undefined` rather
  than failing the whole claim parse.
- **Persistence is idempotent.** `heartbeatCuratorClaim` uses `…(opts.curatorSessionId ? {…} : {})`
  so it stamps the pointer when supplied and otherwise preserves whatever is already on disk via
  `…current`. This makes the real runtime (default writer) actually persist the pointer, not just the
  injected test writer.
- **`startHeartbeat` passes the pointer on every tick** (the curator's session id is stable). The RED
  test only asserts the first write; passing every tick is a harmless superset and keeps the code
  branch-free (no `firstTick` special-case for the pointer).
- **`createBeforeExitHandler` is unaffected** — it writes `{ phase: "done", nowMs }` only; the pointer
  survives via the on-disk claim (`…current` spread in `heartbeatCuratorClaim`).

## Verification

```
npx tsc --noEmit   → exit 0
npx vitest run     → 19 files, 439 passed, 0 failed
npx vitest run -t "curatorSessionId" → 18 passed (the LD1 set)
```

## Blast radius

Additive only — every change is a new *optional* field or a conditional render branch. Existing
callers (`main/index.ts` `heartbeatCuratorClaim({phase:"spawned"})`, `janitor/run-tick.ts`
`parseCuratorClaim`, `createBeforeExitHandler`) are unchanged and unaffected. `janitor/run-tick.ts`
has its own distinct `TickResult` interface — no collision.

## Co-worker note

This is a shared worktree (`pi-curator.wt/observability`). Concurrent changes present in the tree
belong to other sessions and were **not** touched by me:
- red-sessionid: all `.test.ts` RED tests (unchanged — GREEN must not modify tests).
- green-d11: `src/janitor/run-tick.ts`, `src/main/index.ts`, `src/main/spawn-args.ts`, `flow/progress/green-d11.md`.
