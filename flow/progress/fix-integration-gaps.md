# FIX — integration gaps found by verifier

**Date**: 2026-07-07
**Agent**: fix-integration-gaps
**Task**: #18
**Status**: ✅ COMPLETE — both production-wiring gaps fixed; full suite 447/447 PASS; `tsc --noEmit` exit 0.

## Verifier rejection (round 1) — root causes

Two GREEN-phase features (D11 log GC from `green-d11`, LD1 `curatorSessionId` pointer
from `green-sessionid`) were implemented and unit-tested at the **pure helper** layer
but were **dead code in production**: the production entry points never invoked them.

| # | Gap | Symptom |
|---|-----|---------|
| 1 | D11 log GC never runs | `pi-curator-janitor.ts` `tickOnce()` called `runTick()` **without `logsDir`**, so Phase 3 (stderr log GC) was skipped every tick. `logsDeleted` was always 0 in prod. |
| 2 | `curatorSessionId` (LD1) never written | `runtime/index.ts` extension entry **never called `startHeartbeat()`**, so the heartbeat loop never started, the claim file was never refreshed after the main-side `phase:"spawned"` seed, and the LD1 pointer was never stamped on the claim. |

Both fixes are **production wiring only** — no behavioral logic changed, no pure
helpers touched, no existing tests modified.

## Fix 1 — wire `logsDir` through the janitor entry

**File**: `src/janitor/pi-curator-janitor.ts`

- `tickOnce()` gained an optional `logsDir` parameter, threaded into every
  `runTick()` call's options. `runTick` treats a missing/unreadable `logsDir`
  as a no-op, so this is purely additive.
- Aggregated `logsDeleted` across all session dirs and **surfaced it** in the
  tick summary `console.log`:
  `swept=N forksDeleted=N logsDeleted=N live=N`.
- `main()` now derives `logsDir = args["logs-dir"] || path.join(root, "logs")`
  — default `~/.pi-curator/logs`, the **same `logsBaseDir`** the spawn hook
  (`spawn-args.ts` D11) writes stderr into. Overridable via `--logs-dir` for
  ops/debugging (consistent with the existing `--pids-dir`/`--forks-dir`/`--archive-dir`).

## Fix 2 — wire `startHeartbeat()` into the runtime extension entry

**File**: `src/runtime/index.ts`

After `readCuratorIdentity()` succeeds and the `signal_main` tool is registered,
the entry now:

1. Builds the claim file path via the **shared** helpers
   `curatorClaimFile(defaultPidRoot(), mainSessionId, curatorAlias)` — the exact
   path the main spawn hook wrote (`pids/<mainSessionId>/<curator>.json`), so
   the curator's heartbeats update the SAME claim (ownership matches via
   `process.pid` == the `child.pid` main stamped).
2. Reads the curator's own session id from the pi context
   (`ctx.sessionId ?? ctx.session.id`) — this is the **LD1 pointer**.
3. Calls `startHeartbeat({ pidsFile, pid: process.pid, curatorSessionId, onError })`.
   The loop refreshes the claim every `intervalSec` (default 5s); write failures
   are swallowed (REQ-CR) and surfaced via UI notify.
4. Registers the terminal `beforeExit` handler (`createBeforeExitHandler`) on
   `process.on("beforeExit")` so the curator stamps `phase:"done"` as its last
   act (REQ-CR "Curator sets done before exit"), letting the staleness detector
   free the slot immediately.

All inside the existing REQ-SG-09 try/catch — heartbeat setup failure never
blocks the curator session from loading. When the identity env vars are absent
(manual/test session), the heartbeat is correctly **not** started.

## New integration tests

These exercise the **production entry paths** end-to-end (NOT unit tests of the
pure helpers).

### `src/janitor/pi-curator-janitor.test.ts` (+3 tests)
Drives the real `main(["--once", "--logs-dir", ...])` ops entry (the exact path
pm2 invokes):
- **GCs stderr logs via the production path**: creates real old/fresh
  `<logsDir>/<sessionId>/*.stderr` files, asserts the stale one is `unlink`ed and
  the fresh one survives, AND asserts `logsDeleted=1` surfaces in the tick
  `console.log` (Fix 1 surfacing proof).
- **logsDeleted=0** when the logs dir is empty (surfacing still present).
- **default `logsDir`** computed when `--logs-dir` omitted (no crash;
  `logsDeleted=\d+` surfaced regardless of value).

### `src/runtime/index.test.ts` (+5 tests)
Exercises the real `curatorRuntimeExtension(pi, ctx)` entry. Mocks
`./heartbeat.js` (`vi.mock`) so no real `setInterval`/fs write fires, then
asserts on the **wiring**:
- `startHeartbeat` called **with `curatorSessionId` from `ctx.sessionId`** (LD1).
- claim file path resolves to `~/.pi-curator/pids/<mainSessionId>/<curator>.json`.
- falls back to `ctx.session.id` when `ctx.sessionId` is absent.
- `createBeforeExitHandler` called with the claim file + `process.pid`, and the
  handler registered on `process.on("beforeExit", ...)` (REQ-CR done-write).
- heartbeat **NOT** started when curator identity env is absent.

`process.on` is spied (`vi.spyOn`) to capture the `beforeExit` registration
without leaking a real listener; restored in `afterEach`. Env vars are isolated
(saved/restored) so the curator identity never leaks across suites.

## Verification

```
npx vitest run  → 21 files, 447 passed, 0 failed  (439 baseline + 8 new)
npx tsc --noEmit → exit 0
```

Per-file:
- `src/janitor/pi-curator-janitor.test.ts` → 3/3
- `src/runtime/index.test.ts` → 5/5
- all existing suites green (no regressions)

## Files changed

| File | Change |
|------|--------|
| `src/janitor/pi-curator-janitor.ts` | `tickOnce` +logsDir param + logsDeleted aggregation/surfacing; `main` +logsDir default (`~/.pi-curator/logs`) + `--logs-dir` override |
| `src/runtime/index.ts` | import `startHeartbeat`/`createBeforeExitHandler`/`curatorClaimFile`/`defaultPidRoot`; call `startHeartbeat({pidsFile, pid, curatorSessionId})` + register `beforeExit` done-write |
| `src/janitor/pi-curator-janitor.test.ts` | NEW — integration test of production janitor entry (log GC end-to-end) |
| `src/runtime/index.test.ts` | NEW — integration test of runtime extension entry (heartbeat wiring) |

No pure-helper or existing-test files were modified.

## Blast radius

Additive only. Both fixes wire EXISTING, already-unit-tested helpers into the
production entry points. `runTick`'s Phase 3 was already implemented + tested
(green-d11); `startHeartbeat`/`tickHeartbeat`'s `curatorSessionId` plumbing was
already implemented + tested (green-sessionid). This change connects them to
their callers — it does not alter their behavior.
