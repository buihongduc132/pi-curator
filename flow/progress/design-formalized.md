# Documentation Phase — D15 black-box-by-design formalization

**Date**: 2026-07-07
**Agent**: design-formalizer
**Task**: #16
**Status**: ✅ Documentation complete — no code touched

## Scope

Formalized "curator is black-box by design" as explicit design decision **D15**,
resolving the contradiction between the code (which is black-box — curator
reasoning persists as a first-class pi session) and design.md D11 (stderr→logs).

This is the documentation side of **[LD2]** — `flow/findings/curator-observability/2026-07-07-locked-decisions.yaml`.
Source reasoning: `flow/findings/curator-observability/2026-07-07-turn2-layered-approaches-and-blackbox-reframe.md`
(sections "The reframe (user is right)" and "Assistant read").

## Why D15, not D13

The task brief anticipated the title "D13 — Curator observability posture" but
allowed "next available D-number if D13 taken." D13 is **already taken**
("HUMAN REMINDER (scold-reminder) is in a visible tracker"). The Decisions
section runs D1–D14; the next free number is **D15**.

## Deliverable 1 — D15 in design.md

**File**: `openspec/changes/archive/2026-06-23-add-curator-lifecycle/design.md`
**Location**: **lines 325–387** (inserted between D14 and `## Risks / Trade-offs`
at line 388).

**Title**: `### D15 — Curator observability posture: black-box by design`

**Content states**:
1. The curator is black-box by design — reasoning, tool calls, and conclusions
   persist in the pi session store (`~/.pi/agent/sessions/`) as a first-class
   pi session, findable via `pi --resume` by the shipped
   `--name "curator:<alias>"`.
2. The observability **floor** = exactly three layers:
   - (a) pi session store (reasoning),
   - (b) `curatorSessionId` pointer in pids **[LD1]**,
   - (c) D11 stderr crash-catch (pre-session-write crashes).
3. D11 is **NOT** a violation of black-box-by-design — it covers the ONE edge
   case where `~/.pi` has nothing (curator died before writing a session JSONL).
4. **Explicitly ABOVE the floor and DEFERRED**:
   - Tier 3 — `spawn-log/` structured run-log (deferred until curators multiply).
   - Tier 4 — `suppressed.jsonl` (SKIP per OT6 investigation).
   - Tier 5 — Full logging library (rejected as premature).
5. Cites **[LD1]** and **[LD2]** from
   `flow/findings/curator-observability/2026-07-07-locked-decisions.yaml`.
6. **Alternatives considered**: (a) full logging library — rejected as
   premature; (b) leave implicit — rejected because the code/design
   contradiction IS the bug.

## Deliverable 2 — Scenario under REQ-LC-04 in spec.md

**File**: `openspec/specs/curator-lifecycle/spec.md`
**Location**: **lines 88–103** (appended under REQ-LC-04 "Child spawn", after
the existing "Scenario: Detached false spawn" at line 83).

**Title**: `#### Scenario: Curator observability surface (black-box by design)`

**Content**:
- **WHEN** a curator is spawned
- **THEN** its observability surface = the pi session store
  (`~/.pi/agent/sessions/`, findable via `pi --resume` by the shipped
  `--name "curator:<alias>"`) PLUS the `curatorSessionId` pointer in the pids
  file [LD1] PLUS the D11 stderr crash-catch (`~/.pi-curator/logs/...`)
- **AND** the curator is black-box by design — its reasoning is NOT re-emitted
  to the main turn; it persists as a first-class pi session (see D15)
- **AND** the D11 stderr capture exists ONLY for the edge case where the
  curator died before writing any session JSONL; it does not undermine the
  black-box posture

## Verification

| Check | Result |
|-------|--------|
| D15 inserted, D-number sequential (no collision with D1–D14) | ✅ D15 @ line 325 |
| D15 cites [LD1] + [LD2] | ✅ |
| D15 lists floor (3 layers) + deferred tiers (3,4,5) | ✅ |
| D15 lists 2 alternatives considered | ✅ |
| Scenario appended under REQ-LC-04, references D15 | ✅ line 88 |
| No code modified (documentation only) | ✅ only 2 `.md` files in `openspec/` |

```
git diff --stat -- openspec/
 .../2026-06-23-add-curator-lifecycle/design.md   | 63 ++++++++++++++++++++++
 openspec/specs/curator-lifecycle/spec.md         | 14 ++++-
 2 files changed, 76 insertions(+), 1 deletion(-)
```

## Note — sibling agents

The worktree also shows `src/` modifications in `git status` (spawn-args.ts,
index.ts, run-tick.ts, heartbeat.ts, team-attach-claim.ts, etc.) plus new test
files (`d11-stdio.test.ts`, `team-attach-claim.test.ts`). These belong to
sibling agents **green-d11-stderr** (#14) and **green-sessionid** (#13). This
agent touched **only** the two `openspec/` documentation files above — no
source, no tests.
