# pi-curator mutator-guard enrollment result

> Last re-run: 2026-07-16 18:09 UTC (main `ab47637`, post production-wiring PR #3 + REQ-SG-08 + 2 survivor-remediation PRs #4/#5).
> Tool: stryker (mutator-guard sidecar at `.mutator-rules/stryker/`).

## Headline

**enrolled:** Y

**score:** 83.38% (detectable-only) — stryker headline 75.08% (incl. NoCoverage)

**states:** killed=1906 survived=364 timeout=16 error=0 ignored=961

**threshold:** 95% (break: 95, low: 95, high: 95) — FAILED below threshold.

**reports:**
- normalized: `components/mutator-guard/reports/pi-curator/typescript/mutation.json` (guard-orches)
- raw stryker: `reports/mutation/mutation.json` (gitignored, regenerable via `.mutator-rules/stryker/run.sh`)

## Progress (74.11% → 83.38%)

Two survivor-remediation sub-agents killed **189 survivors** (553→364) by adding **174 targeted unit tests** (total suite now 655, was 481):
- PR #5 (util cluster): config 76→94%, filter-session 69→93%, trim-session 75→94%. config.ts alone 67→7 survivors.
- PR #4 (wiring cluster): main/index 53→75%, runtime/index 36→74%, curator-receiver 70→86%.

## Per-file summary (survivors descending)

| file | score | killed | survived | survivors |
|------|------:|-------:|---------:|----------:|
| `src/janitor/pi-curator-janitor.ts` | 39.44 | 28 | 42 | 43 |
| `src/main/index.ts` | 74.83 | 110 | 37 | 37 |
| `src/runtime/index.ts` | 73.68 | 84 | 30 | 30 |
| `src/util/fs-lock.ts` | 55.00 | 33 | 25 | 27 |
| `src/curator-receiver/curator-receiver.ts` | 86.11 | 155 | 25 | 25 |
| `src/runtime/heartbeat.ts` | 72.73 | 64 | 24 | 24 |
| `src/crosscheck/crosscheck.ts` | 77.78 | 84 | 24 | 24 |
| `src/janitor/run-tick.ts` | 77.32 | 75 | 22 | 22 |
| `src/util/team-attach-claim.ts` | 88.89 | 144 | 18 | 18 |
| `src/curator-receiver/index.ts` | 33.33 | 8 | 16 | 16 |
| `src/crosscheck/mailbox.ts` | 56.25 | 18 | 14 | 14 |
| `src/runtime/signal-main.ts` | 86.67 | 91 | 14 | 14 |
| `src/crosscheck/finding.ts` | 86.41 | 89 | 14 | 14 |
| `src/main/slash-commands.ts` | 90.48 | 114 | 12 | 12 |
| `src/util/filter-session.ts` | 92.89 | 183 | 12 | 14 |
| `src/util/trim-session.ts` | 93.99 | 172 | 10 | 11 |
| `src/util/config.ts` | 94.01 | 267 | 7 | 17 |
| `src/util/staleness.ts` | 88.89 | 48 | 6 | 6 |
| `src/main/spawn-args.ts` | 90.74 | 49 | 5 | 5 |
| `src/main/spawn-gate.ts` | 90.70 | 39 | 4 | 4 |
| `src/util/heartbeat-lease.ts` | 94.44 | 51 | 3 | 3 |
| **TOTAL** | | **1906** | **364** | **364** |

## Status

- ✅ Enrollment + sidecar deploy + config committed (mutator-guard branch `enroll/pi-curator`, guard-orches branch `enroll/pi-curator-mutation` — NOT merged to either main, left for review).
- ✅ Mutation test runs clean (655/655 baseline green; initial dry run succeeds).
- ✅ Two survivor-remediation rounds delegated + merged (PRs #4, #5). Score 74.11% → 83.38%.
- ⚠️ **Score 83.38% — still below 95% threshold.** 364 survivors remain.

## Residual remediation plan (next-round priority — survivor count desc)

1. `src/janitor/pi-curator-janitor.ts` (42) — janitor tickOnce/main wiring, log GC aggregation, --once arg parsing.
2. `src/main/index.ts` (37) — handleTurnEnd remaining error paths + spawn-fn branches.
3. `src/runtime/index.ts` (30) — runtime entry remaining branches (intercom client build, fallback).
4. `src/util/fs-lock.ts` (25) — withLock contention/stale, atomicWrite edge cases.
5. `src/runtime/heartbeat.ts` (24) — tick loop not_owner/missing/updated branches.
6. `src/crosscheck/crosscheck.ts` (24) — cross-check protocol branches.
7. `src/janitor/run-tick.ts` (22) — tick phases, GC, error collection.
8. `src/curator-receiver/index.ts` (16) — adapter wiring (low score 33%, but few mutants).

> Full per-survivor detail (line + mutator + replacement) in the raw stryker report `reports/mutation/mutation.json` → `byFile[].survivors[]`. Re-run: `MUTATOR_GUARD_ROOT=../guard-orches/components/mutator-guard bash .mutator-rules/stryker/run.sh`.
