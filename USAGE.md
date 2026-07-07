# pi-curator — Usage

Out-of-process review sidecars for pi main sessions. Curators are separate
`pi` processes forked from the main session's context; they review and signal
findings back (steer = urgent, append = ambient). See `README.md` for the
architecture overview.

## Install

This package is consumed git-sourced in `pi-plugins`:

```jsonc
// pi-plugins profile/settings.json → packages[]
{
  "git": "https://github.com/buihongduc132/pi-curator",
  "extensions": ["src/curator-receiver/index.ts"]
}
```

Then `pi install`.

## Configure personas

Curators are configured via a layered JSONC config (REQ-CF-03 deep merge:
defaults ← global ← project):

- **Global** (all projects): `~/.pi-curator/curators.json`
- **Project** (per-repo override): `<project-root>/.pi-curator/curators.json`

Copy the reference personas and edit:

```bash
mkdir -p ~/.pi-curator
cp defaults/curators.json ~/.pi-curator/curators.json
```

### Persona schema (curator-config spec)

| Field | Default | Notes |
|---|---|---|
| `enabled` | `true` | `false` disables (project can disable a global persona) |
| `alias` | *(required)* | friendly name; filesystem-safe |
| `goalFile` | *(required)* | path to the persona goal prompt (abs or project-rel) |
| `model` | main's model | override to route curator to a cheaper model |
| `scope` | `"main-only"` | `"all-sessions"` reserved (privacy review needed) |
| `spawn.everyTurns` | — | spawn gate: turns since last spawn |
| `spawn.everyMins` | — | spawn gate: minutes since last spawn |
| `includeThinking` | `false` | include main's thinking blocks in the fork |
| `contextBudget` | 90% of model window | token budget for trim |
| `excludeTools` **OR** `tools` | — | mutually exclusive (config error if both) |
| `appendDisplay` | `false` | show append findings in UI |
| `heartbeat.intervalSec` | `5` | refresh interval |
| `heartbeat.staleSec` | `30` | live → stale threshold |
| `heartbeat.deadSec` | `120` | stale → dead threshold |

### Add a persona

1. Write a goal prompt: `defaults/goals/<alias>.md` (describe what to review,
   when to `steer` vs `append`, the rules).
2. Register in `~/.pi-curator/curators.json`:
   ```jsonc
   { "curators": { "security-audit": {
       "enabled": true,
       "alias": "security-audit",
       "goalFile": "defaults/goals/security-audit.md",
       "spawn": { "everyMins": 60 }
   } } }
   ```
3. Reload: `/curator reload` (or restart the main session).

## How curators signal back

The curator LLM calls `signal_main` with a kind:

- **`steer`** — URGENT. Forces a new turn on the main session (`[STEER]`
  prefix, `display:true`, `triggerTurn:true`). Use for active divergence,
  broken REQs, rule violations.
- **`append`** — ambient. Rides the next user prompt without interrupting
  (`[APPEND]` prefix, `display` per `appendDisplay`). Use for notes,
  observations, coverage gaps.
- **`severity: "critical"`** overrides `kind` to `steer` (force attention).

Transport is the existing `pi-intercom` broker (no new IPC). When the broker
is unreachable, the curator retries once then writes a fallback JSONL file at
`~/.pi-curator/findings/<mainSessionId>/<curator>-<ts>.jsonl`.

## Debug a stale curator

Curators are tracked via per-curator PID claim files at
`~/.pi-curator/pids/<mainSessionId>/<curator>.json`:

```jsonc
{ "pid": 4242, "mainSessionId": "...", "curator": "spec",
  "spawnedAt": "...", "heartbeatAt": "...", "phase": "scanning" }
```

Liveness (REQ-LC-06, from `heartbeatAt` age):

- **live** — heartbeat ≤ `staleSec` (30s).
- **stale** — `staleSec` < age ≤ `deadSec` (30–120s).
- **dead** — age > `deadSec` (120s) OR pid gone (`process.kill(pid, 0)`).

A `dead` curator is reclaimed by the janitor (SIGTERM + archive the claim
file). A curator in terminal `phase: "done"` frees its slot immediately.

To inspect: `/curator status`. To force-kill: `/curator kill <alias>`.

## Read findings fallback file

When the main session runs non-interactively (`pi -p`) OR the intercom broker
is unreachable, curator findings land in the fallback file:

```
~/.pi-curator/findings/<mainSessionId>/<curator>-<ts>.jsonl
```

Each line is one JSON record:

```jsonc
{ "kind": "steer", "message": "...", "mainSessionId": "...",
  "curatorAlias": "spec", "severity": "warn", "writtenAtMs": 1783000000000 }
```

Surface via `/curator status` (reads + pretty-prints pending fallback records).

## Janitor setup

See `SETUP.md` for installing the pm2 janitor (per-project namespace
`pi-curator:<project>`) that sweeps dead curators and GCs old fork files.
