# Proposal — pi-curator-sidecar

## Why

Pi sessions drift from requirements mid-flight. Existing in-process nudges
(`scold-reminder`) inject random/embedding-matched reminders but cannot reason
about the actual session trajectory: they have no isolated context, no separate
LLM budget, no ability to read the full history and form a judgment. The result
is either over-nagging (random reminders) or under-coverage (no actual review).

A **side-car curator** — a separate `pi` process forked from the main session,
with its own context window and budget, that reviews the main session as
context and signals findings back — closes this gap. It generalizes
`scold-reminder` from "hard-coded reminder list" to "any prompt-driven review
persona": spec-checker, scold, security-audit, lessons-learned curator, etc.

This is the **out-of-process** form. In-process injection (`scold-reminder`)
remains for cheap, deterministic nudges; the side-car is for review work that
needs its own reasoning.

## What Changes

Add a new pi package (`buihongduc132/pi-curator`, consumed as git-sourced in
`profile/git/`) that ships:

1. **Main-side extension** — `turn_end` hook that, per configured curator,
   filters the main session JSONL (drop thinking + compaction), trims to fit
   the curator's context budget, and spawns a child `pi` process via
   `child_process.spawn({detached:false})` with `--fork <filtered.jsonl>`,
   `--append-system-prompt <goal.md>`, and a configurable tool-trim list.
   Children are coupled to the main process lifecycle (die with main).

2. **`signal_main` tool** (curator-side) — single multiplex tool that sends a
   finding back to the main session. Curator LLM picks `kind: "steer"` (force
   new turn, urgent) or `kind: "append"` (ambient context, non-intrusive).
   Delivered via the **existing `pi-intercom` broker** (no new IPC). Main-side
   receiver extension maps `kind` to `deliverAs` semantics.

3. **Staleness detection** — reuses `pi-agent-teams`' `heartbeat-lease.ts`
   pattern verbatim. Each curator writes a heartbeat file
   (`~/.pi-curator/pids/<mainSessionId>/<curator>.json`); main reads it at
   `turn_end` and surfaces stale/dead curators via `ui.setStatus`.

4. **PM2 janitor** — stateless, GC-only daemon under namespace
   `pi-curator:<project>`. Never spawns. Kills orphan curator PIDs (no
   heartbeat, > threshold) and GCs stale forked JSONL files.

5. **Slash commands** — `/curator list|status|kill <name>` for inspection and
   manual recovery.

6. **Config schema** — global + project layering (per `pi-config-parity` 3-layer
   rule). Each curator is a named persona with: alias, goal file, spawn gate
   (turns/mins), tool-trim list, scope (`main-only` default).

## Scope

**In scope:**
- Spawn + lifecycle (one curator per main session per persona; N personas per
  main session).
- Filtered JSONL fork as curator input (non-bias by default).
- `signal_main` over `pi-intercom` (steer + append).
- Staleness detection + UI indicator.
- PM2 janitor (GC only).
- Config layering (global + project).
- `/curator` slash commands.

**Explicit non-goals (deferred — own future changes):**
- **Cross-check protocol** between curators (curators reading each other's
  findings, voting/aggregating). See `tasks.md` DEFERRED section.
- **Mailbox extension on main** (file-based pending-signal queue). Not needed
  for v1 — `pi-intercom` already delivers signals. Revisit only if intercom
  proves insufficient.
- **`scold-reminder` heartbeat/UI/restart upgrade.** Tracked as a SEPARATE
  change. `pi-curator` will inherit that pattern; it does not modify
  `scold-reminder` itself. (HUMAN REMINDER: file this as its own change after
  this one merges.)
- **`includeThinking: true` opt-in path.** The non-bias filter strips thinking
  by default. Re-adding thinking as a per-curator opt-in is a config flag
  scaffolded now, but its bias-mitigation analysis is deferred.

## Out-of-scope assumptions

- `pi-intercom` broker remains the cross-process IPC primitive. (Current state:
  running, stable; email-bus is the WIP alternative — NOT depended on here.)
- `pi --fork`, `--append-system-prompt <path>`, `--exclude-tools`,
  `--tools`, `--name` flags behave as documented in pi v22.22.2.

## Risks

- **Latency**: fork + curator LLM call adds 30–120s per spawn. Mitigated by
  spawn gate (every N turns or M mins, not every turn) and non-blocking spawn.
- **Token cost**: each curator spawn = full forked context + LLM call.
  Mitigated by trim budget (max 90% of curator window; target 60% recent turns)
  and per-curator model override (default: cheap reviewer model).
- **Orphan curators on main hard-crash**: `detached:false` covers clean exit;
  hard crash (SIGKILL) may leave orphans. Mitigated by PM2 janitor's PID-sweep.
- **`pi-intercom` non-interactive busy auto-reply**: if main is run in `pi -p`
  mode, stock intercom sends a structured "cannot respond" reply instead of
  queuing. The receiver extension filters on `customType` so it sees signals
  regardless of UI mode — must be verified in implementation.
