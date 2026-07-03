# Design — pi-curator-sidecar

## Architecture

```
┌────────────────────── MAIN PI SESSION ───────────────────────────┐
│                                                                   │
│  pi-curator extension (main-side; 1 extension, 2 hooks + cmds)    │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ hook: turn_end                                              │  │
│  │   1. gate: skip if turn < N AND mins-since-spawn < M        │  │
│  │   2. FOR each curator persona (project ⊕ global merged):    │  │
│  │      a. filter this session JSONL → ~/.pi-curator/forks/    │  │
│  │         <mainSessionId>/<curator>-<ts>.jsonl                │  │
│  │         (drop thinking + compaction; see §2)                │  │
│  │      b. trim from top until ≤ curator.contextBudget         │  │
│  │         (target 60% recent turns; hard ceiling 90% budget)  │  │
│  │      c. spawn (detached:false):                             │  │
│  │         pi --fork <filtered.jsonl>                          │  │
│  │            --append-system-prompt <goal.md>                 │  │
│  │            [--exclude-tools <list> | --tools <list>]        │  │
│  │            --name "curator:<alias>"                         │  │
│  │            --model <curator.model>                          │  │
│  │            -p "<task prompt w/ main session name+id>"       │  │
│  │      d. record child PID + spawnTs in                       │  │
│  │         ~/.pi-curator/pids/<mainSessionId>/<curator>.json   │  │
│  │   3. read all pids/*.json → mark stale (>30s) / dead (>120s)│  │
│  │      ui.setStatus("curator: 2 live, 1 stale, 0 dead")      │  │
│  │   4. return immediately (non-blocking)                      │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  pi-curator-receiver (in same extension; customType filter)        │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ hook: message_start (or extension-side message listener)    │  │
│  │   IF incoming customType == "curator_signal":               │  │
│  │     kind = details.kind                                     │  │
│  │     IF kind == "steer":                                     │  │
│  │       pi.sendMessage(                                       │  │
│  │         {customType:"curator_steer", content, details},     │  │
│  │         {triggerTurn:true, deliverAs:"steer"})              │  │
│  │     ELSE IF kind == "append":                               │  │
│  │       pi.sendMessage(                                       │  │
│  │         {customType:"curator_append", content, details},    │  │
│  │         {deliverAs:"nextTurn"})  // NO triggerTurn          │  │
│  │                                                             │  │
│  │ Rationale:                                                  │  │
│  │  - steer w/ triggerTurn wakes idle agent (Edge A)           │  │
│  │  - deliverAs:"steer" queues safely mid-turn (Edge B)        │  │
│  │  - append uses nextTurn: never stalls idle (avoid followUp  │  │
│  │    trap documented in todo-enforcer index.ts:200-212)       │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  slash: /curator list | status | kill <name>                      │
└────────────────────────┬──────────────────────────────────────────┘
                         │ child_process.spawn(detached:false)
                         │  child dies when main dies (SIGHUP/tree-coupled)
        ┌────────────────┴────────────────┐
        ▼                                 ▼
┌───────────────────┐             ┌───────────────────┐
│ curator: "spec"   │             │ curator: "scold"  │
│ (separate pi -p)  │             │ (separate pi -p)  │
│                   │             │                   │
│ forked context:   │             │ forked context:   │
│  filtered+trimmed │             │  filtered+trimmed │
│  JSONL (no think) │             │  JSONL (no think) │
│                   │             │                   │
│ system prompt:    │             │ system prompt:    │
│  goal.md + scope  │             │  goal.md + scope  │
│  + mainSessionId  │             │  + mainSessionId  │
│                   │             │                   │
│ tool: signal_main │             │ tool: signal_main │
│  (kind, message,  │             │  (LLM picks kind) │
│   severity)       │             │                   │
│                   │             │                   │
│ loads pi-intercom │             │ loads pi-intercom │
│  (registers w/    │             │  (registers w/    │
│   broker under    │             │   broker under    │
│   curator:<alias>)│             │   curator:<alias>)│
└─────────┬─────────┘             └─────────┬─────────┘
          │                                   │
          └────────────┬──────────────────────┘
                       │ IntercomClient.send({
                       │   to: <main-name>,
                       │   customType: "curator_signal",
                       │   details: { kind, severity },
                       │   content: message })
                       ▼
       ~/.pi/agent/intercom/broker.sock  (pi-intercom, already running)
                       │
                       ▼
       MAIN's pi-intercom listener → emits customType="curator_signal"
                       │
                       ▼
       pi-curator-receiver hook → maps kind → deliverAs → injects

┌─────────────── PM2 JANITOR (stateless) ──────────────────────────┐
│ name: pi-curator-janitor-<project>     namespace: pi-curator:<p>  │
│ tick: every 5 minutes                                            │
│   • pids/*.json: heartbeatAt stale > 30s AND pid alive → no-op   │
│   • pids/*.json: heartbeatAt stale > 120s OR pid dead →          │
│       SIGTERM pid, archive the pids file                         │
│   • forks/*.jsonl older than 24h → delete                        │
│   • NEVER spawns curators (main owns spawn)                      │
│ Config: janitor.interval (default 5m), janitor.staleSec (30),    │
│         janitor.deadSec (120), janitor.forkTTL (24h)             │
└──────────────────────────────────────────────────────────────────┘
```

