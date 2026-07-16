# pi-curator mutator-guard enrollment result

> Last re-run: 2026-07-16 20:50 UTC (main `0e64db9`, 892 tests, post 5 survivor-remediation PRs #4-#9).
> Tool: stryker (mutator-guard sidecar at `.mutator-rules/stryker/`).

## Headline

**enrolled:** Y

**score:** 88.99% (detectable-only) — stryker headline 88.35%

**states:** killed=2256 survived=259 timeout=20 error=0 ignored=732

**threshold:** 95% — still below; final remediation round in progress (PRs pending).

**reports:**
- normalized: `components/mutator-guard/reports/pi-curator/typescript/mutation.json` (guard-orches)
- raw stryker: `reports/mutation/mutation.json` (gitignored, regenerable via `.mutator-rules/stryker/run.sh`)
- mutator-guard enrollment config: landed via mutator-guard PR #29 (merged to mutator-guard main)

## Progress (63.95% → 88.35% headline)

Five survivor-remediation sub-agent rounds killed **294 survivors** (553→259) by adding **445 targeted unit tests** (total suite 892, was 447):

| round | PR | cluster | result |
|------:|----|--------|--------|
| 1 | #5 | util (config/filter/trim) | config 76→97.5%, filter 69→93.9%, trim 75→94.5% |
| 1 | #4 | wiring (main/runtime/receiver) | main 53→84%, runtime/index 36→88.6%, receiver 70→89.4% |
| 2 | #6 | janitor | janitor 39→81.8%, run-tick 77→96.4% |
| 3 | #7 | crosscheck+receiver | crosscheck 78→92.6%, finding 86→95.2%, mailbox 56→87.5%, receiver-index 33→77.4% |
| 3 | #8 | runtime | signal-main 86.7→**100%**, heartbeat 72.7→93.3%, team-attach 88.9→95.7% |
| 3 | #9 | main+fs-lock | fs-lock 55→67.1%, slash-commands 90→74.9% (more NoCoverage surfaced) |

## Files at/above 95% (achieved)

`src/runtime/signal-main.ts` (100%), `src/util/config.ts` (97.5%), `src/janitor/run-tick.ts` (96.4%), `src/crosscheck/finding.ts` (95.2%), `src/util/team-attach-claim.ts` (95.7%).

## Remaining survivors (final round in progress)

| file | score | survived | ignored |
|------|------:|---------:|--------:|
| `src/main/slash-commands.ts` | 74.88 | 51 | 107 |
| `src/util/fs-lock.ts` | 67.08 | 47 | 27 |
| `src/main/index.ts` | 84.09 | 28 | 81 |
| `src/curator-receiver/curator-receiver.ts` | 89.44 | 19 | 64 |
| `src/runtime/index.ts` | 88.60 | 13 | 26 |
| `src/util/filter-session.ts` | 92.89 | 12 | 26 |
| `src/janitor/pi-curator-janitor.ts` | 83.78 | 11 | 18 |
| (others ≤10 each) | | | |

## Re-run

```bash
MUTATOR_GUARD_ROOT=../guard-orches/components/mutator-guard bash .mutator-rules/stryker/run.sh
```
