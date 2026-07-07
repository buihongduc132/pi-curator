# References

> Sources consulted during this explore session (2026-07-07).
> Topic: pi-curator observability / logging / troubleshooting.

## Source files

### pi-curator repo (`/home/bhd/Documents/Projects/bhd/pi-curator/`)

- `src/main/index.ts` — main-side `turn_end` spawn hook. Verified `stdio: ["ignore","ignore","ignore"]` (D11 not honored). Contains spawn, claim-write, staleness setStatus, REQ-LC-10 exception safety.
- `src/main/spawn-args.ts` — `buildSpawnArgs()`. Verified `--fork <filteredJsonlPath>`, `--append-system-prompt <goalFile>`, `--name "curator:<alias>"`, mutual-exclusion guard. Confirms curator is named → findable by `pi --resume`.
- `src/runtime/index.ts` — curator-side extension adapter. Identity injected via `PI_CURATOR_*` env vars. Registers `signal_main` tool. Knows its own session id at startup (relevant to OT7 pointer write-back).
- `src/util/team-attach-claim.ts` — `CuratorClaim` interface (pids file schema): `{pid, mainSessionId, mainSessionName, curator, spawnedAt, heartbeatAt, phase, goalFile}`. **No `curatorSessionId` field** — this is the OT7 gap.
- `src/crosscheck/mailbox.ts` — `shared.jsonl` append + readMailbox. Confirms suppressed findings not recorded anywhere (fail-open swallows). Relevant to OT6.

### OpenSpec specs

- `openspec/specs/curator-lifecycle/spec.md` — REQ-LC-04 spawn: `detached:false`, stdio ignore OR piped to per-curator log under `~/.pi-curator/logs/`. Line 65-66 is the spec ambiguity the doer exploited.
- `openspec/specs/curator-runtime/spec.md` — line 66: "log the absence via stderr (visible in `~/.pi-curator/logs/`)". Spec assumes lifecycle created the dir; cross-spec inconsistency.
- `openspec/changes/archive/2026-06-23-add-curator-lifecycle/design.md` — **D11** (lines 275-289): the canonical stderr→logs / stdout→/dev/null decision + alternatives. Also D12 (slash list/status/kill). M14 verifier note on underspecified stdio.
- `openspec/changes/archive/2026-06-23-add-curator-lifecycle/proposal.md` — line 104: names `spawn-log/<mainSessionId>/`, `logs/`, `curators.json`, `archive/` as new runtime files. Neither `spawn-log/` nor `logs/` built.
- `openspec/changes/archive/2026-06-23-add-curator-crosscheck/design.md` — line 117: disk-full/permission errors caught + logged at debug only (fail-open).

## Documents

- `pi --help` output — verified `--fork <path|id>` flag semantics: "Fork specific session file or partial UUID into a new session". Confirms curator is a fresh pi session, NOT an ephemeral subprocess.
- `/home/bhd/.pi/agent/sessions/` directory listing — confirmed structure: `<cwd-encoded>/<YYYY-MM-DD>T<HH-MM-SS>-<ms>Z_<uuid>.jsonl`. Curator sessions persist here like any other.

## Code patterns

- **stdio triple-ignore drift** — `stdio: ["ignore","ignore","ignore"]` in `src/main/index.ts` contradicts D11's `['ignore', openSync('/dev/null','w'), openSync('<log>','a')]`. Pattern: doer took spec's parenthetical "or piped to log file" and chose the lazier branch.
- **pi --fork = new persisted session** — `pi --fork <filtered.jsonl>` creates a session under `~/.pi/agent/sessions/` with full JSONL (thinking, tool calls/results, messages). The curator's reasoning is therefore NOT lost — it lives in pi's own session store. This is the reframe that collapsed turn-1's "black box" framing.
- **named curator** — `--name "curator:<alias>"` already shipped in `spawn-args.ts:137`. Enables `pi --resume` lookup by name. Foundation for OT7 correlation.
- **CuratorClaim is the shared contract** — pids file shape used by main hook ↔ runtime heartbeat ↔ janitor. Adding `curatorSessionId` (OT7) touches all three but field can be optional (no migration needed).

## Worker / delegation references

- None. This explore was conducted inline (read-only investigation); no teams/ACP workers spawned during the observability exploration. (Earlier auditor/builder teammates from the surrounding session worked on different topics and are NOT part of this explore capture.)
