# Explore Turn 7 — Verifier-loop integration spec (refines D2)

> Date: 2026-06-27
> Phase: requirements capture for deferred work (D2)
> Status: file format + thresholds + trigger ordering captured; authority-level question left open per user

## [user] (verbatim — trust chain L1)

> **[user]** Verify loop will be:
> - there is a dedicated file created per each time user press /goal , which is a json file with schema similarity to:
> -- (array) { approval_status: APPROVE / REJECT ; reason: string ; ... any other fields that better to  aligned with the verifier loop that you can think of }
>
> Can config the rate of approval / rejected that make it passed / failed. (default 2/2 approval) , can config max turn (default to 20);
> Current open threads: these verifier should be another higher level of authority OR it is just a prose prompt to the main one or not;
> Also , it should only triggered if the main authority decided that "init goal is passed" , then verifier loop kicks in.
>
> Then , update that into the findings for me ;

## [assistant]

Capturing as requirements for D2 (verifier-loop integration into pi-until-done). NOT implementing — explore mode. Surfacing design forks and one semantic ambiguity. New cross-turn files updated: locked-decisions (R-classes added), open-threads (OT1 refined, OT8/OT9 added).

### What got locked in this turn (requirements, not decisions)

**R1 [T7] — Per-/goal JSON file.** A dedicated file is created each time the user presses `/goal`. Contents = JSON array of verdict objects. File lives alongside the goal (path TBD — see OT1).

**R2 [T7] — Verdict object schema (skeletal).** Each array element:
```json
{
  "approval_status": "APPROVE" | "REJECT",
  "reason": "string"
}
```
User explicitly invited additional fields "that better to aligned with the verifier loop". Candidate aligned fields (assistant proposal, NOT locked — see OT10):
- `round` (int — which verifier round)
- `severity` (REJECT only: low/medium/high/critical)
- `defects[]` (REJECT only: specific defects, e.g. shape-drift, missing evidence)
- `concerns[]` (APPROVE only: non-blocking notes)
- `model` (which model judged this round — matters if OT8 resolves to "higher authority")
- `ts` (timestamp)
- `evidence_refs[]` (what evidence the verdict cited)
- `requires_followup` (bool — flag even on APPROVE)

**R3 [T7] — Configurable pass/fail thresholds.** User: "rate of approval / rejected that make it passed / failed. (default 2/2 approval)". Captured as `passThreshold` / `failThreshold` (semantics flagged — see OT9).

**R4 [T7] — Configurable max turns.** Default 20. (Aligns with pi-until-done's existing `DEFAULT_MAX_TURNS = 20` — no conflict.)

**R5 [T7] — Trigger ordering: main authority FIRST.** Verifier loop "should only triggered if the main authority decided that 'init goal is passed'". Two-tier authority:

```
user presses /goal
  → main authority (pi-until-done's existing cross-model judge)
     evaluates "is init goal passed?"
     ├── REJECT → continue loop (existing behavior)
     └── APPROVE "init goal passed"
           → [NEW] verifier loop ACTIVATES
              ├── round 1: verdict → append to JSON file
              ├── round 2: verdict → append
              ├── ...
              ├── hits passThreshold → goal TRULY done
              └── hits failThreshold OR maxTurns → goal NOT done (block)
```

This is a genuine two-tier gate: tier 1 = "claim is coherent", tier 2 = "independently verified". Important consequence: the verifier loop is a SECOND CHANCE to catch what tier-1's fail-open weakness (pi-until-done approves on parse_error/unavailable [T5]) would otherwise let through.

### Open thread the user explicitly raised

**OT8 [T7] — Authority level of the verifier.** Verbatim: *"these verifier should be another higher level of authority OR it is just a prose prompt to the main one or not"*.

Two options, with real tradeoffs:

| Option | Mechanism | Pros | Cons |
|---|---|---|---|
| **A. Higher authority** (separate model invocation) | Verifier = own LLM call (like pi-until-done's judge but looped) | True independent check; no self-review bias; aligns with pi-until-done's cross-model rationale | More infra (separate model, separate auth, separate context assembly); cost = N× model calls per goal |
| **B. Prose prompt to main** | Verifier = re-prompt of the SAME main model with a "now be a verifier" system prompt | Zero new infra; reuses existing model/auth; cheap | Self-review bias — the model that did the work reviews the work; contradicts pi-until-done's stated reason for cross-model ("standard fix for Ralph-loop oscillation" [T5]) |

Recommendation IF asked (not yet asked): Option A. The whole point of pi-until-done's cross-model judge is to escape self-talk; option B throws that away. But the user owns this decision — flagging as the load-bearing open question for D2.

### Semantic ambiguity flagged

**OT9 [T7] — "2/2" semantics.** User: "default 2/2 approval". Two readings:
- (a) **Ratio**: 2 of 2 rounds must approve (100% approval required, sample size 2).
- (b) **Dual threshold**: `passThreshold=2` (need 2 approvals to pass) AND `failThreshold=2` (need 2 rejections to fail), independent counts.

These behave very differently under partial disagreement. Need user clarification before D2 implementation. Default captured as "2 approvals required to pass" but fail-side semantics unresolved.

### What this turn does NOT change

- D1 (use pi-until-done for now) — unchanged, still locked.
- D2 (bake verifier-loop in later) — still deferred, but now has concrete requirements R1–R5 attached.
- OT2/OT3 (curator gaps) — untouched.
- OT4/OT5 (sustainability, Bun+mise) — untouched.

### Status at end of turn 7

Verifier-loop spec captured as R1–R5. Two new open threads (OT8 authority level, OT9 threshold semantics). OT1 (the fork itself) now has a concrete shape. Explore on this sub-topic pauses pending: OT8 decision, OT9 clarification, and the user's go-ahead to start the fork.
