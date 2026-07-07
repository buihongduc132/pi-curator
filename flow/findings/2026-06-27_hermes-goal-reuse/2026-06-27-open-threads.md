# Open Threads — Hermes /goal reuse explore (2026-06-27)

> Unresolved items, deferred work, and next-step menu.
> Explore on this topic concluded with D1/D2 (see locked-decisions-canonical.md) but these threads remain open.

## Deferred work (explicitly deferred by user [T6])

### OT1 — Bake verifier-loop into pi-until-done
- **Status:** Deferred by user (D2). NOT current work. Spec refined [T7] — see R1–R5 in locked-decisions.
- **When:** Later session/change, AFTER OT8 (authority level) and OT9 (threshold semantics) are resolved.
- **Locked requirements [T7]:** R1 per-goal JSON file; R2 verdict array schema; R3 configurable thresholds (default 2/2); R4 max turns (default 20); R5 trigger ordering (main authority passes FIRST, then verifier).
- **Open blockers:**
  - OT8 — authority level (higher authority vs prose-prompt-to-main). → RESOLVED [T8]: Option B-prime, self-verify via verifier-loop skill.
  - OT9 — "2/2" semantics (ratio vs dual-threshold). Still open. Reconcile with existing skill's unanimous-rejection-to-redo model.
  - OT10 — which verifier-loop-aligned fields beyond `{approval_status, reason}`. Resolve via existing `verifier-loop` skill's `references/verifier.md`.
  - **D3 [T9]: fail-CLOSED locked** for tier-2. NOT a blocker — settled constraint.
  - `buildSystemPrompt` / `buildUserPrompt` hardcoded in `extensions/lib/tools/judge.ts` [T5].
  - Tier-1 judge has no tool access — `executeComplete` path must wire the skill invocation (executor invokes, not judge) [T8].
  - Zero env/JSON config today → config layer needed.
- **First step when resumed:** Resolve OT8 + OT9. Then fork `srinitude/pi-until-done` → `buihongduc132/`, parameterize prompt, add config, add the JSON file writer + threshold evaluator.

## Unbuilt gaps (NOT closed by D1)

### OT2 — Curator advisory mid-loop nudges
- **Status:** Open gap. No pi plugin covers it.
- **Why it differs from pi-until-done's judge:** pi-until-done judge fires ONLY at completion (`until_done_complete`). Curator's `signal_main(steer)` fires DURING the loop. Different trigger point, different authority (nudge vs gate).
- **Source:** `openspec/specs/curator-signal/spec.md` (still specced, not active).
- **Open question:** Is the marginal value of mid-loop nudges worth building, given pi-until-done already judges at completion? Unresolved.

> **Verdict (auto-decided 2026-07-04):** DEFER. Don't build OT2 now.
> Rationale: pi-until-done's completion-judge covers the high-value case (gate at done). Mid-loop nudges are speculative value with real cost (extra LLM turns, interrupt churn). Revisit ONLY if a live workflow demonstrates the gap (a real goal where mid-loop drift cost more than the nudge overhead).
> Action: leave `curator-signal` spec archived; do not revive until demand is concrete.
> automate decided with verdict

### OT3 — Skill/memory curation (Hermes Curator proper)
- **Status:** Open gap. Unchanged from prior curator research.
- **Source:** `flow/findings/curator/gap-analysis.md` — skill usage telemetry, lifecycle FSM, provenance, archive-with-recovery, pinning, background LLM skill review all missing.
- **Note:** None of the `/goal` plugins touch skill lifecycle. This is orthogonal to the goal-judge decision.

> **Verdict (auto-decided 2026-07-04):** PHASE per gap-analysis §1–6 order. Direction is already clear (gap-analysis has the build plan); no design ambiguity.
> Sequencing: (1) Skill Usage Tracker → (2) Provenance → (3) Lifecycle FSM → (4) Archive → (5) Pin → (6) Background LLM review. Phases 1–2 are data-collection foundations that 3–6 depend on; ship 1+2 first, evaluate real usage data, THEN decide FSM thresholds.
> Action: open first change `add-skill-usage-tracker` covering §1 only. Do NOT bundle §1–6 into one mega-change.
> automate decided with verdict

