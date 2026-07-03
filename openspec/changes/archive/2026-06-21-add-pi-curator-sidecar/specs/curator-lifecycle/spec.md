# Spec — curator-lifecycle

## Purpose
Main-side spawn of curator children, child lifecycle coupling, staleness
detection, and janitor GC. Each main session may have N curators (one per
persona); each curator is exclusive to ONE main session.

## ADDED Requirements

### Requirement: Spawn trigger
- The extension MUST register a `turn_end` hook on the main session.
- The hook MUST evaluate, per configured curator persona, a spawn gate:
  `turnsSinceLastSpawn >= persona.spawn.everyTurns` OR
  `minsSinceLastSpawn >= persona.spawn.everyMins`.
- If the gate is not satisfied for any persona, the hook MUST return without
  spawning and without blocking.
- The hook MUST be non-blocking: total wall time from hook entry to return
  MUST be ≤ 100ms (filtering + spawn only; LLM work happens in the child).


#### Scenario: Spawn gate at turn_end
- **WHEN** turn_end hook fires and gate satisfied
- **THEN** curator child spawned
- **AND** hook wall time at most 100ms
### Requirement: Non-bias context filter
- Before spawning, the hook MUST produce a filtered copy of the main session
  JSONL at `~/.pi-curator/forks/<mainSessionId>/<curator>-<spawnTs>.jsonl`.
- The filter MUST drop every `message` entry whose `content` contains a block
  with `type: "thinking"`.
- The filter MUST drop every `compaction` entry.
- The filter MUST drop entries of types: `custom`, `model_change`,
  `thinking_level_change`, `label`, `session_info`.
- The filter MUST preserve: `message` (user/assistant text + tool calls +
  tool results, minus thinking blocks), `custom_message`,
  `branch_summary`.
- If `persona.includeThinking === true`, thinking blocks are preserved
  (opt-in bias).


#### Scenario: Thinking blocks dropped
- **WHEN** filtered JSONL produced for curator
- **THEN** thinking blocks and compaction removed
- **AND** messages and tool results preserved
### Requirement: Context trim
- After filtering, the hook MUST trim the JSONL from the top (oldest first)
  so the resulting context fits the curator's budget.
- Budget = `persona.contextBudget` if set, else 90% of the curator model's
  declared context window.
- Token estimation MUST use the same heuristic as pi core (`estimateTokens` —
  chars/4 per message block; tool results count chars of their content).
- Trim walks backwards from the newest entry, accumulating tokens, and cuts
  at the earliest valid cut point that keeps total ≤ budget.
- Valid cut points: `message` (user/assistant/bashExecution),
  `custom_message`, `branch_summary`. NEVER cut at a `toolResult` message
  (it must stay attached to its tool call).
- Soft target: prefer keeping the most recent 60% of turns. The 90%-budget
  ceiling is the hard backstop when 60% target is exceeded.


#### Scenario: Trim to budget
- **WHEN** filtered JSONL exceeds budget
- **THEN** trimmed from top oldest first
- **AND** never cuts at toolResult
### Requirement: Child spawn
- The hook MUST spawn the curator via `child_process.spawn` with
  `detached: false` and `stdio: ['ignore', 'ignore', 'ignore']` (or piped to
  a per-curator log file under `~/.pi-curator/logs/`).
- The spawn command MUST be:
  ```
  pi --fork <filtered.jsonl>
     --append-system-prompt <persona.goalFile>
     --name "curator:<persona.alias>"
     --model <persona.model>
     [-p "<task prompt with main session name+id>"]
     [--exclude-tools <persona.excludeTools> | --tools <persona.tools>]
  ```
