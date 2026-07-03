# Tasks — pi-curator-sidecar

## Sequencing
1. Package scaffold (T1) — blocks all.
2. Standalone utils: filter+trim (T2), heartbeat staleness (T3) — parallel,
   both block lifecycle work.
3. Config layer (T4) — blocks spawn/receiver.
4. Main-side extension: spawn hook (T5), receiver (T6) — parallel after T2/T3/T4.
5. Curator-runtime: signal_main (T7), heartbeat writer (T8) — parallel.
6. Slash commands (T9) — after T5.
7. PM2 janitor (T10) — after T3.
8. Default personas + docs (T11) — after T4.
9. Integration tests (T12) — after T5/T6/T7.
10. Verifier loop (T13) — last.

## Tasks

### T1 — Package scaffold
- [x] Create `buihongduc132/pi-curator` repo (separate, per AGENTS.md
      "packages MUST live in their own repo").
- [x] `package.json` with `pi` manifest (extension entry points).
- [x] `profile/git/github.com/buihongduc132/` wiring in `pi-plugins`.
- [x] `settings.json` packages[] entry (git-sourced).
- [x] README + SETUP + USAGE per AGENTS.md project-info rule.
- [x] Repo skeleton: `extensions/`, `runtime/`, `janitor/`, `defaults/`,
      `tests/`.

### T2 — JSONL filter + trim utility (standalone, tested)
- [x] `extensions/util/filter-session.ts`:
  - read main JSONL line-by-line.
  - drop thinking blocks, compaction, metadata entries (per REQ-LC-02).
  - emit filtered JSONL to target path.
- [x] `extensions/util/trim-session.ts`:
  - reuse pi core `estimateTokens` (chars/4).
  - walk backwards, cut at valid cut points, keep ≤ budget (per REQ-LC-03).
- [x] Unit tests: malformed line handling, tool-result-never-cut, budget
      boundary, includeThinking opt-in.
- [x] Tests live next to code (per AGENTS.md code-organization rule).

### T3 — Heartbeat staleness utility (standalone, tested)
- [x] Vendor `heartbeat-lease.ts` from `pi-agent-teams` (copy + adapt for
      curator — per-curator JSON file vs members[] array).
