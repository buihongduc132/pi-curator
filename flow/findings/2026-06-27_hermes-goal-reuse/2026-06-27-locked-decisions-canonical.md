# Locked Decisions — Canonical (Hermes /goal reuse explore, 2026-06-27)

> IMMUTABLE INPUT for any future proposal derived from this explore.
> Every decision tagged with source turn `[Tn]`.
> Trust chain L1 = verbatim user words.

## D1 — USE pi-until-done for now [T6]

> **[user] (verbatim, L1):** "We will use that until-done for now"

**Decision:** Adopt the npm package `pi-until-done` (repo `srinitude/pi-until-done`) as the Hermes `/goal` authority port for pi. "For now" = current decision scope; not a permanent commitment.

**Context that made this the choice [T1–T5]:**
- pi-until-done is the ONLY pi plugin that is a faithful Hermes `/goal` port with an auxiliary LLM judge that gates completion [T3, T4].
- All other goal plugins are self-decide (no judge) or structural/schema-gated (weaker than LLM verdict) [T2, T4].
- Market adoption skews to self-decide (pi-codex-goal 143★/1882 wk; @narumitw/pi-goal 88★/3614 wk) but user's bar was "Hermes authority + reusable by 3rd party" → only pi-until-done clears it [T4].

**Constraints inherited (do NOT violate):**
- Judge model is configurable per-goal (`judgeModel {provider, modelId}`) and per-session (`/until-done judge <p>/<m>`) [T5].
- Judge PROMPT is hardcoded — accept this limitation for now [T5].
- Fail-OPEN on parse_error / unavailable — accept this limitation for now [T5].
- Requires Bun + mise as runtime deps [T3].

## D2 — Bake verifier-loop into pi-until-done LATER (deferred) [T6]

> **[user] (verbatim, L1):** "later on I will bake the verifier loop into that as well"

**Decision:** Future work — integrate the verifier-loop skill/mechanism into pi-until-done. NOT part of the current decision (D1). Deferred to a later session/change.

**Requirements attached to D2 (locked [T7]):**
- **R1 [T7]:** A dedicated JSON file is created per `/goal` invocation. Contents = JSON array of verdict objects.
- **R2 [T7]:** Verdict object skeleton = `{ approval_status: APPROVE|REJECT, reason: string }` + additional verifier-loop-aligned fields (candidates proposed, NOT locked — see OT10).
- **R3 [T7]:** Configurable pass/fail thresholds. Default "2/2 approval". Semantics flagged — see OT9.
- **R4 [T7]:** Configurable max turns. Default 20 (aligns with pi-until-done's existing `DEFAULT_MAX_TURNS`).
- **R5 [T7]:** Trigger ordering — verifier loop activates ONLY after the main authority (pi-until-done's existing judge) has decided "init goal is passed". Two-tier authority: tier-1 = claim coherent, tier-2 = independently verified.

**What "bake verifier loop in" will additionally require (flagged, not analyzed further) [T5]:**
- Parameterize the hardcoded `buildSystemPrompt` in `extensions/lib/tools/judge.ts`.
- Parameterize the hardcoded `buildUserPrompt` in `extensions/lib/tools/judge.ts`.
- Flip fail-OPEN (parse_error/unavailable → APPROVE) to fail-CLOSED for the verifier-loop use case (the two-tier design in R5 makes tier-2 a backstop against tier-1's fail-open — but tier-2 itself must not fail-open).
- Likely add a config layer (currently zero env/JSON config) to drive custom prompt + fail mode + thresholds R3/R4.

## Derived constraints (NOT new decisions — consequences of D1/D2)

These are factual consequences surfaced during explore, recorded here so a future proposal cannot silently violate them:

- **C1 [T5]:** Fork of `pi-until-done` is required for ANY judge prompt/behavior customization (advisor mid-loop nudges, custom verdict vocab, curator-style signal). Until D2 lands, the judge is locked to "is this literal done-criteria met?".
- **C2 [T4]:** `pi-until-done` is low-adoption (96 wk / 28★ at time of decision). Depending on it carries maintenance/sustainability risk; pin a version.
- **C3 [T1]:** Curator advisory role (mid-loop `signal_main(steer)` nudges) and skill/memory curation remain UNBUILT gaps. D1 does NOT close them. See `2026-06-27-open-threads.md`.

## D3 — Verifier loop MUST be fail-CLOSED [T9]

> **[user] (verbatim, L1):** "Also , fail-close is correctly ;"

**Decision:** The verifier tier (tier-2) MUST treat indeterminate verdicts (`parse_error`, `unavailable`, anything not a clean APPROVE) as NOT approved (block / continue). Fail-CLOSED.

**Rationale [T7, T8]:** tier-2 is a backstop against tier-1's fail-open weakness [T5]. If tier-2 also fails open, the backstop is hollow. A verifier that approves on ambiguity is worse than no verifier.

**Scope:** applies to the verifier tier ONLY. Does NOT mandate changing tier-1's existing fail-open behavior (D1 = use pi-until-done as-is). Whether tier-1 should also flip is a separate unraised question.

**Implementation consequence:** the OT1 fork's threshold evaluator counts only clean APPROVEs toward `passThreshold`. It must NOT mirror `executeComplete`'s "any non-continue verdict → approve" pattern.

```
verdict state          tier-1 (today)     tier-2 (LOCKED D3)
─────────────          ──────────────     ─────────────────
"done"                 APPROVE            APPROVE
"continue"             REJECT             REJECT
parse_error            APPROVE            NOT approved
unavailable            APPROVE            NOT approved
```
