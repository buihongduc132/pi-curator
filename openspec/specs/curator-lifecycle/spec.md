# curator-lifecycle Specification

## Purpose
Main-side spawn of curator children, child lifecycle coupling, staleness detection, and janitor GC. Each main session may have N curators (one per persona); each curator is exclusive to ONE main session.
## Requirements
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

The system SHALL filter the main session JSONL into a trimmed fork-input file before each spawn. The filter MUST: (a) operate on the active branch only (ignore off-branch entries), (b) drop `thinking` blocks from assistant messages, (c) PRESERVE `compaction` entries (they carry pre-compaction requirements), (d) preserve `message`, `custom_message`, and `branch_summary` entries, (e) discard non-context entry types (`session_info`, `model_change`, `thinking_level_change`, `label`).

#### Scenario: Thinking blocks are stripped
- **WHEN** the main session JSONL contains an assistant message with `thinking` blocks
- **THEN** the filtered output MUST contain the same assistant message with all `thinking` blocks removed, and the rest of the message content preserved

#### Scenario: Compaction entries are preserved
- **WHEN** the main session JSONL contains a `compaction` entry (with `summary` and `firstKeptEntryId`)
- **THEN** the filtered output MUST include the `compaction` entry intact — it MUST NOT be dropped

#### Scenario: Only active branch is included
- **WHEN** the main session JSONL has off-branch entries from abandoned conversation branches
- **THEN** the filtered output MUST NOT include any off-branch entries

#### Scenario: Non-context entry types are discarded
- **WHEN** the main session JSONL contains `session_info`, `model_change`, `thinking_level_change`, or `label` entries
- **THEN** the filtered output MUST NOT include any of these entry types

---

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

#### Scenario: Curator observability surface (black-box by design)
- **WHEN** a curator is spawned
- **THEN** its observability surface = the pi session store
  (`~/.pi/agent/sessions/`, findable via `pi --resume` by the shipped
  `--name "curator:<alias>"`) PLUS the `curatorSessionId` pointer in the
  pids file [LD1] PLUS the D11 stderr crash-catch
  (`~/.pi-curator/logs/...`)
- **AND** the curator is black-box by design — its reasoning is NOT
  re-emitted to the main turn; it persists as a first-class pi session
  (see design decision D15)
- **AND** the D11 stderr capture exists ONLY for the edge case where the
  curator died before writing any session JSONL; it does not undermine the
  black-box posture

The system SHALL write a PID registration file at `~/.pi-curator/pids/<mainSessionId>/<curator>.json` BEFORE invoking `child_process.spawn`. The file SHALL contain `{pid, mainSessionId, mainSessionName, curator, spawnedAt, heartbeatAt, phase, goalFile}`. The curator runtime SHALL refresh `heartbeatAt` every `heartbeat.intervalSec` seconds (default 5) and update `phase` as it progresses through its task. All file writes SHALL use atomic write (`.tmp.<pid>.<ts>` + rename) and `withLock` around every read-modify-write.

#### Scenario: PID file written before spawn
- **WHEN** the hook decides to spawn a curator
- **THEN** the `pids/<mainSessionId>/<curator>.json` file SHALL be written with `phase: "spawned"` BEFORE `child_process.spawn` is called

#### Scenario: Curator refreshes heartbeat
- **WHEN** the curator runtime is running
- **THEN** it SHALL update `heartbeatAt` to current timestamp every `heartbeat.intervalSec` (default 5) seconds via atomic write

#### Scenario: Curator updates phase during work
- **WHEN** the curator transitions from scanning to signaling
- **THEN** the curator runtime SHALL atomically update the `phase` field in its `pids/` file to `"signaling"`

---

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

