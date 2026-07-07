# builder-lifecycle — built (2026-07-07)

## Deliverables

| File | Role |
|------|------|
| `src/main/spawn-gate.ts` | Pure spawn-gate logic (REQ-LC-01): `turnsSinceLastSpawn >= everyTurns OR minsSinceLastSpawn >= everyMins` |
| `src/main/spawn-args.ts` | Builds `pi --fork <filtered.jsonl> --append-system-prompt <goalFile> [--model] [--exclude-tools\|--tools]` argv (REQ-LC-04) |
| `src/main/index.ts` | Thin pi extension adapter: `turn_end` hook → config → gate → filter+trim → claim → spawn → pids update → ui.setStatus (REQ-LC-01..10, non-blocking) |
| `src/janitor/run-tick.ts` | Pure stateless janitor tick (REQ-LC-08): sweep dead pids (SIGTERM + archive), GC forks older than forkTTL |
| `src/janitor/pi-curator-janitor.ts` | Janitor entry point (pm2 ecosystem config) |
| `src/main/spawn-gate.test.ts` | 7 tests |
| `src/main/spawn-args.test.ts` | 13 tests |
| `src/janitor/run-tick.test.ts` | 6 tests |

## Test result

```
src/main/spawn-gate.test.ts   ✓  7 tests
src/main/spawn-args.test.ts   ✓ 13 tests
src/janitor/run-tick.test.ts  ✓  6 tests
```

## Notes

- Fixed 2 `tsc` typecheck errors in `run-tick.ts` (Signals vs `0` cast) — exit 0 clean.
- All pure helpers; `index.ts` is `@ts-nocheck` adapter (pi ExtensionAPI is heavy).
- No progress note was written during build; this file retroactively documents the deliverables.
