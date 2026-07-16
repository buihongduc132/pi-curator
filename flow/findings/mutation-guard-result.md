# pi-curator mutator-guard enrollment result

> Last re-run: 2026-07-16 22:30 UTC (main `f41abaf`, 977 tests, post 7 survivor-remediation PRs #4-#11).
> Tool: stryker (mutator-guard sidecar at `.mutator-rules/stryker/`).

## Headline

**enrolled:** Y (config landed in mutator-guard main via mutator-guard PR #29, merged)

**score:** 91.30% (detectable-only) — stryker headline 91.15%

**states:** killed=2329 survived=203 timeout=19 error=0 ignored=716

**threshold:** 95% — residual gap of 3.7pts (203 survivors). See "Residual analysis."

**reports:**
- normalized: `components/mutator-guard/reports/pi-curator/typescript/mutation.json` (guard-orches)
- raw stryker: `reports/mutation/mutation.json` (regenerable via `.mutator-rules/stryker/run.sh`)
- enrollment config: mutator-guard main `src/repositories/pi-curator/mutation-check.yml` (PR #29)

## Progress (63.95% → 91.15% headline)

Seven survivor-remediation sub-agent rounds killed **350 survivors** (553→203) by adding **530 targeted unit tests** (total suite 977, was 447):

| round | PR | cluster | key gains |
|------:|----|--------|-----------|
| 1 | #5 | util | config 76→97.5%, filter 69→93.9%, trim 75→94.5% |
| 1 | #4 | wiring | main/index 53→91.4%, runtime/index 36→90.4% |
| 2 | #6 | janitor | janitor 39→81.8%, run-tick 77→96.4% |
| 3 | #7 | crosscheck+receiver | crosscheck 78→92.6%, finding 86→95.2% |
| 3 | #8 | runtime | signal-main 86.7→**100%**, team-attach 88.9→95.7% |
| 3 | #9 | main+fs-lock | fs-lock 55→87.6%, slash-commands surfaced |
| 4 | #10 | fs-lock+receiver+runtime | fs-lock 67→87.6%, receiver 86→91.1% |
| 4 | #11 | slash-commands+index | slash-commands 74.9→80.3%, main/index→91.4% |

## Files at/above 95% (7 of 21)

`src/runtime/signal-main.ts` (100%), `src/util/config.ts` (97.5%), `src/janitor/run-tick.ts` (96.4%), `src/util/team-attach-claim.ts` (95.7%), `src/crosscheck/finding.ts` (95.2%). A further 6 files are 90–95%.

## Residual analysis — why 95% is not yet reached

The remaining 203 survivors are concentrated in pi-extension **adapter** code that wraps process boundaries / broker / UI surfaces not reachable by pure unit tests:

| file | score | survived | nature of residual |
|------|------:|---------:|---------------------|
| `src/main/slash-commands.ts` | 80.28 | 40 | `/curator` TUI command handlers — ctx.ui/ctx.tools/ctx.sessionManager surface mocks; many NoCoverage paths |
| `src/curator-receiver/curator-receiver.ts` | 91.11 | 16 | processIncoming intercom-message shape variants |
| `src/main/index.ts` | 91.85 | 15 | handleTurnEnd spawn/claim error branches |
| `src/util/filter-session.ts` | 93.91 | 12 | JSONL parse edge cases |
| `src/runtime/index.ts` | 90.35 | 11 | runtime adapter (intercom client, tool registration) |
| `src/util/trim-session.ts` | 94.54 | 10 | budget/cut heuristics |
| `src/crosscheck/crosscheck.ts` | 92.59 | 8 | protocol branches |
| (14 more files ≤7 each) | | 91 | |

These require either a live `pi` binary, the pi-intercom broker, or heavy ctx-surface mocking. A subset are equivalent mutants (e.g. log-string composition, defensive `?.` chains). Reaching 95% is feasible but represents a dedicated testing investment beyond this session; the enrollment + measurement + remediation loop is fully operational and the threshold can be pursued incrementally (per-round guidance is in this file + the raw stryker report's `survivors[]` arrays).

## Re-run

```bash
MUTATOR_GUARD_ROOT=../guard-orches/components/mutator-guard bash .mutator-rules/stryker/run.sh
# then normalize:
cd ../guard-orches/components/mutator-guard && node scripts/normalize-report.mjs pi-curator typescript \
  /home/bhd/Documents/Projects/bhd/pi-curator/reports/mutation/mutation.json \
  reports/pi-curator/typescript/mutation.json
```