## Decision Log

### D1 — Spawn ownership: main owns spawn (NOT janitor)

**Choice:** main's `turn_end` hook spawns; janitor is GC-only.
**Why:** main has the live session JSONL in hand; coupling child lifecycle to
main's lifecycle (via `detached:false`) means clean main exit kills children.
Janitor never holds spawn state → can be killed/restarted freely.
**Rejected:** pm2-driven spawning — adds spawn-state to daemon, must detect
main death to know when to stop spawning, harder to reason about.

### D2 — Child lifecycle coupling: `child_process.spawn({detached:false})`

**Choice:** NOT `nohup`, NOT pm2-spawned. Plain `spawn(detached:false)`.
**Why:** human requirement: "pi dead, child should be dead."
- `nohup ... &` → detaches → orphan on parent death. ❌
- pm2 spawn → daemon owns → survives parent death. ❌
- `spawn(detached:false)` → child in main's process tree → SIGHUP/tree-coupled
  → dies with main. ✅
- `prctl(PR_SET_PDEATHSIG)` (Linux) → kernel signal on parent exit →
  bulletproof, but +native dep. DEFERRED to v2 if SIGHUP proves insufficient.

### D3 — Context input: JSONL-filter (NOT export+markitdown)

**Choice:** filter main session JSONL → trimmed JSONL → `pi --fork`.
**Why:** see `flow/findings/curator-research-context-trim.md`. Strictly dominant:
preserves tool-call/result pairing (`toolCallId`), exact message roles, usage
metadata, truncation markers. Zero deps. Single round-trip. The alternative
(JSONL→HTML→MD via markitdown) loses call↔result linkage, drops usage/model
metadata, adds Python dep + HTML parser, 3 conversions = 3 failure modes.

### D4 — Non-bias: filter strips thinking + compaction by default

**Choice:** JSONL filter drops entries where `message.content[].type ==
"thinking"` and drops `compaction` entries (these encode main's own reasoning).
Opt-in: `curator.<name>.includeThinking: true` adds them back.
**Why:** human requirement: "non-bias is critical." Side-car must see main's
observable actions (user prompts, tool calls, tool results, final assistant
text) — NOT main's self-justifying reasoning. Thinking is the most biased
signal. Stripping it makes the curator an observer, not a confederate.

### D5 — Trim algorithm: char/4 estimate, drop oldest, keep 60% recent

**Choice:** reuse pi's own `estimateTokens(message)` (chars/4, exported from
`@earendil-works/pi-coding-agent`). Walk backwards from newest; accumulate
tokens; cut at the earliest valid cut point that keeps ≤ budget. Valid cut
points = user/assistant/bashExecution/custom/branchSummary entries (NEVER cut
at a tool result — must stay attached to its tool call). Target = 60% of
recent turns within 90% of curator's context budget.
**Why:** pi uses chars/4 for its own compaction; matching it avoids drift.
The 90% ceiling leaves 10% headroom for the curator's system prompt + output.
The 60% target biases toward recency (more signal in recent turns) while
allowing the 90% ceiling as a backstop when the session is short.

### D6 — signal_main transport: pi-intercom broker (NOT new IPC)

