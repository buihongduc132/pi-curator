# RED Phase — D11 stderr capture

**Date**: 2026-07-07
**Agent**: red-d11-stderr
**Status**: ✅ RED complete — tests written, all failing as expected

## Files Created

### `src/main/d11-stdio.test.ts` (NEW — 6 tests, all FAIL)
Tests for `resolveStdio()` — a pure function that doesn't exist yet in `spawn-args.ts`.

| # | Test | Fails Because |
|---|------|---------------|
| 1 | returns 3-element array `['ignore', Writable, Writable]` | `resolveStdio` is not exported from spawn-args |
| 2 | stdout (index 1) writes to /dev/null (discarded) | same |
| 3 | stderr (index 2) writes to resolved log path | same |
| 4 | log path format: `<logsBaseDir>/<mainSessionId>/<curator>-<ts>.stderr` | same |
| 5 | creates logs dir if it doesn't exist (mkdir -p semantics) | same |
| 6 | default logsBaseDir = `~/.pi-curator/logs` | same |

**Function signature expected by tests**:
```ts
resolveStdio(input: {
  mainSessionId: string;
  curatorAlias: string;
  nowMs: number;
  logsBaseDir?: string; // defaults to ~/.pi-curator/logs
}): [string, number, number]  // ['ignore', stdoutFd, stderrFd]
```

### `src/janitor/run-tick.test.ts` (MODIFIED — 2 new tests in `D11 stderr log GC` describe block, both FAIL)

| # | Test | Fails Because |
|---|------|---------------|
| 1 | GCs stderr log files older than forkTTL (24h) alongside fork artifacts | `logsDir` option and `logsDeleted` field don't exist in TickOptions/TickResult |
| 2 | handles missing logsDir gracefully (no errors) | same |

**Expected changes to `runTick`**:
- `TickOptions` gains `logsDir?: string`
- `TickResult` gains `logsDeleted: number`
- Phase 3: recursively walk `<logsDir>/**/*.stderr`, delete files with mtime older than `forkTTLms`

## Test Results

```
Test Files  3 failed | 16 passed (19)
     Tests  9 failed | 419 passed (428)
```

- **8 failures**: my new D11 tests (expected — RED phase)
- **1 failure**: pre-existing in `src/util/team-attach-claim.test.ts` (untracked file, someone else's RED phase work — NOT caused by my changes)
- **413 original tests**: all still PASS ✅

## Design Reference

D11 from `openspec/changes/archive/2026-06-23-add-curator-lifecycle/design.md` lines 275-289:
- stdio: `['ignore', fs.openSync('/dev/null','w'), fs.openSync('<log>','a')]`
- log path: `~/.pi-curator/logs/<mainSessionId>/<curator>-<ts>.stderr`
- janitor GCs @ 24h alongside fork artifacts

## GREEN Phase Guidance

1. **Implement `resolveStdio()`** in `src/main/spawn-args.ts`:
   - Create logs dir with `fs.mkdirSync(dir, { recursive: true })`
   - Open `/dev/null` for stdout (unix) or platform-appropriate discard
   - Open `<logsBaseDir>/<mainSessionId>/<curator>-<nowMs>.stderr` with `'a'` flag for stderr
   - Return `['ignore', stdoutFd, stderrFd]`

2. **Update `src/main/index.ts`** line ~210:
   - Replace `stdio: ["ignore","ignore","ignore"]` with `stdio: resolveStdio({...})`

3. **Extend `runTick()`** in `src/janitor/run-tick.ts`:
   - Add `logsDir` to `TickOptions`
   - Add `logsDeleted` to `TickResult`
   - Add Phase 3: walk `logsDir` recursively, GC `.stderr` files older than `forkTTLms`

## Constraints Honored

- ✅ Tests only — no implementation
- ✅ Tests FAIL initially (function doesn't exist)
- ✅ Existing 413 tests still PASS
- ✅ Used injected `nowMs` + tmp dirs for determinism
- ✅ Did not touch package.json/tsconfig/vitest.config
