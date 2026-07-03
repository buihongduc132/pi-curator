# Explore Turn 5 — pi-until-done config + judge audit (source read)

> Date: 2026-06-27
> Phase: source verification
> Status: model ✅ configurable; prompt ❌ hardcoded; fail-OPEN on parse error; zero env/JSON config

## [user] (verbatim — trust chain L1)

> **[user]** Can the pi-until-done having the custom prompt / model on itself ? What are the configuration that it have ?

## [assistant]

Cloned `srinitude/pi-until-done` (shallow) to `/tmp/piud/pi-until-done`. (Initial `rm -rf /tmp/...` blocked by CC Safety Net — used `mkdir` instead.)

Files read:
- `extensions/lib/schemas/set-fields.ts` (the North Star contract schema)
- `extensions/lib/tools/judge.ts` (the cross-model judge implementation)
- `extensions/lib/tools/complete.ts` (how verdict is consumed)
- `extensions/lib/constants.ts`
- repo file tree (`find ... -name '*.ts'`)

### Config surface — full

**Per-goal** (set via `/until-done` interview → `until_done_set` tool). Schema fields from `set-fields.ts`:

| Field | Type | Default |
|---|---|---|
| `goal` | string | — |
| `doneCriteria` | string | — |
| `verifyCommand` | string? | none |
| `askBefore[]` | string[] | — |
| `decisionStyle` | string | — |
| `goalType` | `ticket` \| `exploratory` | — |
| `surfaces[]` | `{kind, location, notes}[]` | `[]` |
| `startPhase` | phase? | — |
| `maxTurns` | int? | 20 (hard ceiling 20000) |
| `judgeModel` | `{provider, modelId}`? | — |
| `sameModelJudge` | bool? | — |

`JudgeModelSchema` doc (verbatim from schema): "Cross-model judge — a DIFFERENT model than the executor. This is the default judge mode: every `until_done_complete` is gated by this judge. Cross-model is the standard fix for Ralph-loop oscillation... If you do not have a separate judge model available, set `sameModelJudge: true`..."

**Session defaults** (via slash subcommands):
- `/until-done judge <provider>/<modelId>` — session-default judge model
- `/until-done judge same` — self-judge default
- `/until-done budget <n>` — default turn budget
- `/until-done autopilot` — skip contract dialog

**Config file / ENV vars:** ❌ **NONE.** `rg` for `process.env.|getConfig|config.\w+|settings.` in `extensions/lib` returned nothing relevant. Zero `process.env`, zero JSON config. Everything lives in pi session state (custom entries, type `until-done.state`). No `~/.until-done/`, no `.until-done.config.json`.

### Judge implementation (`extensions/lib/tools/judge.ts`)

`buildSystemPrompt()` — **HARDCODED** 9-line string, NOT exported:
```
"You are a strict completion judge for /until-done.",
"The executor will claim a goal is done with cited evidence.",
"Your job: decide whether the done-criteria are LITERALLY satisfied.",
"Treat uncertainty as not-yet-done. Reject proxy signals (e.g. 'looks fine', 'should work').",
"",
'Respond ONLY with a single JSON object: {"verdict": "done" | "continue", "reason": "<one sentence>"}.',
'"done" means the criteria are literally satisfied per the cited evidence.',
'"continue" means the executor needs more work or stronger evidence.',
"No prose outside the JSON.",
```

`buildUserPrompt(state, evidence, summary)` — **HARDCODED** template:
```
Goal: ${state.goal}
Done criteria: ${state.doneCriteria}
Verify command: ${state.verifyCommand ?? "(none)"}

Evidence claimed by executor:
${evidence}
${summary ? `\nSummary: ${summary}` : ""}

Is the goal achieved?
```

`runJudge()`:
- `auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)` — if `!auth.ok` → verdict `unavailable`.
- `complete(model, {systemPrompt, messages}, {apiKey, headers, signal})` from `@mariozechner/pi-ai`.
- On throw → verdict `unavailable`.

`interpretJudge(raw)`:
- `extractJson` tries direct parse, then `{`...`}` slice.
- If parse fails → verdict `parse_error`.
- If `verdict` not `done`/`continue` → `parse_error`.

### Verdict consumption (`extensions/lib/tools/complete.ts`)

`decideJudge()`:
- if `judgeModel` → `consultJudge`
- elif `sameModelJudge` → `consultSelfJudge`
- else → verdict `unavailable` ("contract has neither... should have been caught at until_done_set")

`executeComplete()`:
- if verdict === `continue` → `refuseCompletion` (persists evidence + "judge rejected completion")
- **else (done / parse_error / unavailable) → `completeWithApproval`**

### Critical finding: fail-OPEN

```
verdict === "continue"        → REJECT (refuseCompletion)
verdict === "done"            → APPROVE
verdict === "parse_error"     → APPROVE  ← silent approval on malformed JSON
verdict === "unavailable"     → APPROVE  ← silent approval when judge/auth fails
```

`completeWithApproval` is called with `decision` for ANY non-`continue` verdict. The `judgeAnnotation` for `parse_error` says "judge response could not be parsed" but completion STILL proceeds.

### Summary given to user

```
WHAT YOU CAN CONFIGURE         WHAT'S HARDCODED
─────────────────────────      ─────────────────────────
judgeModel {provider,modelId}  judge system prompt
 /until-done judge <p>/<m>      (buildSystemPrompt — fixed
sameModelJudge: true            9-line string, not exported)
maxTurns / budget               judge user prompt template
verifyCommand                   (buildUserPrompt — fixed)
doneCriteria, askBefore         fail-open logic
decisionStyle, surfaces[]       (parse_error → APPROVE)
goalType (ticket/exploratory)
```

### Hard limit for reuse

```
┌──────────────────────────────────────────────────┐
│  judge prompt = HARDCODED 9-line string           │
│  judge user-prompt = HARDCODED template           │
│  fail-open = APPROVE on parse_error/unavailable   │
│                                                   │
│  → You CANNOT repurpose the judge for advisory    │
│    mid-loop nudges, different verdict vocab,      │
│    stricter rejection, or curator-style signal.   │
│  → Fork required for any prompt/behavior change.  │
└──────────────────────────────────────────────────┘
```

### Verdict against "plug-and-play reuse" bar

```
MODEL:   ✅ configurable (per-goal + session default)
PROMPT:  ❌ hardcoded → CANNOT reuse judge for anything
         but "is this literal done-criteria met?"
FAIL:    ⚠️ fail-OPEN (parse_error & unavailable → APPROVE)
         — contradicts authoritative-gate intent
```

**Not fully plug-and-play.** Can pick the judge *model*, but cannot shape the judge *behavior* without forking. Fail-open-on-parse-error means it's authoritative **only when the judge cleanly returns** — malformed JSON silently approves completion.

If reuse case is exactly "gate /goal completion with a second model checking done-criteria" → works as-is. If judge mechanism wanted for *anything else* (advisory nudges, curator signals, custom verdict schema) → forking `judge.ts` required.

Offered to check how invasive a fork would be (is the hardcoded prompt centralized enough for a 20-line swap + config field?).

### Status at end of turn 5

Source audit complete. Model configurable, prompt hardcoded, fail-open. Noted fork required for any prompt/behavior customization. Next: turn 6 — user locks decision to USE pi-until-done for now + defers verifier-loop integration to later.
