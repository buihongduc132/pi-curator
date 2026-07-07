# GREEN Phase — D11 stderr capture

**Date**: 2026-07-07
**Agent**: green-d11-stderr
**Task**: #14
**Status**: ✅ GREEN complete — all 8 D11 RED tests now pass

## Scope

Implemented design decision **D11** (stderr → logs, stdout → /dev/null) per
`openspec/changes/archive/2026-06-23-add-curator-lifecycle/design.md` lines 275–289.
RED tests written by `red-d11-stderr` (sibling agent) define the contract.

## Files Modified (source only — NO test files touched)

### 1. `src/main/spawn-args.ts` (+57)

Added `resolveStdio(input)` — a pure function returning `['ignore', stdoutFd, stderrFd]`:

- **stdout** (index 1): `fs.openSync(os.devNull, 'w')` — platform null device
  (`/dev/null` on unix, `nul` on windows). Discarded; curators signal findings
  via `signal_main`, not stdout.
- **stderr** (index 2): `fs.openSync(<logPath>, 'a')` — append mode.
- **log path**: `<logsBaseDir>/<mainSessionId>/<curatorAlias>-<nowMs>.stderr`.
- **default logsBaseDir**: `~/.pi-curator/logs`.
- **mkdir -p**: `fs.mkdirSync(logDir, { recursive: true })` before opening stderr.

Signature:
```ts
export interface ResolveStdioInput {
  mainSessionId: string;
  curatorAlias: string;
  nowMs: number;
  logsBaseDir?: string; // defaults to ~/.pi-curator/logs
}
export function resolveStdio(input): ["ignore", number, number]
```

### 2. `src/main/index.ts` (+7/-3)

Replaced `stdio: ["ignore", "ignore", "ignore"]` in the `spawn()` call with:
```ts
stdio: resolveStdio({ mainSessionId, curatorAlias: persona.alias, nowMs: Date.now() }),
```
Uses default logsBaseDir (`~/.pi-curator/logs`).

### 3. `src/janitor/run-tick.ts` (+84)

- `TickResult` gained `logsDeleted: number`.
- `TickOptions` gained `logsDir?: string`.
- Added **Phase 3: GC old stderr logs (D11)** — recursively scans `logsDir`
  for `*.stderr` files (session subdirs: `<logsBaseDir>/<sessionId>/*.stderr`),
  deletes those with `mtime > forkTTLms` (same 24h TTL as fork GC), counts them.
- Missing/unreadable `logsDir` is a no-op (never throws, no errors collected).
- Added private helper `collectLogFiles(root)` for the recursive walk.

## Verification

| Check | Result |
|-------|--------|
| `npx vitest run src/main/d11-stdio.test.ts` | ✅ 6/6 pass |
| `npx vitest run src/janitor/run-tick.test.ts` | ✅ 8/8 pass (incl. 2 new log GC) |
| `npx vitest run src/main/spawn-args.test.ts` | ✅ 13/13 pass (no regressions) |
| `npx tsc --noEmit` | ✅ exit 0 |
| Full suite | 431 pass / 8 fail (see Note) |

## Note — out-of-scope failures

The full suite reports **8 failures**, all tagged **LD1 / `curatorSessionId`**
(`red-sessionid`, task #13 — a sibling agent's RED tests awaiting their own GREEN).
They live in `team-attach-claim.test.ts`, `heartbeat.test.ts`, `staleness.test.ts`,
`slash-commands.test.ts` — files D11 does **not** touch. The task brief's
"16 previously-failing" = 8 D11 (mine, now green) + 8 LD1 (another agent).
Baseline 423 + 8 D11 = 431 passing.

**Test files were NOT modified by this agent** — `run-tick.test.ts` shows as `M`
only because of `red-d11-stderr`'s earlier additions (verified: 58 insertions, 0
deletions, no green-agent edits).
