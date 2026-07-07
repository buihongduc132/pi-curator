# Runtime built — `add-curator-signal` runtime + `curator-runtime` heartbeat

> Doer: builder-runtime
> Date: 2026-07-07

## Deliverables (4 files, all compile + pass)

| File | LOC | Tests | Status |
|---|---:|---:|:---:|
| `src/runtime/signal-main.ts` | ~370 | — | ✅ |
| `src/runtime/signal-main.test.ts` | — | 29 | ✅ |
| `src/runtime/heartbeat.ts` | ~290 | — | ✅ |
| `src/runtime/heartbeat.test.ts` | — | 28 | ✅ |

**Total: 57 new tests, all green. Runtime files: 0 typecheck errors.**

## What landed

### `signal-main.ts` — curator-side `signal_main` tool (REQ-SG-01/02/07/08)
- `buildSignalPayload(kind, message, mainSessionId, opts)` — pure; builds the
  REQ-SG-02 intercom payload (`to`, `customType:"curator_signal"`, prefixed
  `content`, structured `details`).
- `applySeverityRouting(kind, severity)` — pure REQ-SG-08 (critical→steer).
- `normalizeKind` / `normalizeSeverity` / `buildContent` — pure validators.
- `writeFindingsFallback(dir, record)` + `resolveFindingsPath` +
  `formatFallbackLine` — REQ-SG-07/08 fallback JSONL writer (frozen contract
  with `curator-receiver.ts`).
- `createSignalMainTool(deps, identity)` — factory returning a pi-tool-shaped
  object; `execute` retries once on broker failure then falls back to file,
  never throws to the LLM (always returns `SignalResult`).

### `heartbeat.ts` — curator-runtime heartbeat + phase FSM (curator-runtime spec)
- `nextPhase(current, event)` — pure phase FSM: `spawned→scanning→signaling→done`.
- `tickHeartbeat(state, opts)` — pure tick math (first tick → scanning).
- `startHeartbeat(opts)` — thin `setInterval` adapter; first tick immediate,
  in-flight guard (skip overlap, REQ-CR), swallows write failures (REQ-CR no
  crash), halts on `not_owner`/`missing` (slot reclaimed).
- `createBeforeExitHandler(...)` — non-throwing `phase:"done"` writer
  (REQ-CR beforeExit non-throwing).

## D-H10 compatibility

The locked decision D-H10 is "no custom signal_main tool" (prose prompt +
stock intercom tool; receiver recovers kind from `[STEER]`/`[APPEND]` body
prefix per T0-Q4). This module provides the OPTIONAL structured tool. To stay
receiver-compatible under EITHER path, `buildContent` prepends the kind prefix
— so the receiver's prefix-recovery (REQ-SG-04) works whether the curator used
this tool or the prose-prompt path. Documented in the file header.

## Scope kept (no scaffold edits)

Did NOT touch `package.json`, `tsconfig.json`, `vitest.config.ts`,
`package-lock.json`, or any foundation file. All 4 files are new under
`src/runtime/`.

## Callsout

- [CA1] **RESOLVED** (2026-07-07): the janitor typecheck failure I flagged
  is now fixed. Root cause: `| undefined` in `opts.kill` made the
  `as unknown as (pid, signal: 0) => void` cast unsound. Fix: provide
  `process.kill` default before casting (`src/janitor/run-tick.ts` lines
  92 + 142). No logic change; tests stay green. Repo-wide `tsc --noEmit`
  now exit 0.
- [CA2] `createSignalMainTool` returns a plain JS object shaped like a pi tool;
  the `@ts-nocheck` adapter that glues it into pi's `ExtensionAPI.registerTool`
  is intentionally NOT in this file (would couple to pi types). That adapter
  belongs in `src/runtime/index.ts` (the runtime extension entry), which is
  out of scope for this task — flag for follow-up.

## Addendum (2026-07-07): cross-cutting completion

After all 4 builders landed, I (builder-runtime) did two additional pieces to
unblock the full `#2` deliverable:

### A. Janitor typecheck fix (`src/janitor/run-tick.ts`)
builder-lifecycle's progress note claimed typecheck clean, but `tsc --noEmit`
still failed (2 TS2352 errors). Fixed: provide `process.kill` default before
the `signal: 0` cast. No logic change; tests stay green. Repo-wide typecheck
now exit 0.

### B. T11 default personas + docs (REQ-CF-10)
- `defaults/curators.json` — reference `spec` + `scold` personas (valid JSON).
- `defaults/goals/spec.md` — spec-checker goal prompt.
- `defaults/goals/scold.md` — scold goal prompt.
- `USAGE.md` — persona schema, add-persona, signal semantics, debug stale,
  fallback file.
- `SETUP.md` — pm2 janitor install per-project.

## Final state (repo-wide)
- `npx vitest run` → **371/371 passed** (15 files).
- `npx tsc --noEmit` → **exit 0** (clean).
- All 4 capabilities have real, tested implementations + default personas.

## Remaining (NOT mine — flagged for leader)
- T9 `/curator list|status|kill|restart|reload` slash commands (lifecycle
  lane; pi ExtensionAPI coupling).
- T12 E2E integration tests (require live `pi` binary).
- T13 verifier-loop cross-agent review.
