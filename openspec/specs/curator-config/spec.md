# curator-config Specification

## Purpose
Configuration schema for curator personas, spawn gates, model overrides, and tool-trim lists. Layered global + project per pi-config-parity 3-layer rule (ENV > global JSON > project JSON > defaults).
## Requirements
### Requirement: Global config location
- Global config MUST live at `~/.pi-curator/curators.json` (JSON with comments
  allowed).
- It defines curator personas available to ALL projects unless overridden or
  disabled per project.

#### Scenario: Global config loaded at session start
- **WHEN** the main pi session starts
- **THEN** the extension reads ~/.pi-curator/curators.json for global personas
- **AND** all personas available to every project unless overridden

### Requirement: Project config location
- Project-local config MUST live at `<project-root>/.pi-curator/curators.json`.
- It can: add new personas (project-specific), override fields of global
  personas, disable global personas (`enabled:false`), and set janitor
  defaults for the project.

#### Scenario: Project config overrides global
- **WHEN** a project has .pi-curator/curators.json
- **THEN** the project config can add, override, or disable global personas

### Requirement: Merge semantics
The system SHALL compute the effective config as a deep-merge of: defaults, global, and project.
- The effective config = deep-merge of: defaults ← global ← project.
- Personas are keyed by `alias`. A project persona with the same alias as a
  global persona OVERRIDES the global one (field-by-field deep merge, not
  replace).
- A project persona can disable a global persona:
  ```jsonc
  { "curators": { "security-audit": { "enabled": false } } }
  ```
- If a persona is disabled in either layer, it is NOT spawned.

#### Scenario: Deep merge of configs
- **WHEN** both global and project define a persona with same alias
- **THEN** project fields deep-merge onto global
- **AND** enabled:false disables the persona

### Requirement: Persona schema

Each persona in the merged config SHALL support the following fields with documented defaults: `enabled` (default `true`), `alias` (required, friendly non-jargon name), `goalFile` (required, absolute or project-relative path), `taskPrompt` (optional, overrides the default task prompt template), `model` (optional, defaults to main's model), `scope` (default `"main-only"`), `spawn.everyTurns` (optional), `spawn.everyMins` (optional), `includeThinking` (default `false`), `contextBudget` (optional, overrides the model's context window for trim), `excludeTools` OR `tools` (mutually exclusive — both set is a config error), `appendDisplay` (default `false`), `heartbeat.intervalSec` (default `5`), `heartbeat.staleSec` (default `30`), `heartbeat.deadSec` (default `120`).

#### Scenario: Alias is required
- **WHEN** a persona entry has no `alias` field
- **THEN** the system SHALL reject the config with an error indicating the persona is missing its alias

#### Scenario: excludeTools and tools are mutually exclusive
- **WHEN** a persona sets BOTH `excludeTools` and `tools`
- **THEN** the system SHALL reject the config with an error indicating the two fields are mutually exclusive

#### Scenario: Tool trim defaults to none
- **WHEN** a persona config sets NEITHER `excludeTools` NOR `tools`
- **THEN** the spawn command SHALL omit both `--exclude-tools` and `--tools` flags entirely (the curator inherits all default tools)

#### Scenario: Disabled persona is skipped
- **WHEN** a persona has `enabled: false`
- **THEN** the spawn hook SHALL skip that persona even if its gate would otherwise pass

---

### Requirement: Janitor config
The system SHALL support a janitor configuration at the top level of both global and project config.
At top level of both global and project config:
```typescript
interface CuratorJanitorConfig {
  enabled?: boolean;        // default true
  interval?: string;        // duration; default "5m"
  staleSec?: number;        // default 30; must match persona defaults
  deadSec?: number;         // default 120
  forkTTL?: string;         // duration; default "24h"
}
```
The janitor reads project config (NOT global — janitor is per-project via pm2
namespace `pi-curator:<project>`).

#### Scenario: Janitor runs per-project
- **WHEN** janitor enabled with interval 5m
- **THEN** it runs under pm2 and sweeps dead curators
- **AND** deletes forks older than forkTTL

### Requirement: Scope — main-only by default
The default scope for curator personas SHALL be `"main-only"`: a curator sees ONLY the session that spawned it.
- The default scope is `"main-only"`: a curator sees ONLY the session that
  spawned it (its forked JSONL contains only that session's filtered entries).
- `"all-sessions"` scope is OPT-IN and UNSPECIFIED in v1 — reserved for
  future cross-session curators. Implementing it requires a privacy review
  (curator would need read access to other session JSONL files).

#### Scenario: Curator sees only spawning session
- **WHEN** curator spawned with default scope main-only
- **THEN** forked JSONL has only spawning session entries
- **AND** all-sessions ignored in v1

### Requirement: Persona alias rules
- `alias` MUST be a friendly name (not jargon). Examples: `"spec"`,
  `"scold"`, `"security"`. Curator intercom name = `"curator:<alias>"`.
- Alias MUST match the JSON key under `curators.*`.
- Alias MUST be filesystem-safe (used in paths
  `~/.pi-curator/pids/<mainSessionId>/<alias>.json`).

#### Scenario: Alias in paths and names
- **WHEN** persona alias is spec
- **THEN** intercom name is curator:spec and PID at ~/.pi-curator/pids/session/spec.json

### Requirement: Task prompt template
- If `persona.taskPrompt` is unset, the runtime MUST use a default template:
  ```
  You are curator:<alias>, a side-car reviewer of main session <name>
  (id: <mainSessionId>).

  Your goal: <contents of persona.goalFile>

  Scope: you see ONLY the main session that spawned you. You cannot see other
  sessions.

  Use the `signal_main` tool to send findings back to the main session.
  - kind="steer" when the finding is urgent and requires immediate re-think.
  - kind="append" for non-urgent observations; the main session will see them
    on its next turn.

  Do NOT modify the main session's files. Do NOT spawn other curators. When
  done, exit.
  ```
- The runtime MUST inject `<mainSessionName>`, `<mainSessionId>`,
  `<alias>`, and goalFile contents into the template.

#### Scenario: Default task prompt
- **WHEN** persona has no taskPrompt
- **THEN** default template used with session name, id, alias, goal file injected

### Requirement: Config validation
- On main session start AND on `/curator reload`, the extension MUST validate
  the merged config. Errors:
  - `goalFile` does not exist → persona is disabled with a UI warning.
  - `alias` is not filesystem-safe → persona is disabled with a UI error.
  - `excludeTools` and `tools` both set → persona is disabled with UI error.
  - `scope: "all-sessions"` → UI warning that v1 ignores this (treated as
    `main-only`).
- Validation errors MUST NOT block main session startup (per AGENTS.md
  Exception Safety).

#### Scenario: Invalid config non-blocking
- **WHEN** validation finds missing goalFile or conflicting tools
- **THEN** persona disabled with UI error
- **AND** main session starts normally

### Requirement: Default personas (shipped)
The package SHALL ship two default reference personas in `pi-curator/defaults/curators.json`.
The package ships two default personas in
`pi-curator/defaults/curators.json` (referenced, NOT auto-loaded — user must
opt in by copying to `~/.pi-curator/curators.json`):
- `spec` — spec-checker; appends findings; goal: "verify main session against
  the project's spec docs."
- `scold` — scold-reminder generalization; goal: "nudge on skipped skills,
  adhoc commands, unfollowed instructions."
These are reference examples; users create their own personas.

#### Scenario: Reference personas shipped
- **WHEN** package installed
- **THEN** defaults/curators.json has spec and scold reference personas
- **AND** not auto-loaded

