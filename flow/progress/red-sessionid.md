# RED Phase — curatorSessionId pointer (LD1)

**Agent**: red-sessionid
**Task**: #13 — Write FAILING tests for curatorSessionId pointer (LD1)
**Date**: 2026-07-07
**Status**: ✅ COMPLETE — all 8 new tests FAIL as expected, original 413 tests still PASS.

## What was tested

LD1 locked decision: add optional `curatorSessionId` field to CuratorClaim (pids schema), write back on first curator heartbeat. Non-breaking (missing = legacy).

### Test files modified/created

| File | Action | New tests | Failing |
|------|--------|-----------|---------|
| `src/util/team-attach-claim.test.ts` | **NEW** | 7 | 1 |
| `src/runtime/heartbeat.test.ts` | Extended | 5 | 3 |
| `src/util/staleness.test.ts` | Extended | 3 | 2 |
| `src/main/slash-commands.test.ts` | Extended | 3 | 2 |
| **Total** | | **18** | **8** |

### Failing tests (RED — expected until GREEN implements)

1. **team-attach-claim**: `parseCuratorClaim preserves curatorSessionId when present in the raw JSON`
   - parseCuratorClaim strips the field (returns undefined instead of the value)

2. **heartbeat**: `tickHeartbeat accepts curatorSessionId in opts and surfaces it in the TickResult`
   - tickHeartbeat doesn't accept/pass curatorSessionId in opts

3. **heartbeat**: `tickHeartbeat carries curatorSessionId alongside a phase event`
   - Same root cause — TickResult doesn't include curatorSessionId

4. **heartbeat**: `startHeartbeat writes curatorSessionId on the first heartbeat tick`
   - startHeartbeat doesn't accept curatorSessionId option or pass it to the writer

5. **staleness**: `readPidEntries surfaces curatorSessionId when the pid file carries it`
   - parseCuratorClaim strips the field, so readPidEntries never sees it

6. **staleness**: `readPidEntries can mix legacy + pointer-bearing entries`
   - Same root cause — parseCuratorClaim drops the field

7. **slash-commands**: `formatStatusOutput includes the curatorSessionId link when the pointer is present`
   - formatStatusOutput doesn't render the pointer (no `ses_abc123` in output)

8. **slash-commands**: `formatStatusOutput renders a mix of legacy + pointer-bearing entries`
   - Same root cause — no pointer rendering

### Passing tests (already work — legacy/undefined cases)

The 10 new tests that PASS verify the non-breaking legacy behavior:
- Type accepts optional field (vitest transpile-only allows it)
- `parseCuratorClaim` returns `undefined` for absent/empty/non-string values (already correct)
- `tickHeartbeat` returns `undefined` when no id provided (already correct)
- `startHeartbeat` doesn't pass `curatorSessionId` when none provided (already correct)
- `readPidEntries` returns `undefined` for legacy entries (already correct)
- `formatStatusOutput` omits arrow for legacy entries (already correct)

## Verification

```
$ npx vitest run src/util/team-attach-claim.test.ts src/runtime/heartbeat.test.ts src/util/staleness.test.ts src/main/slash-commands.test.ts

Test Files  4 failed (4)
     Tests  8 failed | 129 passed (137)
```

All 8 failures are `expected undefined to be 'ses_...'` — the field doesn't exist yet.

## Pre-existing failures (NOT from this task)

8 additional failures in the full test run are from the `red-d11` session:
- `src/main/d11-stdio.test.ts` (6 failures — `resolveStdio` not implemented)
- `src/janitor/run-tick.test.ts` (2 failures — D11 stderr log GC not implemented)

These are tracked in `flow/progress/red-d11.md`.

## What GREEN needs to implement

To make these 8 tests pass:

1. **`CuratorClaim` interface** (`src/util/team-attach-claim.ts`): add `curatorSessionId?: string`
2. **`parseCuratorClaim`** (`src/util/team-attach-claim.ts`): extract `curatorSessionId` via `getOptionalString`
3. **`tickHeartbeat`** (`src/runtime/heartbeat.ts`): accept `curatorSessionId` in opts, include in `TickResult`
4. **`TickResult`** (`src/runtime/heartbeat.ts`): add `curatorSessionId?: string`
5. **`startHeartbeat`** (`src/runtime/heartbeat.ts`): accept `curatorSessionId` in `StartHeartbeatOpts`, pass to writer
6. **`formatStatusOutput`** (`src/main/slash-commands.ts`): render `curator:spec → ses_abc123` when pointer present

## Constraints respected

- ✅ Tests MUST FAIL — all 8 fail with clear assertion messages
- ✅ Did NOT implement the feature — only test code added
- ✅ Existing 413 tests still PASS
- ✅ Did NOT touch package.json/tsconfig/vitest.config