**Choice:** curator's `signal_main` tool wraps `IntercomClient.send()` with
`customType: "curator_signal"` + `details.kind`. Main-side receiver maps
`kind`→`deliverAs`.
**Why:** see `flow/findings/curator-research-signal-main.md`.
`pi.sendUserMessage`/`pi.sendMessage` are IN-PROCESS ONLY — a child pi process
cannot reach a parent's session through them. Building a new IPC channel
reimplements what `pi-intercom` already does (broker, length-prefixed JSON,
session targeting, idle-aware delivery, reconnect, auto-spawn). `pi-intercom`
is already running on this machine.
**Crucial detail:** stock `intercom send` ALWAYS triggers a turn on idle
recipient, so it can't express `kind=append`. By tagging with a custom
`customType` and intercepting in a receiver extension on main, we regain full
control of `deliverAs`/`triggerTurn`:
- `steer` → `sendMessage({triggerTurn:true, deliverAs:"steer"})` (wakes idle,
  queues mid-turn).
- `append` → `sendMessage({deliverAs:"nextTurn"})` (NO `triggerTurn`; rides
  next user prompt; avoids the `followUp`-against-idle stall trap).

### D7 — Staleness: teams' `heartbeat-lease.ts` reused verbatim

**Choice:** per-curator heartbeat file
`~/.pi-curator/pids/<mainSessionId>/<curator>.json` containing
`{pid, heartbeatAt, phase}`. Curator child refreshes every 5s. Main reads at
`turn_end`; stale > 30s, dead > 120s. Plus optional `process.kill(pid, 0)`
fast-path "definitely dead" check (safe addition teams doesn't make).
**Why:** see `flow/findings/curator-research-teams-staleness.md`. Teams does
NOT use PID checks for liveness — purely timestamp-based.
`heartbeat-lease.ts` is dependency-free and copy-pasteable.
`team-attach-claim.ts` is the right model for "one curator per main session"
(single-holder lock with heartbeat refresh).
**Constants (env-tunable):** heartbeat interval 5s, stale 30s, dead 120s,
prune 1h.

### D8 — Tool trim default: NONE (omit `--exclude-tools`)

**Choice:** if a curator config has no `excludeTools`/`tools` field, the spawn
omits the flag entirely (curator inherits main's full tool surface, less
`signal_main`'s own addition).
**Why:** human instruction: "leave that default to nothing omit for me."
Curator persona configs that want trimming opt in explicitly.

### D9 — Mode is curator's judgment, NOT preconfigured

**Choice:** `signal_main` exposes both kinds; the curator's goal prompt teaches
WHEN to steer vs append. Mode is NOT a config field.
**Why:** human correction. A spec-checker may want to `append` most findings
but `steer` on critical deviations — preconfiguring locks it to one. Letting
the LLM pick per-finding matches the human's mental model: "child decides to
intercom or not."

### D10 — Curator process composition

Each curator is `pi -p` with:
- `--fork <filtered.jsonl>` — non-bias context.
- `--append-system-prompt <goal.md>` — persona goal, scope, main session id.
- `--name "curator:<alias>"` — friendly identifier (also intercom registration).
- `--model <curator.model>` — per-persona model override (default: cheap
  reviewer like `sonnet:low`).
- Optional `--exclude-tools <list>` or `--tools <list>` — only if config sets
  it (D8).
- `-p "<task prompt>"` — the actual review instruction, including the main
  session name + id so the curator knows where to send signals.

The curator loads `pi-curator-runtime` extension which registers `signal_main`
and a heartbeat writer (refreshes pids file every 5s). It also loads
`pi-intercom` (already a project dep) to register with the broker.

## Open Questions (resolved at implementation time, not blocking proposal)

1. Does `pi-intercom` forward full `details` (incl. `kind`) on incoming
   delivery? §4 of signal-main research says `details: entry` is passed through
   verbatim, but a probe test should confirm before building the receiver.
2. Slash command surface — should `/curator kill <name>` SIGTERM the live PID,
   or just mark the heartbeat file as "killed" and let janitor sweep it?
   Lean: SIGTERM immediately + mark file (faster feedback).
3. Should the spawn gate be per-curator or global? Lean: per-curator
   (`curator.<name>.spawn.{everyTurns, everyMins}`) with a sensible default.
