# Spec — curator-config

## Purpose
Configuration schema for curator personas, spawn gates, model overrides, and
tool-trim lists. Layered global + project per `pi-config-parity` 3-layer rule
(ENV > global JSON > project JSON > defaults).

## ADDED Requirements

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
Each persona under `curators.<alias>` SHALL conform to the following TypeScript interface:
```typescript
interface CuratorPersona {
  enabled?: boolean;              // default true
  alias: string;                  // friendly name; MUST match the key
  goalFile: string;               // path to .md appended via --append-system-prompt
  taskPrompt?: string;            // inline prompt; falls back to default template
  model?: string;                 // e.g. "sonnet:low"; default: cheap reviewer
  scope?: "main-only" | "all-sessions";  // default "main-only"
                                  //   (REQ: default scope = only the spawning main)
  spawn: {
    everyTurns?: number;          // spawn gate: turns since last spawn
    everyMins?: number;           // spawn gate: minutes since last spawn
  };                              // spawn fires if EITHER is satisfied (OR)
  includeThinking?: boolean;      // default false (non-bias)
  contextBudget?: number;         // tokens; default 90% of model's window
  excludeTools?: string[];        // omit if unset → no --exclude-tools flag
  tools?: string[];               // omit if unset → no --tools flag
                                  //   (excludeTools and tools are mutually exclusive)
  appendDisplay?: boolean;        // default false; display for kind=append
  // Lifecycle
  heartbeat?: {                   // defaults shown
    intervalSec: 5,
    staleSec: 30,
    deadSec: 120,
  };
}
```


#### Scenario: Persona with spawn gate
- **WHEN** persona has spawn.everyTurns:3 and model:sonnet:low
- **THEN** curator spawns every 3 turns using specified model
- **AND** excludeTools and tools are mutually exclusive
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
## Non-goals (this capability)
- Hot-reload of config mid-session (deferred; `/curator reload` reloads on
  demand).
- Per-curator credential isolation (curators inherit main's auth.json).
- Remote/shared persona registries (deferred).
