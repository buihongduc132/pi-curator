# Foundation Built — pi-curator (task #5)

**Status:** ✅ COMPLETE — `npm run typecheck` clean (exit 0), `npm test` 218/218 passed.
**Builder:** builder-foundation
**Date:** 2026-07-07

## Test output (final)

```
 ✓ src/curator-receiver/integration-smoke.test.ts (3 tests)   ← pre-existing
 ✓ src/curator-receiver/verification.test.ts   (5 tests)      ← pre-existing
 ✓ src/curator-receiver/curator-receiver.test.ts (26 tests)   ← pre-existing
 ✓ src/util/filter-session.test.ts (35 tests)   ← T2 NEW
 ✓ src/util/trim-session.test.ts   (41 tests)   ← T2 NEW
 ✓ src/util/staleness.test.ts      (53 tests)   ← T3 NEW (heartbeat-lease + team-attach-claim + staleness)
 ✓ src/util/config.test.ts         (55 tests)   ← T4 NEW
 Test Files  7 passed (7)
      Tests  218 passed (218)
```

**Foundation tests (T2/T3/T4): 184 passing.** Total repo: 218 passing. Zero runtime deps
(util files use only `node:fs`/`node:path`/`node:os`/`node:crypto`).

## Deliverables

### 1. Package scaffold (`package.json`, `tsconfig.json`, `vitest.config.ts`)
- `@buihongduc132/pi-curator`, type module, `pi.extensions: ["src/curator-receiver/index.ts"]`.
- scripts: `test` (vitest run), `typecheck` (tsc --noEmit). devDeps: typescript, vitest, @types/node.
- tsconfig: strict, ES2022, NodeNext moduleResolution.

### 2. T2 — `src/util/filter-session.ts` (+ test, 35 tests)
- Active-branch-only walk (leaf→root via parentId, cycle-guarded).
- Drops `thinking` blocks (opt-in `includeThinking`), PRESERVES `compaction`.
- Keeps `message`/`custom_message`/`branch_summary`; drops `session_info`/`model_change`/
  `thinking_level_change`/`label`/`custom`. Malformed lines skipped (REQ-LC-10).

### 3. T2 — `src/util/trim-session.ts` (+ test, 41 tests)
- `estimateTokens` mirrors pi core `chars/4` exactly (verified vs compaction.js).
- Greedy backward fill ≤ budget; cut at earliest valid cut point; NEVER cuts at `toolResult`
  (turn atomicity). `computeBudget` = 0.9*window − reserve. 60%-recent soft target documented.

### 4. T3 — `src/util/{heartbeat-lease,team-attach-claim,staleness,fs-lock}.ts` (+ test, 53 tests)
- Vendored+adapted from pi-agent-teams (per-curator JSON file vs members[] array).
- 3-class liveness: live ≤30s / stale 30–120s / dead >120s; optional `process.kill(pid,0)`
  fast-path (injectable for tests). Atomic write + `withLock` for concurrent main/runtime/janitor.

### 5. T4 — `src/util/config.ts` (+ test, 55 tests)
- Loads `~/.pi-curator/curators.json` (global, JSONC) + `<root>/.pi-curator/curators.json`.
- Deep-merge defaults←global←project; personas keyed by alias (field-by-field, not replace).
- `enabled:false` disables; validation non-blocking (alias required, excludeTools/tools
  mutually-exclusive = error → persona disabled). cwd-change cache invalidation.

## Notes for downstream builders

- **All util functions are pure** (take `nowMs`/`fileExists`/`kill` as injected args) → fully
  unit-testable without fs/processes. Import types from each module; `.js` extensions used in
  inter-module imports (NodeNext requirement, works with vitest).
- **Pre-existing `curator-receiver.ts` type bug fixed** (root cause, not stripped): the
  `"message" in event ? event.message : event` ternary didn't narrow the union under strict TS;
  added a typed `extractMessage` helper. It was never typechecked before (repo had no tsconfig).
- **Shared types**: `CuratorPidEntry` (== `CuratorClaim`) is the PID-file shape
  `{pid, mainSessionId, mainSessionName, curator, spawnedAt, heartbeatAt, phase, goalFile}`
  — use this contract for spawn hook (T5) ↔ runtime (T7/T8) ↔ janitor (T10).
- **estimateTokens contract**: trim-session re-exports the chars/4 math; spawn hook (T5) should
  call `computeBudget(contextWindow)` then `trimSessionEntries(filtered, {budget})`.
