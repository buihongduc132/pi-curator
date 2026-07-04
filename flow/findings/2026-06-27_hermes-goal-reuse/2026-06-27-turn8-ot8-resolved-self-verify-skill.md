# Explore Turn 8 — OT8 resolved: self-verify via verifier-loop skill (separate prompt)

> Date: 2026-06-27
> Phase: open-thread resolution + scope reshape
> Status: OT8 RESOLVED (Option B-prime); D2 scope shrunk (wire existing skill, not rebuild verifier)

## [user] (verbatim — trust chain L1)

> **[user]** If seld verify loop , it will be injected with the separate prompt.
>
> Usually it will required the main authority to invoke verifier loop skill to verify the works ;

## [assistant]

### OT8 RESOLVED — Option B-prime (self-verify with separate injected prompt)

User's answer settles the authority-level question. The verifier is NOT a separate model (Option A rejected), but it is ALSO NOT naive self-review (raw Option B rejected). It is **Option B-prime**: the same underlying model is used, but bias is broken through **prompt isolation** — the verifier-loop skill injects a *separate*, structured (BLIND) prompt.

```
OPTION A (rejected)        OPTION B (rejected)        OPTION B-prime (LOCKED)
─────────────────          ─────────────────          ──────────────────────
separate model +           same model +               same model +
own LLM call               ad-hoc "be verifier"        verifier-loop SKILL
                           re-prompt                   (separate BLIND prompt,
                                                       structured verdict shape)
escapes bias via           cheap but                   escapes bias via
model isolation            re-introduces               PROMPT isolation +
                           self-talk                   blind review structure
```

**Why this holds:** the verifier-loop skill (at `/home/bhd/.agents/skills/verifier-loop/`) already implements bias-reduction through BLIND prompts + teams dispatch + structured verdict shape. Reusing it means D2 doesn't reinvent verification logic — it wires the existing skill into pi-until-done's post-approval path.

### D2 scope reshaped — wire existing skill, not rebuild verifier

Before this turn, OT1 assumed D2 = "fork pi-until-done and build a verifier inside it". User's turn-8 statement ("required the main authority to invoke verifier loop skill") shrinks this:

```
BEFORE (turn 7 assumed):              AFTER (turn 8):
build verifier logic inside fork      wire post-approval path to
  • build blind-prompt system           invoke existing verifier-loop skill
  • build verdict parser                D2 still builds:
  • build threshold evaluator             • JSON file writer (R1/R2)
  • build JSON file writer                • threshold evaluator (R3)
                                          • max-turns guard (R4)
                                          • two-tier trigger glue (R5/R6)
                                        D2 does NOT build:
                                          • blind-prompt logic (skill owns)
                                          • teams dispatch (skill owns)
                                          • verdict shape (skill owns → OT10)
```

### New requirement locked: R6 — invocation mechanism

**R6 [T8]:** After the main authority (pi-until-done's tier-1 judge) approves "init goal is passed", the **main session/executor** invokes the `verifier-loop` skill to perform the verification rounds. The verifier-loop skill (not the judge, not a new built-in verifier) owns the actual blind-review logic. The per-goal JSON file (R1) is populated from the skill's verdict outputs.

```
user /goal
  → executor works
  → executor calls until_done_complete
  → [TIER 1] pi-until-done judge: "init goal passed?" 
     ├── REJECT → continue loop
     └── APPROVE "init goal passed"
           → [TIER 2] executor INVOKES verifier-loop skill (R6)
              ├── skill runs BLIND rounds (teams dispatch)
              ├── each round → verdict → append to per-goal JSON (R1/R2)
              ├── threshold check (R3)
              │   ├── passThreshold met → goal TRULY done
              │   ├── failThreshold met → NOT done (block / redo)
              │   └── maxTurns hit → NOT done (block)
              └── (existing skill rule: redo-from-scratch on non-unanimous rejection)
```

**Design tension flagged (NOT a blocker, but must be resolved during OT1 fork):** pi-until-done's tier-1 judge is a bare `pi-ai complete()` call returning JSON `{verdict, reason}` — it has no tool-calling capability to invoke skills. So "main authority invokes verifier-loop skill" means the **executor/main agent** (which DOES have tool access) performs the invocation after reading the judge's APPROVE verdict. The fork must wire this in the `executeComplete` path (after `completeWithApproval`), not inside `runJudge`.

### OT9 now informed by existing skill's semantics (L2 — from Hindsight memory)

Hindsight memories (L2, derived observations) reveal the existing verifier-loop skill already has threshold semantics:
- Uses teams with BLIND prompts
- Rejects proposals with critical bugs
- Rule: "redo from scratch, not patch, when rejection is not unanimous"

This suggests OT9's "2/2 approval" may need to reconcile with the existing skill's unanimous-rejection-to-redo model. The two aren't obviously the same — "2/2 approval" (pass side) vs "redo when rejection not unanimous" (fail/redo side). **OT9 still open** but now has a concrete reference: the existing skill's `references/verifier.md` defines the canonical threshold behavior. Read it when resolving OT9.

### OT10 now has a concrete source

The existing verifier-loop skill's verdict shape (at `references/verifier.md`) IS the canonical reference for OT10's "additional verifier-loop-aligned fields". The skill already emits structured verdicts — D2 should map R2's skeleton to that shape, not invent new fields.

### What this turn does NOT change

- D1 (use pi-until-done for now) — unchanged.
- R1–R5 — unchanged, still locked.
- OT2/OT3 (curator gaps) — untouched.
- OT4/OT5 (sustainability, Bun+mise) — untouched.

### Status at end of turn 8

OT8 resolved (Option B-prime). R6 locked (executor invokes verifier-loop skill post-approval). D2 scope shrunk: wire existing skill, don't rebuild verifier. OT9/OT10 now have concrete references (existing skill's `references/verifier.md`). Remaining blockers for OT1 fork: OT9 (threshold semantics reconciliation), the tier-1-judge-has-no-tools design tension, and the existing hardcoded-prompt/fail-open constraints from T5.
