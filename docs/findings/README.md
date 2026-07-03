# Curator / Memory Consolidation Research

> Date range: 2026-06-09 → 2026-06-27
> Status: **research + decision landed** — pi-until-done adopted for the goal-judge half; curator advisory + skill-curation still open gaps.

## Topics

### Hermes Curator vs pi ecosystem (2026-06-09)
Comparison of Hermes' Curator system with pi ecosystem offerings. Conclusion: no existing pi package implements Hermes Curator (periodic background skill lifecycle with LLM consolidation). Closest is `pi-persistent-intelligence` (governs memory records, not skills). Gap: skill usage telemetry, lifecycle FSM, provenance tracking, background LLM skill review. Files: `hermes-curator-reference.md`, `pi-ecosystem-landscape.md`, `gap-analysis.md`.

### Hermes /goal reuse + goal-judge plugin selection (2026-06-27)
Explored whether Hermes `/goal`'s sidecar LLM judge could be squeezed into the planned curator, or should be a separate plugin. Reframed as inverse-authority problem (curator = advisory, goal-judge = authoritative gate). Searched pi.dev/packages + npm + GitHub for existing goal-mode plugins. Found a whole `/goal` ecosystem; only `pi-until-done` is a faithful Hermes `/goal` authority port (aux LLM judge, out-of-session). Audited pi-until-done source: judge model configurable, but judge PROMPT hardcoded + fail-OPEN on parse error. **Decision locked: use pi-until-done for now; bake verifier-loop in later (deferred).** Verifier-loop spec refined in turn7: per-/goal JSON verdict file (R1–R2), configurable thresholds default 2/2 (R3, semantics open OT9), max turns default 20 (R4), two-tier trigger — verifier activates only after main authority passes "init goal" (R5). Open: authority level of verifier (OT8), threshold semantics (OT9), verdict fields (OT10). Curator advisory mid-loop nudges + skill/memory curation remain unbuilt gaps. Files in `2026-06-27_hermes-goal-reuse/`.

## Pick up next time
1. `2026-06-27_hermes-goal-reuse/2026-06-27-locked-decisions-canonical.md` — locked decisions (D1 use pi-until-done, D2 verifier-loop later with requirements R1–R5) + derived constraints.
2. `2026-06-27_hermes-goal-reuse/2026-06-27-open-threads.md` — OT1 verifier-loop fork blockers, OT8 authority-level (load-bearing for D2), OT9 threshold semantics, OT10 verdict fields, OT2/OT3 curator gaps, OT4/OT5 sustainability.
3. `2026-06-27_hermes-goal-reuse/2026-06-27-turn7-verifier-loop-spec.md` — the verifier-loop requirements (R1–R5) + the OT8 option tradeoffs (higher authority vs prose prompt).
4. `gap-analysis.md` — the curator build plan (orthogonal to the pi-until-done decision).
5. Open decisions: OT8 (authority level) and OT9 (threshold semantics) must be resolved BEFORE the OT1 fork starts.