## Sustainability / dependency risks

### OT4 — pi-until-done low adoption
- **Status:** Risk acknowledged, accepted under D1 "for now".
- **Data [T4]:** 96 weekly downloads, 28★, last push 2026-05-08 (stale-ish at time of explore).
- **Mitigation:** Pin a version. When D2 (verifier-loop fork) lands, the fork becomes self-maintained → risk dissolves.

### OT5 — Bun + mise runtime dependency
- **Status:** Accepted under D1.
- **Source [T3]:** pi-until-done README lists Bun + mise as requirements.
- **Note:** Verify these are present in the target pi stage before install. If not, install them as part of pi setup.

## Questions NOT resolved during explore

### OT6 — Does ralph-wiggum want a judge hook?
- **Status:** Raised [T1], never answered (user redirected to remote search).
- **Original framing:** pi-ralph-wiggum today trusts the agent's own `<promise>COMPLETE</promise>`. Adding a judge changes the trust model. Is that a real feature request?
- **Note:** D1 (use pi-until-done) makes this moot for the goal-judge case, but the question of whether ralph-wiggum itself should grow a judge remains open.

> **Verdict (auto-decided 2026-07-04):** NO (do not modify ralph-wiggum). Goal-judge is owned by pi-until-done (D1); ralph-wiggum stays a pure loop driver. If a ralph+judge need surfaces, route it through pi-until-done's authority, not into ralph-wiggum's loop primitive.
> Action: close. Reopen only if a concrete ralph-without-until-done goal-judge use case appears.
> automate decided with verdict

### OT7 — Same-session vs fresh sidecar for the judge
- **Status:** Raised [T1], never answered.
- **Original framing:** Hermes `/goal` judge runs in worker's full session context. Curator runs a fresh forked session. Which model does the goal-judge need? pi-until-done uses `pi-ai`'s `complete()` (fresh one-shot, out-of-session) [T5] — so for pi-until-done this is settled (fresh). But if D2 bakes verifier-loop in, the answer may need revisiting.

> **Verdict (auto-decided 2026-07-04):** FRESH sidecar for the verifier tier (tier-2). Match pi-until-done's existing fresh-`complete()` model.
> Rationale: the entire point of pi-until-done's cross-model judge is to escape self-talk [T5]. A same-session verifier re-reads the model's own output → self-review bias → defeats the backstop D3 mandates. Fresh sidecar = independent context, no inheritance of the worker's rationalizations.
> Action: D2 fork MUST keep verifier tier as a fresh `complete()` call (or pi-intercom sidecar), NOT a re-prompt of the worker session.
> automate decided with verdict

## Questions NOT resolved during explore

### OT8 — Authority level of the verifier [T7]
- **Status:** OPEN — explicitly raised by user as the open thread for D2.
- **Verbatim:** *"these verifier should be another higher level of authority OR it is just a prose prompt to the main one or not"*.
- **Option A (higher authority):** verifier = own LLM call (own model, own auth, own context), like pi-until-done's judge but looped. True independent check; no self-review bias; aligns with pi-until-done's cross-model rationale. Cost: N× model calls per goal + extra infra.
- **Option B (prose prompt to main):** verifier = re-prompt of the SAME main model with a "now be a verifier" system prompt. Zero new infra; cheap. BUT self-review bias — the model that did the work reviews the work; contradicts pi-until-done's stated reason for cross-model ("standard fix for Ralph-loop oscillation" [T5]).
- **Assistant recommendation (not yet asked):** Option A. The whole point of pi-until-done's cross-model judge is to escape self-talk; option B throws that away.
- **Load-bearing:** this decision determines the entire infra shape of D2. Resolve FIRST.

