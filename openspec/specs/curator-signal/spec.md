# curator-signal Specification

## Purpose
The curator (separate pi process) signals findings back to its spawning main session. ONE multiplex tool (signal_main) exposes two kinds; the curator LLM picks per finding. Transport is the existing pi-intercom broker.
## Requirements
### Requirement: signal_main tool surface
- The `pi-curator-runtime` extension (loaded by the curator child) MUST
  register a single LLM-callable tool `signal_main`.
- Parameters:
  ```typescript
  {
    kind: "steer" | "append",   // REQUIRED
    message: string,            // REQUIRED — the finding/nudge text
    severity?: "info" | "warn" | "critical"  // OPTIONAL, default "info"
  }
  ```
- The tool description MUST teach the LLM when to use each kind:
  - `steer`: "Use when the finding is urgent and requires the main session to
    re-think NOW (critical deviation from requirements, data-loss risk,
    explicit rule violation). Forces a new turn."
  - `append`: "Use for non-urgent findings, notes, observations. Adds context
    for the main session's NEXT turn without interrupting. Non-intrusive."
- The tool description MUST include the main session name + id (passed via
  the curator's task prompt) so the LLM knows where signals go.

#### Scenario: Steer signal sent
- **WHEN** curator calls signal_main with kind:steer
- **THEN** finding dispatched to main via pi-intercom

### Requirement: Transport — pi-intercom broker
- `signal_main.execute` MUST send via `pi-intercom`'s `IntercomClient.send()`
  (the curator loads `pi-intercom` as a dependency and registers with the
  broker under name `curator:<alias>`).
- The sent message MUST use:
  ```typescript
  {
    to: <mainSessionName>,           // resolved from curator's task prompt
    customType: "curator_signal",
    content: message,
    details: {
      kind,
      severity,
      curatorAlias,
      mainSessionId,                 // round-trip for receiver verification
      spawnedAt
    }
  }
  ```
- If `pi-intercom` broker is unreachable, the tool MUST retry once (broker
  auto-spawns on first connect per `spawn.ts`), then return a tool error to
  the curator LLM. The curator may then write the finding to a fallback file
  `~/.pi-curator/findings/<mainSessionId>/<curator>-<ts>.jsonl` (best-effort;
  main can be configured to surface these in `/curator status`).

#### Scenario: Signal via broker
- **WHEN** signal_main.execute called
- **THEN** sent via IntercomClient.send with customType:curator_signal
- **AND** retry once on broker unreachable

### Requirement: Main-side receiver
- The main-side `pi-curator` extension MUST listen for incoming messages with
  `customType === "curator_signal"` (via `pi-intercom`'s incoming-message hook
  or the extension's `message_start` hook filtering on customType).
- On receipt, the receiver MUST re-inject into the main session using the
  mapping:
  | `details.kind` | Receiver action |
  |---|---|
  | `steer` | `pi.sendMessage({customType:"curator_steer", content, details}, {triggerTurn:true, deliverAs:"steer"})` |
  | `append` | `pi.sendMessage({customType:"curator_append", content, details}, {deliverAs:"nextTurn"})` (NO `triggerTurn`) |
- The receiver MUST verify `details.mainSessionId === this-session-id` before
  injecting (defense against misrouted signals).
- The receiver MUST catch all exceptions and log to UI (per AGENTS.md
  Exception Safety); never block the main turn.

#### Scenario: Steer triggers turn
- **WHEN** receiver gets curator_signal with kind:steer
- **THEN** injected via pi.sendMessage with triggerTurn:true
- **AND** mainSessionId verified

### Requirement: Steer semantics — wake idle, queue mid-turn
- `kind=steer` MUST trigger a new turn when main is idle (`triggerTurn:true`).
- `kind=steer` MUST queue mid-turn and deliver after the current assistant
  turn's tool calls complete, before the next LLM call (`deliverAs:"steer"`).
- The receiver MUST NOT use `deliverAs:"followUp"` for steer (avoids the
  followUp-against-idle stall trap documented in `todo-enforcer/index.ts:
  200-212`).

#### Scenario: Steer wakes idle
- **WHEN** steer arrives while idle
- **THEN** new turn triggered
- **AND** followUp not used

### Requirement: Append semantics — never force a turn
- `kind=append` MUST NOT trigger a turn. It rides the next user prompt
  (`deliverAs:"nextTurn"`).
- The receiver MUST NOT pass `triggerTurn` for append.
- This satisfies the "non-intrusive" requirement: append is ambient context.

#### Scenario: Append silent
- **WHEN** append signal arrives
- **THEN** no turn triggered
- **AND** rides next user prompt

### Requirement: Display
- Steer messages MUST be visible (`display:true`) so the user sees the
  curator's intervention.
- Append messages MAY be `display:false` (silent context) OR `display:true`
  per curator persona config (`persona.appendDisplay`, default `false`).
- Both MUST be stored in the session JSONL (so future turns see them) but
  must NOT appear in the conversation branch that delegated agents (ACP,
  teams) see — UNLESS they carry safety/rule-violation signal (severity
  `critical`), in which case they persist (per AGENTS.md
  indicator-visibility rule).

#### Scenario: Steer visible append silent
- **WHEN** steer injected
- **THEN** displayed to user
- **AND** append default display:false

### Requirement: Non-interactive main guard
When the main session runs in non-interactive (`pi -p`) mode, the receiver extension SHALL filter on `customType === "curator_signal"` BEFORE the stock intercom auto-reply fires.
- If main is running in non-interactive (`pi -p`) mode, the stock
  `pi-intercom` tool sends a structured "cannot respond" reply instead of
  queuing (per `pi-intercom/index.ts:670-687`).
- The receiver extension filters on `customType === "curator_signal"` BEFORE
  that auto-reply fires, so curator signals are still processed.
- IMPLEMENTATION NOTE: verify during build that the receiver's filter runs
  before the auto-reply; if not, the receiver must subscribe at the broker
  level rather than the intercom-tool level.

#### Scenario: Signals in -p mode
- **WHEN** main runs non-interactive
- **THEN** curator_signal filtered before auto-reply
- **AND** signals still processed

### Requirement: Severity routing
The system SHALL route signals based on severity level.
- `severity=info` — display per REQ-SG-06; no special handling.
- `severity=warn` — display per REQ-SG-06; UI notify (`ctx.ui.notify(...,
  "warning")`) in addition to the injected message.
- `severity=critical` — steer regardless of curator's chosen `kind` (override
  to force attention); UI notify `"error"`; persist in conversation context.

#### Scenario: Critical forces steer
- **WHEN** signal severity:critical
- **THEN** kind overridden to steer
- **AND** UI error shown