- If `persona.excludeTools` is unset AND `persona.tools` is unset, the
  `--exclude-tools`/`--tools` flag MUST be omitted entirely (curator inherits
  main's tool surface).
- The hook MUST NOT use `nohup`, `setsid` detach, or pm2 to spawn.
- The child MUST die when the main process dies (achieved via
  `detached:false`; SIGHUP on parent exit).


#### Scenario: Detached false spawn
- **WHEN** spawn gate satisfied
- **THEN** curator spawned with detached:false
- **AND** child dies when main exits
### Requirement: PID + heartbeat registration
- On spawn, the hook MUST write
  `~/.pi-curator/pids/<mainSessionId>/<curator>.json` atomically with:
  ```json
  {
    "pid": <child PID>,
    "mainSessionId": "<id>",
    "mainSessionName": "<name>",
    "curator": "<alias>",
    "spawnedAt": "<ISO>",
    "heartbeatAt": "<ISO>",     // initial = spawnedAt; curator refreshes
    "phase": "spawned",
    "goalFile": "<path>"
  }
  ```
- The curator child (via `pi-curator-runtime` extension) MUST refresh
  `heartbeatAt` every 5s while alive and update `phase` to `running`,
  `signaling`, or `done`.


#### Scenario: PID file on spawn
- **WHEN** curator child spawned
- **THEN** PID file written atomically
- **AND** heartbeat refreshed every 5s
### Requirement: Staleness detection at turn_end
- After spawning (or skipping spawn), the hook MUST read all
  `~/.pi-curator/pids/<mainSessionId>/*.json` files and classify each:
  - `live`: `now - heartbeatAt ≤ 30s` AND (optional fast-path)
    `process.kill(pid, 0)` succeeds.
  - `stale`: `30s < now - heartbeatAt ≤ 120s`.
  - `dead`: `now - heartbeatAt > 120s` OR `process.kill(pid, 0)` fails.
- The hook MUST surface a summary via `ctx.ui.setStatus` (UI-only; not in
  conversation context per AGENTS.md indicator-visibility rule):
  e.g. `"curator: 2 live, 1 stale, 0 dead"`.
- The hook MUST NOT inject stale/dead status into the session branch (delegated
  agents must not see it).


#### Scenario: Stale and dead classification
- **WHEN** hook reads PID files
- **THEN** 30-120s since heartbeat = stale, >120s or dead process = dead
- **AND** status via UI only
### Requirement: Exclusivity — one curator per (main session, persona)
The system SHALL enforce that for each `<mainSessionId>/<curator>` pair, at most one live curator PID is
  allowed.
- Before spawning, the hook MUST check the existing pids file. If a live or
  stale curator exists for that persona, the hook MUST skip spawning for this
  turn (log to UI; do not error).
- Reuse `team-attach-claim.ts`'s single-holder pattern (heartbeat-refreshed
  claim).


#### Scenario: Duplicate spawn skipped
- **WHEN** gate fires for persona with live curator
- **THEN** spawn skipped, logged to UI
### Requirement: PM2 janitor (GC only)
- The package MUST ship a janitor script `janitor/pi-curator-janitor.mjs`
  intended to run under pm2 with name `pi-curator-janitor-<project>` and
  namespace `pi-curator:<project>`.
- The janitor MUST tick every `janitor.interval` (default 5m) and:
  - For each `pids/*.json`: if `dead` (per REQ-LC-06 rule), `SIGTERM` the PID
    (if alive), archive the pids file to
    `~/.pi-curator/pids-archive/<mainSessionId>/<curator>-<ts>.json`.
  - For each `forks/*.jsonl` older than `janitor.forkTTL` (default 24h),
    delete it.
- The janitor MUST NOT spawn curators (spawn is owned by main per REQ-LC-04).
- The janitor MUST be stateless: killing and restarting it MUST NOT affect
  any live curator.


#### Scenario: Janitor sweeps dead
- **WHEN** janitor ticks every 5m
- **THEN** dead curators SIGTERMd and PID archived
- **AND** janitor never spawns
### Requirement: Slash commands
- The extension MUST register `/curator` with subcommands:
  - `list` — list all curators for the current main session (alias, phase,
    heartbeat age).
  - `status [<name>]` — detailed status of one or all curators.
  - `kill <name>` — `SIGTERM` the named curator's PID immediately and mark
    its pids file `phase: "killed"`.
  - `restart <name>` — kill then spawn fresh (re-evaluates spawn gate).


#### Scenario: /curator list
- **WHEN** user runs /curator list
- **THEN** all curators shown with alias, phase, heartbeat age
### Requirement: Non-blocking on failure
- If filtering fails (malformed JSONL line), the hook MUST skip that line and
  continue. If the entire filter fails, the hook MUST log to UI and return
  without spawning (do not block the main turn).
- If `spawn` fails (ENOENT, EPERM), the hook MUST log to UI and return.
- Exceptions in the hook MUST be caught, logged, and return a safe default
  (per AGENTS.md "Exception Safety" rule).


#### Scenario: Failure does not block
- **WHEN** filter or spawn fails
- **THEN** logged to UI, returns without blocking
- **AND** exceptions caught
## Non-goals (this capability)
- Curator→curator cross-check (deferred).
- Main-side file mailbox for pending signals (deferred — `pi-intercom`
  handles delivery).
- `prctl(PR_SET_PDEATHSIG)` Linux kernel-level parent-death signal (deferred
  to v2; SIGHUP via `detached:false` is v1).
