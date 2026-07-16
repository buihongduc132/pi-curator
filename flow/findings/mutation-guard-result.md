# pi-curator mutator-guard enrollment result

> Last re-run: 2026-07-16 (against main `811819c`, post production-wiring fix PR #3 + REQ-SG-08 routing).
> Tool: stryker (mutator-guard sidecar at `.mutator-rules/stryker/`).

**enrolled:** Y

**score:** 74.11% (detectable-only; stryker headline 63.95% incl. NoCoverage)

**states:** killed=1623 survived=553 timeout=14 error=0 ignored=1057

**threshold:** 95% (break: 95, low: 95, high: 95) — FAILED below threshold.

**normalized report:** `components/mutator-guard/reports/pi-curator/typescript/mutation.json` (in guard-orches)
**raw stryker report:** `reports/mutation/mutation.json`

## Per-file summary (survivors descending)

| file | score | killed | survived | survivors |
|------|------:|-------:|---------:|----------:|
| `src/util/config.ts` | 76.24 | 215 | 59 | 67 |
| `src/util/filter-session.ts` | 68.75 | 132 | 58 | 60 |
| `src/main/index.ts` | 52.73 | 58 | 52 | 52 |
| `src/runtime/index.ts` | 35.80 | 29 | 52 | 52 |
| `src/curator-receiver/curator-receiver.ts` | 69.82 | 118 | 51 | 51 |
| `src/util/trim-session.ts` | 74.86 | 131 | 43 | 44 |
| `src/janitor/pi-curator-janitor.ts` | 46.48 | 33 | 37 | 38 |
| `src/util/fs-lock.ts` | 55.00 | 33 | 25 | 27 |
| `src/crosscheck/crosscheck.ts` | 77.78 | 84 | 24 | 24 |
| `src/runtime/heartbeat.ts` | 72.73 | 64 | 24 | 24 |
| `src/janitor/run-tick.ts` | 77.32 | 75 | 22 | 22 |
| `src/util/team-attach-claim.ts` | 88.89 | 144 | 18 | 18 |
| `src/curator-receiver/index.ts` | 33.33 | 8 | 16 | 16 |
| `src/crosscheck/finding.ts` | 86.41 | 89 | 14 | 14 |
| `src/crosscheck/mailbox.ts` | 56.25 | 18 | 14 | 14 |
| `src/runtime/signal-main.ts` | 86.67 | 91 | 14 | 14 |
| `src/main/slash-commands.ts` | 90.48 | 114 | 12 | 12 |
| `src/util/staleness.ts` | 88.89 | 48 | 6 | 6 |
| `src/main/spawn-args.ts` | 90.74 | 49 | 5 | 5 |
| `src/main/spawn-gate.ts` | 90.70 | 39 | 4 | 4 |
| `src/util/heartbeat-lease.ts` | 94.44 | 51 | 3 | 3 |
| **TOTAL** | | | **553** | **553** |

## Status

- ✅ Enrollment + sidecar deploy + config committed (mutator-guard branch `enroll/pi-curator`, guard-orches branch `enroll/pi-curator-mutation` — NOT merged to either main, left for review).
- ✅ Mutation test runs clean (481/481 baseline green; initial dry run succeeds).
- ⚠️ **Score 74.11% — below 95% threshold.** 553 survivors concentrated in 6 files (~330 survivors).
- 🔄 Survivor remediation in progress (delegated — see "Remediation plan" below).

## Remediation plan (priority order — highest survivor count first)

Targeted test additions to kill survivors, file by file. Each entry = a focused RED→GREEN pass.

1. `src/util/config.ts` (67) — config merge/validation edge cases, defaults, alias rules.
2. `src/util/filter-session.ts` (60) — branch walk, thinking-strip, entry-type discard, malformed-line skip.
3. `src/main/index.ts` (52) — handleTurnEnd wiring (spawn, env, restart-marker, goalContents, error paths).
4. `src/runtime/index.ts` (52) — runtime entry wiring (identity, heartbeat setup, REQ-CR-06, beforeExit).
5. `src/curator-receiver/curator-receiver.ts` (51) — processIncoming paths, severity routing, buildSendMessage.
6. `src/util/trim-session.ts` (44) — budget compute, greedy fill, cut-point, turn-atomicity.
7. `src/janitor/pi-curator-janitor.ts` (38) + `src/janitor/run-tick.ts` (22) — tick phases, GC, aggregation.
8. `src/util/fs-lock.ts` (27) — withLock, atomicWrite contention/stale.
9. `src/crosscheck/*` (62 across 4 files) — cross-check protocol, mailbox, finding dedup.
10. `src/runtime/heartbeat.ts` (24) — tick loop, phase transitions, not_owner/missing.

> Full per-survivor detail (line + mutator + replacement) lives in the stryker raw report `reports/mutation/mutation.json` → `byFile[].survivors[]` and the normalized report.
