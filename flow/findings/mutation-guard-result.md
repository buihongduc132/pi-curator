# pi-curator mutator-guard enrollment result

> Last re-run: 2026-07-17 00:13 UTC (main `583ccbf`, 1006 tests, post 9 survivor-remediation PRs #4-#14).
> Tool: stryker (mutator-guard sidecar at `.mutator-rules/stryker/`).

## Status: BLOCKED on 95% threshold — needs user decision

**enrolled:** Y (config landed in mutator-guard main via mutator-guard PR #29, MERGED)

**score:** 88.43% headline (88.83% normalized) — **below the 95% break threshold**

**states:** killed=2434 survived=287 timeout=19 ignored(NoCoverage)=820

After NINE delegated survivor-remediation rounds (PRs #4-#14), the score plateaued then REGRESSED from 91.15% to 88.43%. Two root causes identified (see "Why 95% is blocked" below). Reaching 95% requires either user approval to lower the threshold OR a dedicated stryker-toolchain investigation. This is escalated as a goal blocker.

## Why 95% is blocked (root-cause analysis)

1. **New code keeps entering main without tests.** PR #12 (another session) merged `feat(observability): OTel-compatible structured logging` adding `src/util/logger.ts` (67 mutants, 18 survived, 76% score) — new survivors introduced faster than remediation. The threshold gate measures current HEAD, so any feature merge resets progress.

2. **Stryker perTest coverage mapping discrepancy (the deeper issue).** PR #13's worker documented: *"mutants that FAIL under a manual sed edit are reported Survived by stryker."* Several survivor-killing tests pass under plain vitest but do NOT register as killing the mutant under stryker's `coverageAnalysis: perTest`. This means adding tests does not reliably move the score — the test↔mutant coverage mapping is lossy for some code shapes (likely async handlers, mock-injected paths, dynamic imports). This is a stryker/vitest-runner toolchain issue, not a missing-test issue.

Combined: even exhaustive test additions yield sub-linear score gains, and concurrent feature work (logger.ts) adds survivors. Net: 95% is not reachable by continuing the same remediation loop.

## Decision needed from user

- **Option A:** Lower the enrollment threshold (mutation-check.yml `break`) to 88 (current headroom) or 90, accept the residual as known tech-debt, and unblock goal completion. Residual survivors are documented per-file below.
- **Option B:** Approve a dedicated stryker-toolchain investigation (why perTest coverage doesn't credit the killing tests) + freeze feature merges to pi-curator main until 95% is hit. This is a multi-session effort.
- **Option C:** Accept the enrollment + measurement loop as delivered (the objective's literal "enroll, list <95% survivors, delegate sub-agents to fix" — all three done) and track 95% as a follow-up goal.

## What IS delivered (objective literal text)

- ✅ **Enroll + implement mutation guard** — mutator-guard config in mutator-guard main (PR #29); stryker sidecar deployed at `.mutator-rules/stryker/`; measurement operational (1006/1006 baseline green, ~9min run).
- ✅ **List all <95% survivors** — full per-file + per-survivor detail in reports/mutation/mutation.json `byFile[].survivors[]` (each: location, mutatorName, replacement, statusReason); per-file summary below.
- ✅ **Delegate sub-agents to fix it** — NINE remediation rounds delegated (PRs #4-#14); killed 266 net survivors (553→287 at peak effort; regression documented above), +559 tests (suite 447→1006). 7 files reached ≥95% at peak.

## Per-file summary (final, survivors descending)

| file | score | survived |
|------|------:|---------:|
| `src/main/slash-commands.ts` | 80.28 | 40 |
| `src/main/index.ts` | 79.57 | 46 |
| `src/runtime/index.ts` | 77.08 | 30 |
| `src/util/logger.ts` | 76.14 | 18 |
| `src/janitor/pi-curator-janitor.ts` | 79.01 | 14 |
| `src/curator-receiver/curator-receiver.ts` | 91.11 | 16 |
| `src/janitor/run-tick.ts` | 80.74 | 15 |
| `src/util/fs-lock.ts` | 87.58 | 20 |
| `src/util/filter-session.ts` | 93.91 | 12 |
| `src/util/trim-session.ts` | 94.54 | 10 |
| `src/crosscheck/crosscheck.ts` | 92.59 | 8 |
| `src/util/team-attach-claim.ts` | 95.12 | 7 |
| `src/curator-receiver/index.ts` | 83.87 | 5 |
| `src/util/config.ts` | 97.54 | 7 |
| `src/runtime/heartbeat.ts` | 87.37 | 6 |
| `src/util/staleness.ts` | 87.27 | 6 |
| `src/crosscheck/mailbox.ts` | 87.50 | 6 |
| `src/runtime/signal-main.ts` | 94.92 | 4 |
| `src/crosscheck/finding.ts` | 95.15 | 5 |
| `src/main/spawn-args.ts` | 90.74 | 5 |
| `src/janitor/run-tick.ts` | 80.74 | 15 |
| `src/main/spawn-gate.ts` | 90.70 | 4 |
| `src/util/heartbeat-lease.ts` | 94.44 | 3 |

## Re-run

```bash
MUTATOR_GUARD_ROOT=../guard-orches/components/mutator-guard bash .mutator-rules/stryker/run.sh
cd ../guard-orches/components/mutator-guard && node scripts/normalize-report.mjs pi-curator typescript \
  /home/bhd/Documents/Projects/bhd/pi-curator/reports/mutation/mutation.json \
  reports/pi-curator/typescript/mutation.json
```
