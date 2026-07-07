# builder-integration — built (2026-07-07)

## Status
✅ **COMPLETE** — `npx vitest run` → **413/413 pass** (17 files). `npx tsc --noEmit` → **exit 0**.

## Deliverables

| # | File | Role |
|---|------|------|
| 1 | `src/runtime/index.ts` | Curator-side pi extension adapter. Reads identity from env (`PI_CURATOR_*`), registers `signal_main` tool via `createSignalMainTool`. Non-blocking: missing identity → tool not registered + UI notify; missing intercom → falls back to findings file. REQ-SG-01, D-H10-compatible. |
| 2 | `src/main/slash-commands.ts` | `/curator list\|status\|kill\|restart\|reload\|help` (REQ-LC-09). Pure `parseCommand(input)→{cmd,args}` + behavioral helpers (`killCurator`, `restartCurator`, `formatListOutput`, `formatStatusOutput`, `formatHelp`) + thin `registerSlashCommands(pi)` adapter. All exceptions caught (REQ-LC-10). |
| 3 | `src/main/slash-commands.test.ts` | 38 tests: parseCommand (valid/unknown/empty/alias-validation/arg-count), formatListOutput, formatStatusOutput, formatHelp, killCurator (kill/already_dead/no_claim/error), restartCurator (kill+counter-reset/no-claim/error-propagation). |
| 4 | `defaults/curators.json` | Default personas: `spec` (spec-checker, every 5 turns) + `scold` (scold, every 3 turns). Schema matches `CuratorConfigFile` (curators + janitor with interval/forkTTL/staleSec/deadSec). REQ-CF-10. |
| 5 | `defaults/goals/spec.md` | Spec-checker persona goal: review against openspec REQs, flag out-of-scope/incomplete-claims/drift. steer vs append guidance. |
| 6 | `defaults/goals/scold.md` | Scold persona goal: HARD-rule enforcement (AGENTS.md violations, never-strip-instead-of-fix, deploy hygiene, timeout violations). |
| 7 | `package.json` | `pi.extensions` updated: added `src/main/index.ts`, `src/main/slash-commands.ts`, `src/runtime/index.ts` alongside existing `src/curator-receiver/index.ts`. |
| 8 | `src/integration/e2e-smoke.test.ts` | 4 T12 integration tests: full pipeline composition (config→filter→trim→gate→args), tight-budget truncation, mutual-exclusion validation flagging, spawn-gate cadence. Pure (no real pi binary). |

## New tests added: 42 (38 slash + 4 e2e)

## Full repo test summary
```
17 test files, 413 tests, all passing.
- curator-receiver: 34 (pre-existing)
- util/filter-session: 35 (foundation)
- util/trim-session: 41 (foundation)
- util/staleness: 53 (foundation)
- util/config: 55 (foundation)
- runtime/signal-main: 29 (runtime)
- runtime/heartbeat: 28 (runtime)
- crosscheck/finding: 29 (crosscheck)
- crosscheck/mailbox: 12 (crosscheck)
- crosscheck/crosscheck: 29 (crosscheck)
- main/spawn-gate: 7 (lifecycle)
- main/spawn-args: 13 (lifecycle)
- janitor/run-tick: 6 (lifecycle)
- main/slash-commands: 38 (integration — NEW)
- integration/e2e-smoke: 4 (integration — NEW)
```

## Notes
- `src/runtime/index.ts` + `src/main/slash-commands.ts` + `src/main/index.ts` are `@ts-nocheck` adapters (pi ExtensionAPI types are heavy); all behavioral logic is in pure, tested helpers.
- Kill/restart slash commands write a "restart-marker" file for the main hook to pick up on next `turn_end` (the closure-scoped `lastSpawn` map can't be reached from the slash handler).
- D-H10 compatibility preserved: the runtime adapter's `signal_main` tool prepends `[STEER]`/`[APPEND]` prefixes so the receiver recovers the kind under EITHER the structured-tool or prose-prompt path.
