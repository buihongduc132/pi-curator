# Decision: suppressed.jsonl — BUILD NOW or SKIP?

> Date: 2026-07-07
> Decider: investigator-suppressed (read-only investigation)
> Status: DECISION

## EVIDENCE

### What I read

1. **`src/crosscheck/crosscheck.ts`** — `decideSignal()` returns `{signal: false, append: buildAgreement(...)}` on suppression. The caller does NOT call `signal_main` but DOES call `appendEntry` with the agreement entry to `shared.jsonl`.

2. **`src/crosscheck/mailbox.ts`** — `appendEntry()` writes to `shared.jsonl` only. No second file, no suppression log. Fail-open swallows errors silently.

3. **`src/crosscheck/finding.ts`** — Agreement entry shape: `{type, topic, curator, ts, severity}`. No `summary` field. Finding entry shape: `{type, topic, curator, ts, severity, summary}`. The summary is what's lost on suppression.

4. **`openspec/changes/archive/2026-06-23-add-curator-crosscheck/design.md`** — D2 (first-finding-wins), D3 (exact topic match), D5 (fail-open). Design explicitly acknowledges slug collision risk ("second one silently dropped as agreement") and accepts it. Design says: "If you never question [first-finding-wins], skip."

5. **`openspec/changes/archive/2026-06-23-add-curator-crosscheck/specs/curator-crosscheck/spec.md`** — REQ: crosscheck defaults to `enabled: false`. REQ: exact topic match only. REQ: agreement entries written to shared.jsonl. No requirement to record suppressed findings.

6. **`flow/findings/curator-observability/2026-07-07-turn2-layered-approaches-and-blackbox-reframe.md`** — Tier 4 = suppressed.jsonl. D-D decision surfaced but not locked. Assistant's own read: "T1+T2 = the floor. T3-T5 are real value but not urgent — wait until you hit the pain."

7. **`flow/findings/curator-observability/2026-07-07-locked-decisions.yaml`** — LD2 locked the observability floor: pi session store + pids correlation (LD1) + stderr crash-catch (D11). Tier 4 is above the floor.

8. **`flow/findings/curator-observability/2026-07-07-open-threads.yaml`** — OT6 (suppressed.jsonl) status: open, escalated to user. Comment: "Conditional on user trust of first-finding-wins dedup. No evidence breaks tie → STOP + ASK."

### Key facts about what's already recorded vs lost

| What | Recorded? | Where |
|------|-----------|-------|
| Curator B agreed with topic T | ✅ YES | shared.jsonl (agreement entry) |
| Topic slug T was suppressed | ✅ YES | shared.jsonl (agreement has topic) |
| Which curator was suppressed | ✅ YES | shared.jsonl (agreement has curator) |
| Suppressed finding's severity | ✅ YES | shared.jsonl (agreement has severity) |
| Suppressed finding's summary text | ❌ NO | Only in curator's pi session JSONL |
| Which original finding it matched | ❌ NO | Inferable from topic+window, not explicit |

## DECISION

**SKIP**

## RATIONALE

1. **Suppression is rare by construction.** Crosscheck defaults to `enabled: false` (spec REQ). Even when opted-in, suppression requires two curators on the same main session producing findings with the exact same topic slug within a 10-minute window. This is a narrow conjunction of conditions — not a frequent event.

2. **The suppression is not invisible today.** The agreement entry in `shared.jsonl` records that curator B agreed on topic T at time X with severity S. The suppressed curator's full reasoning (including the summary it would have signaled) lives in its pi session JSONL — findable by `pi --resume` via the shipped `--name "curator:<alias>"` (LD2 confirmed reasoning is ☀️, not 🌑). What's missing is convenience (one file vs two hops), not information.

3. **First-finding-wins is deterministic and the design explicitly accepts the tradeoff.** Exact topic match (D3) means slug divergence = both signal (no loss), slug collision = second dropped (accepted risk in design D2). The design doc says verbatim: "If you never question it, skip." There is no evidence of slug collisions causing actual data loss.

4. **LD2 locked the observability floor at Tier 1+2 (pointer + stderr).** Tier 4 is above the floor. The turn-2 assistant read was explicit: "T3-T5 are real value but not urgent — wait until you hit the pain." No one has hit the pain yet.

5. **Cost is low but so is value.** Yes, ~10 lines in mailbox.ts. But the value is also small: the summary text of a suppressed finding that already exists in the curator's pi session. Building it now is speculative; building it when someone actually loses debugging time is evidence-driven.

## IF SKIP: what would make you revisit

- **Crosscheck moves from opt-in to default-enabled** — suppression frequency would jump from "rare" to "every multi-curator session"
- **A real debugging session where the summary text of a suppressed finding was needed and not recoverable from the curator's pi session** — concrete pain, not speculative
- **Topic slug collisions observed in practice** — evidence that exact-match dedup is silently dropping genuinely different findings
- **Curator count scales up** — if 5+ curators per main become common, the agreement-only record becomes harder to reconstruct manually

## IF BUILD: minimal scope

N/A — decision is SKIP.

If revisited and flipped to BUILD, the minimal scope would be:
- New file: `~/.pi-curator/findings/<mainSessionId>/suppressed.jsonl` (same directory as shared.jsonl, same lifecycle/GC)
- One new function in `mailbox.ts`: `appendSuppressed(path, pending, matchedFinding, now)`
- Called from the crosscheck hook when `decideSignal` returns `signal: false`
- Record: `{dedupKey, suppressedCurator, reason: "first-finding-wins", originalFinding: {topic, curator, ts}, suppressedSummary, suppressedSeverity, ts}`
- Same fail-open semantics as `appendEntry` (errors swallowed, debug-only log)
