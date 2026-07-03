# Explore Turn 6 — Locked decision: use pi-until-done for now; document findings

> Date: 2026-06-27
> Phase: decision + documentation instruction
> Status: decision locked; documentation task issued

## [user] (verbatim — trust chain L1)

> **[user]** We will use that until-done for now , later on I will bake the verifier loop into that as well; But currently just note down the findings that we are having ;

(Followed by the explore-findings playbook — full instructions for persisting the conversation to `./flow/findings/<name>/`. The playbook specifies verbatim preservation, per-turn files, README update, locked-decisions + open-threads files.)

## [assistant]

No analysis added. Acknowledged the locked decisions and proceeded to execute the documentation playbook (this file + sibling turn files + README update + locked-decisions + open-threads).

### Locked decisions captured from this turn

- **D1 [T6]**: USE `pi-until-done` (npm package) as the Hermes `/goal` authority port for pi — for now.
- **D2 [T6]**: Later, bake the verifier-loop into pi-until-done. Deferred — not part of the current decision, flagged as future work.

See `2026-06-27-locked-decisions-canonical.md` for the full canonical list (D1–D2 plus derived constraints).

### Implications the assistant flagged for the deferred work (carried into open-threads, NOT new analysis)

When verifier-loop integration happens later, these constraints from the turn-5 source audit will need addressing:
- Judge system prompt is hardcoded (`buildSystemPrompt`) → must be parameterized.
- Judge user-prompt template is hardcoded (`buildUserPrompt`) → must be parameterized.
- Fail-OPEN on `parse_error` / `unavailable` → contradicts authoritative-gate intent → must flip to fail-CLOSED for verifier-loop use.
- Zero env/JSON config today → verifier-loop integration will likely require adding a config layer.

### Status at end of turn 6

Decision locked. Documentation task in progress (this file is part of it). Explore session on Hermes `/goal` reuse concludes with: pi-until-done adopted for now; verifier-loop integration deferred; curator advisory + skill-curation gaps still open (unchanged from prior curator research).
