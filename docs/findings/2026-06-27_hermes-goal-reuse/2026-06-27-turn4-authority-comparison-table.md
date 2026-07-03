# Explore Turn 4 — Authority-filtered comparison: stars + weekly/monthly downloads

> Date: 2026-06-27
> Phase: adoption-data gathering + verdict
> Status: only pi-until-done is true Hermes authority port; market voted for self-decide over judge

## [user] (verbatim — trust chain L1)

> **[user]** NOw if the hermes can be completely superset / reuse by a 3rd party , we will use it ; give me all the one that have the authority that be able to completely plug and play ; also give me it stars and monthly / weekly installation as well ; make the comparison table;

## [assistant]

Pulled npm downloads (`api.npmjs.org/downloads/point/last-week` + `/last-month`) and GitHub stars (`api.github.com/repos`) for 12 candidate packages.

### Raw data captured (week / month / stars / last-push)

| Package | Weekly DL | Monthly DL | ★ Stars | Last push |
|---|---|---|---|---|
| `pi-until-done` | 96 | 397 | 28 (srinitude/pi-until-done) | 2026-05-08 |
| `pi-goal-x` | 330 | 5,428 | 19 (tmonk/pi-goal-x) | 2026-06-24 |
| `pi-codex-goal` | 1,882 | 7,647 | **143** (fitchmultz/pi-codex-goal) | 2026-06-26 |
| `@zhushanwen/pi-goal` | 42 | 1,287 | n/a (no repo field) | — |
| `@capyup/pi-goal` | 71 | 464 | 18 (capyup/pi-goal) | 2026-05-13 |
| `@narumitw/pi-goal` | 3,614 | 8,591 | 88 (narumiruna/pi-extensions monorepo) | 2026-06-26 |
| `@qhn/pi-goal` | 48 | 218 | 0 (nqh-packages/pi-goal) | 2026-05-10 |
| `@ramarivera/pi-goal` | 92 | 1,187 | 5 (ramarivera/pi-goal) | 2026-06-09 |
| `@matheusbbarni/pi-goal-extension` | 89 | 157 | n/a | — |
| `@baggiiiie/pi-goal` | 12 | 36 | 40 (baggiiiie/pi-stuff) | 2026-06-26 |
| `pi-agent-goal` | 77 | 460 | 3 (KristjanPikhof/Pi-Agent-Goal) | 2026-06-13 |

### Authority comparison (judge gates the loop)

| Plugin | Authority model | Judge type | Plug-and-play? | ★ | Weekly | Monthly |
|---|---|---|---|---|---|---|
| **`pi-until-done`** | Cross-model judge **gates `until_done_complete`** | 🟢 **Aux LLM** (pi-ai `complete()`, out-of-session) | ⚠️ needs Bun + mise | 28 | 96 | 397 |
| `pi-codex-goal` | Codex-style self-decide + continuation | ❌ none | ✅ zero-dep | **143** | **1,882** | **7,647** |
| `pi-goal-x` | Schema-gated completion tool | 🟡 structural (must fill evidence schema) | ✅ | 19 | 330 | 5,428 |
| `@capyup/pi-goal` | Same as pi-goal-x (fork) | 🟡 structural | ✅ | 18 | 71 | 464 |
| `@zhushanwen/pi-goal` | Evidence-based completion | 🟡 structural (must attach evidence) | ✅ | n/a | 42 | 1,287 |
| `@narumitw/pi-goal` | Regex-rejects "not done" summaries | ❌ none | ✅ | 88 | 3,614 | 8,591 |
| `@qhn/pi-goal` | Self-decide | ❌ none | ✅ | 0 | 48 | 218 |
| `@ramarivera/pi-goal` | Hidden continuation pressure | ❌ none | ✅ | 5 | 92 | 1,187 |

### Strict answer given

**Only ONE plugin is a true Hermes `/goal` authority port** (auxiliary LLM judge that gates the loop, fully reusable by 3rd parties): **`pi-until-done`**. Everything else either has no judge, or has a weaker *structural* gate (must-attach-evidence) rather than an independent LLM verdict.

### The uncomfortable truth about "plug and play"

```
TRUE Hermes /goal authority           ADOPTION
(aux LLM judge gates loop)            
─────────────────────────────────────────────
pi-until-done  ←── the only one ────  96/wk, 28★  ⚠️ LOW


HIGH ADOPTION but NO real judge
─────────────────────────────────────────────
pi-codex-goal           1882/wk, 143★   ← self-decide
@narumitw/pi-goal       3614/wk, 88★    ← regex only
pi-goal-x                330/wk, 19★    ← schema gate (weak)
```

**The market has voted for self-decide, not judge.** The one true Hermes-style authority port (`pi-until-done`) has the **lowest adoption** of the serious contenders — 96 weekly downloads vs 1,800–3,600 for the no-judge plugins.

### Read-before-choose notes

- **`pi-until-done`** is the *only* complete Hermes `/goal` reimplementation (28/29 hooks, cross-model judge, kept out of session context, Esc-cancelable). But: requires Bun + mise, 28★, and the author admits the judge is "opt-in" — default is self-judge. So even the faithful port walks back from authority-by-default.
- **`pi-codex-goal`** has the most stars (143) and highest velocity (1,882/wk) — but it's *Codex-style* (self-decide + continuation pressure), which is the **opposite** authority model from Hermes. Popularity = signal that pi ecosystem prefers trust-the-agent over judge-the-agent.
- **No plugin combines "true aux judge" + "high adoption" + "zero-dep plug-and-play".** That cell of the matrix is empty.

### Decision fork offered

```
If "Hermes authority, faithful port" is non-negotiable:
  → pi-until-done (accept 96/wk, accept Bun+mise dep, accept opt-in judge)

If "plug-and-play + battle-tested" matters more than faithful judge:
  → pi-codex-goal (143★, 1882/wk, but self-decide — NOT Hermes authority)

The gap that NOTHING fills:
  → high-adoption + true aux-LLM-judge + zero-dep
  → this is still genuinely unbuilt
```

For the stated bar ("if Hermes can be completely superset/reused by a 3rd party, we'll use it") — **`pi-until-done` is the only candidate that clears it**, and it clears it thinly. Offered to pull its actual source to verify the judge is genuinely out-of-process and reusable.

### Status at end of turn 4

Verdict: pi-until-done is the only true authority port; market prefers self-decide. Asked if user wants source pull to verify reusability. Next: turn 5 — user asks whether pi-until-done supports custom prompt/model and what its config surface is.