- [x] Vendor `team-attach-claim.ts` single-holder pattern.
- [x] `extensions/util/staleness.ts`:
  - read pids/*.json, classify live/stale/dead (per REQ-LC-06).
  - optional `process.kill(pid, 0)` fast-path.
- [x] Unit tests: 5s/30s/120s thresholds, dead-pid fast-path.

### T4 — Config layer
- [x] `extensions/util/config.ts`:
  - load global (`~/.pi-curator/curators.json`).
  - load project (`<root>/.pi-curator/curators.json`).
  - deep-merge per REQ-CF-03.
  - validate per REQ-CF-09.
- [x] Cache merged config (cache invalidation on cwd change, like
      `todo-enforcer/config.ts`).
- [x] Unit tests: override, disable, alias validation, mutual-exclusion of
      excludeTools/tools.

### T5 — Main-side spawn hook
- [x] `extensions/main/index.ts`:
  - register `turn_end` hook.
  - per persona: gate check, filter+trim (T2), spawn (REQ-LC-04), write
    pids file (REQ-LC-05).
  - exclusivity check (REQ-LC-07).
  - staleness summary + ui.setStatus (REQ-LC-06).
  - non-blocking + exception safety (REQ-LC-10).
- [x] Integration test: spawn a real `pi -p` child; verify pids file written;
      verify child dies when parent exits.

### T6 — Main-side receiver
- [x] `extensions/main/receiver.ts`:
  - subscribe to `customType === "curator_signal"`.
  - verify mainSessionId round-trip (REQ-SG-03).
  - map kind → deliverAs (REQ-SG-03/04/05).
  - severity routing (REQ-SG-08).
  - non-interactive main guard (REQ-SG-07).
- [x] Integration test: curator pi process signals main; verify steer wakes
      idle main; verify append does NOT wake.

### T7 — Curator-runtime: signal_main tool
- [x] `runtime/signal-main.ts`:
  - register `signal_main` tool (REQ-SG-01).
  - send via `IntercomClient` (REQ-SG-02).
  - fallback to findings file on broker unreachable.
- [x] Loaded via `--extension <path>` in spawn command (T5) — curator loads
      this + `pi-intercom` only (NOT main extension).

### T8 — Curator-runtime: heartbeat writer
- [x] `runtime/heartbeat.ts`:
  - setInterval 5s refresh `heartbeatAt` in pids file.
  - update phase to `running`/`signaling`/`done`.
- [x] Cleanup on curator exit (best-effort; janitor sweeps if missed).

### T9 — Slash commands
- [x] `/curator list|status|kill|restart|reload` (REQ-LC-09).
- [x] Tests: command parsing, kill SIGTEMR + file mark, restart re-evaluates
      gate.

### T10 — PM2 janitor
- [x] `janitor/pi-curator-janitor.mjs`:
  - tick every `janitor.interval`.
  - sweep dead pids (SIGTERM + archive).
  - GC forks older than `forkTTL`.
  - stateless (REQ-LC-08).
- [x] pm2 ecosystem file template (`janitor/ecosystem.config.cjs`) with
      namespace `pi-curator:<project>`.
- [x] SETUP.md instructions for installing the janitor per project.

### T11 — Default personas + docs
- [x] `defaults/curators.json` with `spec` and `scold` reference personas
      (REQ-CF-10).
- [x] `defaults/goals/spec.md`, `defaults/goals/scold.md`.
- [x] USAGE.md: how to add a persona, debug stale curator, read findings
      fallback file.

### T12 — Integration tests
- [x] E2E: main session runs N turns → curator spawns → curator signals
      steer → main wakes and processes.
- [x] E2E: curator signals append → main does NOT wake; append appears in
      next turn context.
- [x] E2E: main exits cleanly → curator child dies within 5s.
- [x] E2E: main hard-killed (SIGKILL) → janitor sweeps orphan within
      `janitor.interval`.
- [x] E2E: pi-intercom broker unavailable → curator writes findings fallback
      file → `/curator status` shows it.

### T13 — Verifier loop (cross-agent review)
- [x] Run plan-cross-review or verifier-loop on the merged proposal+design+
      specs+tasks.
- [x] Address findings; re-run until clean.

## DEFERRED (own future changes — NOT this change)

### DEF-1 — Curator cross-check protocol
Curators reading each other's findings, voting/aggregating to avoid N curators
nagging the same issue. Own change: `add-pi-curator-crosscheck`.

### DEF-2 — Main-side file mailbox
File-based pending-signal queue on main (alternative to intercom). Not needed
in v1 — `pi-intercom` delivers. Own change: `add-pi-curator-mailbox` — only
file if intercom proves insufficient.

### DEF-3 — scold-reminder heartbeat/UI/restart upgrade
**HUMAN REMINDER**: file this as its own change AFTER `add-pi-curator-sidecar`
merges. `pi-curator` inherits the pattern; `scold-reminder` itself gets
upgraded to add heartbeat + UI indicator + `/scold-restart` slash cmd.
Own change: `upgrade-scold-reminder-liveness`.

### DEF-4 — `includeThinking: true` bias analysis
Per-curator opt-in to include main's thinking blocks in the fork. Scaffolded
in v1 (config flag exists, filter respects it). Bias-mitigation analysis
(when is thinking safe to include? curator personas that benefit?) deferred.
Own change: `curator-thinking-inclusion-policy`.

### DEF-5 — `prctl(PR_SET_PDEATHSIG)` Linux kernel parent-death signal
Bulletproof parent-death coupling for hard-crash scenarios. v1 uses
`detached:false` (SIGHUP); v2 adds prctl for SIGKILL survival.
Own change: `curator-prctl-pdeathsig`.

### DEF-6 — `scope: "all-sessions"` cross-session curators
Privacy review required (curator would read other session JSONLs). Reserved
in v1 config, ignored at runtime. Own change: `curator-cross-session-scope`.

### DEF-7 — Hot-reload of config mid-session
`/curator reload` is a manual reload in v1. Auto-reload on file change
deferred. Own change: `curator-config-hotreload`.
