# Explore Turn 9 — D3 locked: fail-CLOSED for verifier tier

> Date: 2026-06-27
> Phase: decision lock
> Status: fail-CLOSED confirmed correct for the verifier loop

## [user] (verbatim — trust chain L1)

> **[user]** Also , fail-close is correctly ;

## [assistant]

Confirms the fail-mode direction surfaced in T5/T7/T8. Locking as **D3**.

### D3 [T9] — Verifier loop MUST be fail-CLOSED

Any unparseable, unavailable, or otherwise indeterminate verdict from the verifier tier MUST be treated as **NOT approved** (block / continue), NOT as approved.

This is the inverse of pi-until-done's current tier-1 behavior:
- **Tier-1 (pi-until-done today [T5]):** `parse_error` → APPROVE, `unavailable` → APPROVE. Fail-OPEN.
- **Tier-2 (verifier loop, locked here):** `parse_error` → NOT approved. `unavailable` → NOT approved. Fail-CLOSED.

**Rationale [T7, T8]:** the two-tier design (R5) makes tier-2 a backstop against tier-1's fail-open weakness. If tier-2 also fails open, the backstop is hollow — a malformed verdict silently passes, defeating the entire point of a verifier. A verifier that approves on ambiguity is worse than no verifier.

```
verdict state          tier-1 (today)     tier-2 (LOCKED D3)
─────────────          ──────────────     ─────────────────
"done"                 APPROVE            APPROVE
"continue"             REJECT             REJECT
parse_error            APPROVE ❌         NOT approved ✅
unavailable            APPROVE ❌         NOT approved ✅
```

### What this affects in the D2 fork

- The verifier-tier verdict interpreter (to be built in OT1) must NOT mirror `complete.ts`'s `executeComplete` logic, which calls `completeWithApproval` for any non-`continue` verdict [T5].
- Instead, the verifier-tier evaluator treats anything other than a clean APPROVE as "not passed → continue/block".
- Concretely: the per-goal JSON file (R1) records the actual verdict; the threshold evaluator (R3) counts only clean APPROVEs toward `passThreshold`.

### Relationship to existing constraints

- **Supersedes the T5 flag** that "fail-OPEN must flip to fail-CLOSED for tier-2" — that was a recommendation; D3 makes it a locked decision.
- **Does NOT require changing tier-1's behavior.** pi-until-done's tier-1 judge can stay fail-open for now (D1 = use as-is). The verifier tier enforces the closed-fail gate downstream. (Whether tier-1 should ALSO flip to fail-closed is a separate, unraised question — NOT covered by D3.)

### What this turn does NOT change

- D1, D2 — unchanged.
- R1–R6 — unchanged.
- OT8 (resolved T8), OT9, OT10 — unchanged.
- OT2/OT3 (curator gaps), OT4/OT5 (sustainability) — untouched.

### Status at end of turn 9

D3 locked. Fail-mode direction settled. Remaining OT1 blockers: OT9 (threshold semantics), OT10 (verdict fields via verifier-loop skill's `references/verifier.md`), tier-1-judge-has-no-tools design tension (T8), hardcoded prompt parameterization (T5).
