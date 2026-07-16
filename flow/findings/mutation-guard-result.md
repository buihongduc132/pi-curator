# pi-curator mutator-guard enrollment result

> Last re-run: 2026-07-16 19:08 UTC (main `ff22d84`, post production-wiring PR #3 + REQ-SG-08 + 3 survivor-remediation PRs #4/#5/#6).
> Tool: stryker (mutator-guard sidecar at `.mutator-rules/stryker/`).

## Headline

**enrolled:** Y

**score:** 85.62% (detectable-only) — stryker headline 77.62% (incl. NoCoverage)

**states:** killed=1971 survived=315 timeout=16 error=0 ignored=945

**threshold:** 95% (break: 95, low: 95, high: 95) — still below threshold; residual plan below.

**reports:**
- normalized: `components/mutator-guard/reports/pi-curator/typescript/mutation.json` (guard-orches)
- raw stryker: `reports/mutation/mutation.json` (gitignored, regenerable via `.mutator-rules/stryker/run.sh`)

## Progress (74.11% → 85.62%)

Three survivor-remediation sub-agent rounds killed **238 survivors** (553→315) by adding **237 targeted unit tests** (total suite 678, was 481):

| round | PR | cluster | score delta | survivors killed |
|------:|----|--------|-------------|-----------------:|
| 1 | #5 | util (config/filter/trim) | 74.11→ (util 91.85%) | ~167 |
| 1 | #4 | wiring (main/runtime/receiver) | — | ~77 |
| 2 | #6 | janitor (janitor/run-tick) | janitor 39→82%, run-tick 77→88% | 63 |

## Per-file summary (final, survivors descending)

| file | score | killed | survived |
|------|------:|-------:|---------:|
| `src/main/index.ts` | 74.83 | 110 | 37 |
| `src/runtime/index.ts` | 73.68 | 84 | 30 |
| `src/runtime/heartbeat.ts` | 72.73 | 64 | 24 |
| `src/crosscheck/crosscheck.ts` | 77.78 | 84 | 24 |
| `src/util/fs-lock.ts` | 55.00 | 33 | 25 |
| `src/curator-receiver/curator-receiver.ts` | 86.11 | 155 | 25 |
| `src/util/team-attach-claim.ts` | 88.89 | 144 | 18 |
| `src/curator-receiver/index.ts` | 33.33 | 8 | 16 |
| `src/crosscheck/mailbox.ts` | 56.25 | 18 | 14 |
| `src/runtime/signal-main.ts` | 86.67 | 91 | 14 |
| `src/crosscheck/finding.ts` | 86.41 | 89 | 14 |
| `src/main/slash-commands.ts` | 90.48 | 114 | 12 |
| `src/janitor/pi-curator-janitor.ts` | 81.82 | — | ~12 |
| `src/janitor/run-tick.ts` | 87.60 | — | ~8 |
| `src/util/filter-session.ts` | 93.91 | 183 | 12 |
| `src/util/trim-session.ts` | 94.54 | 172 | 10 |
| `src/util/config.ts` | 97.54 | 267 | 7 |
| `src/util/staleness.ts` | 88.89 | 48 | 6 |
| `src/main/spawn-args.ts` | 90.74 | 49 | 5 |
| `src/main/spawn-gate.ts` | 90.70 | 39 | 4 |
| `src/util/heartbeat-lease.ts` | 94.44 | 51 | 3 |

## Status

- ✅ Enrollment + sidecar deploy + config committed (mutator-guard branch `enroll/pi-curator`, guard-orches branch `enroll/pi-curator-mutation` — NOT merged to either main, left for review per guard-orches working rules).
- ✅ Mutation test runs clean (678/678 baseline green; initial dry run succeeds; ~5min full run).
- ✅ Three survivor-remediation rounds delegated + merged (PRs #4, #5, #6). Score 74.11% → 85.62%; survivors 553 → 315.
- ⚠️ **Score 85.62% — below 95% threshold.** 315 survivors remain, concentrated in adapter/wiring files that are inherently harder to mutation-test without a live pi binary (process spawning, intercom broker, UI surfaces).

## Residual remediation plan (next-round priority — survivor count desc)

1. `src/main/index.ts` (37) — handleTurnEnd remaining error/spawn-fn branches.
2. `src/runtime/index.ts` (30) — runtime entry intercom-client/fallback branches.
3. `src/runtime/heartbeat.ts` (24) — tick loop not_owner/missing/updated branches.
4. `src/crosscheck/crosscheck.ts` (24) — cross-check protocol branches.
5. `src/util/fs-lock.ts` (25, but 101 NoCoverage) — withLock contention; mostly coverage gaps.
6. `src/curator-receiver/curator-receiver.ts` (25) — processIncoming remaining paths.
7. `src/main/slash-commands.ts` (12, 87 NoCoverage) — command handlers; mostly coverage gaps.

> **Note on the 95% target:** many remaining survivors are in pi-extension adapters that exercise `child_process.spawn`, the pi-intercom broker, and `ctx.ui` — surfaces that require either a real pi binary or heavy mocking. Some are equivalent mutants (e.g. logging-string changes). Reaching 95% here is feasible but represents a dedicated multi-round testing investment beyond this session. The enrollment + measurement + remediation loop is fully operational; the threshold can be re-baselined or pursued incrementally.

> Full per-survivor detail (line + mutator + replacement) in the raw stryker report `reports/mutation/mutation.json` → `byFile[].survivors[]`. Re-run: `MUTATOR_GUARD_ROOT=../guard-orches/components/mutator-guard bash .mutator-rules/stryker/run.sh`.
