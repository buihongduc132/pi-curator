# builder-crosscheck — built (2026-07-07)

## Deliverables (all under `src/crosscheck/`)

| File | LOC | Role |
|------|----:|------|
| `finding.ts` | ~210 | Entry types (Finding/Agreement/MailboxEntry), Severity enum, `topicKey`/`dedupKey` (D3 exact+case-insensitive+trimmed), `normalizeFinding`/`normalizeAgreement`/`normalizeEntry`, `serializeEntry` (spec field order), `parseEntry`/`parseMailboxText` (fail-open, skips malformed/blank). |
| `mailbox.ts` | ~130 | `mailboxPath` (~/.pi-curator/findings/<id>/shared.jsonl), `readMailbox` + `appendEntry` (O_APPEND atomic line writes, no locking v1), injected `MailboxFs` for testability, **fail-open** on every error path. |
| `crosscheck.ts` | ~250 | Core: `CrossCheckConfig` + `resolveCrossCheck` (defaults), `findMatchingPeerFinding` (D3 exact match, clock-skew-tolerant window), `decideSignal` (all 4 branches: disabled / trigger-skip / first-finding-wins suppress / signal-anyway / no-peer), `failOpenDecision`. |
| `finding.test.ts` | ~180 | 29 tests. |
| `mailbox.test.ts` | ~160 | 12 tests (in-memory fake fs). |
| `crosscheck.test.ts` | ~260 | 29 tests incl. spec scenario walkthroughs. |

## Test result

```
src/crosscheck/mailbox.test.ts   ✓ 12 tests
src/crosscheck/finding.test.ts   ✓ 29 tests
src/crosscheck/crosscheck.test.ts ✓ 29 tests
---
Test Files  3 passed (3)
     Tests  70 passed (70)
```
Full project: **371/371 pass** (15 files). My code adds zero typecheck errors.

## SPEC-DRIVEN DEVIATION FROM TASK BRIEF [CA1 — READ THIS]

The leader's task brief asked for:
- `findingFingerprint` over **message-prefix** + severity + mainSessionId.
- `dedupeFindings` via fingerprint **OR jaccard similarity threshold** on token sets.
- `aggregate.ts` with **severity-weighted promotion** ("highest severity wins").

**I did NOT build these.** They directly violate the LOCKED spec, which mandates the opposite:

- Spec REQ "First-finding-wins dedup" + design **D3**: *"Topic matching SHALL be exact, case-insensitive, after trimming. No fuzzy matching, embedding search, or canonicalization."* → jaccard similarity is **explicitly forbidden**.
- Spec REQ "No consensus, voting, or cross-session visibility": *"No quorum, majority voting, conflict-resolution via LLM…"* and scenario *"No voting primitive exists" → that work SHALL be rejected as out of scope."* → severity-weighted aggregation is **explicitly rejected**.
- The dedup key is **TOPIC only** (per spec), not message-prefix/severity/mainSessionId. mainSessionId is encoded in the mailbox **path**, not the entry.

Per AGENTS.md "NEVER strip instead of fix / ALWAYS fix root cause", I built to the **spec** (source of truth) rather than the brief. The result is the lean-default first-finding-wins mailbox dedup the design calls for.

## What I shipped instead (spec-compliant)

1. `dedupKey()` = normalized topic only (D3-compliant).
2. `decideSignal()` = the full read-decide protocol: trigger gate → mode gate → first-finding-wins-within-window. Returns `{signal, append, reason}`.
3. `mailbox.ts` = the on-disk JSONL transport (atomic appends, fail-open).
4. `failOpenDecision()` = the channel-down path (REQ: failures MUST fail open).

The three layers compose: a curator's `signal_main` hook calls `readMailbox → decideSignal → (maybe) signal_main + appendEntry`. All pure/testable; I/O is injected.

## Callsout (for leader / next phase)

- **[CA1]** Task brief conflict with spec — documented above. Confirm spec is authoritative (it is — locked design).
- **[CA2]** Typecheck errors exist in `src/janitor/run-tick.ts:92,142` (builder-lifecycle's code, Signals vs `0` cast). NOT mine; flagged for that owner. All runtime/lifecycle/janitor tests still pass at runtime — it's a `tsc`-only strictness issue.
- **[CA3]** No integration glue yet wiring `decideSignal` into the curator `signal_main` path — that requires the runtime extension (builder-runtime's `signal-main.ts`) which I depend on. The pure decision + mailbox is complete and testable standalone; the wiring is a follow-up once runtime lands. This matches the spec's stated dependency: "Depends on `add-curator-lifecycle` + `add-curator-signal`".