### OT9 — "2/2 approval" threshold semantics [T7]
- **Status:** OPEN — ambiguity in user spec.
- **Option (a) Ratio:** 2 of 2 rounds must approve (100% approval, sample size 2).
- **Option (b) Dual threshold:** `passThreshold=2` (need 2 approvals to pass) AND `failThreshold=2` (need 2 rejections to fail), as independent counts.
- **Behavior difference:** under partial disagreement (1 approve, 1 reject), (a) = FAIL, (b) = NEITHER (continue). Need user clarification before D2 implementation.
- **Default captured as:** "2 approvals required to pass". Fail-side semantics unresolved.

> **Verdict (auto-decided 2026-07-04):** Option (b) — dual independent threshold.
> Rationale: D3 mandates fail-CLOSED on indeterminate. Under ratio (a), a single reject out of 2 = hard FAIL → wastes the loop budget on one model hiccup. Dual threshold (b) keeps the loop alive on partial disagreement and only resolves when a real majority forms — better use of the max-turns budget (R4, default 20). Combined with D3: parse_error/unavailable counts toward NEITHER threshold (not auto-fail, not auto-pass).
> Config shape: `{ passThreshold: 2, failThreshold: 2, maxTurns: 20 }`. On `maxTurns` exhausted without passThreshold met → fail-CLOSED (block).
> automate decided with verdict

### OT10 — Verdict object fields beyond skeleton [T7]
- **Status:** OPEN — user invited additional verifier-loop-aligned fields.
- **Skeleton (locked R2):** `{ approval_status: APPROVE|REJECT, reason: string }`.
- **Candidates proposed (assistant, NOT locked):**
  - `round` (int — which verifier round)
  - `severity` (REJECT only: low/medium/high/critical)
  - `defects[]` (REJECT only: specific defects — shape-drift, missing evidence, scope-creep, etc.)
  - `concerns[]` (APPROVE only: non-blocking notes)
  - `model` (which model judged — matters if OT8 = "higher authority")
  - `ts` (timestamp)
  - `evidence_refs[]` (what evidence the verdict cited)
  - `requires_followup` (bool — flag even on APPROVE)
- **Resolve by:** mapping to the existing `verifier-loop` skill's verdict shape (the skill is the reference implementation — its `references/verifier.md` defines what fields a real verifier emits).

> **Verdict (auto-decided 2026-07-04):** ADOPT the `verifier-loop` skill's verdict shape verbatim as the schema of record; the candidate list above is illustrative only.
> Rationale: OT8 resolved tier-2 = self-verify via verifier-loop skill [T8]. The skill's `references/verifier.md` IS the reference implementation — re-inventing fields diverges from the canonical emitter and breaks the round-trip contract between emitter and consumer.
> Action: D2 fork imports the verdict type from the verifier-loop skill's reference doc. No bespoke field set. If the skill's shape lacks a needed field, propose the addition TO THE SKILL (single source of truth), not a fork-local extension.
> automate decided with verdict

## Next-step menu (when resuming)

1. **Resolve OT8 (authority level) + OT9 (threshold semantics) FIRST.** These are load-bearing for D2 and block all implementation. Read turn7 for the option tradeoffs.
2. **If resuming OT1 (verifier-loop fork):** Read `2026-06-27-turn5-pi-until-done-config-audit.md` (files/functions to fork) + `2026-06-27-turn7-verifier-loop-spec.md` (R1–R5 requirements). Then fork `srinitude/pi-until-done` → `buihongduc132/`. For OT10, consult the `verifier-loop` skill's `references/verifier.md` for the canonical verdict shape.
3. **If resuming OT2/OT3 (curator):** Read `flow/findings/curator/gap-analysis.md` + `openspec/specs/curator-*/spec.md`. The curator advisory + skill-curation work is independent of pi-until-done.
4. **If reconsidering D1:** Read `2026-06-27-turn4-authority-comparison-table.md` — the only alternative with real adoption is `pi-codex-goal` (self-decide, NOT Hermes authority).
