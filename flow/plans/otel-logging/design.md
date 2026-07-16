# pi-curator OTel-compatible Logging — Design

## Goal
Detail logging for EVERY step of the curator lifecycle, sufficient to troubleshoot
what each curator is doing, its session, and its config. Default file-based with
50MB rotation; OpenTelemetry-compatible (OTLP-shaped JSON lines) so a tail-side
adapter can ingest.

## Non-goals (v1)
- No `@opentelemetry/*` runtime dependency (heavy). We emit OTLP-shaped JSON
  lines instead. A separate sidecar can ship them to a collector. This satisfies
  "compatible to otel" without coupling the package to the SDK.
- No network export. File only (per user: "default to file base").

## New module: `src/util/logger.ts`

### Log record shape (one JSON object per line — JSONL)
Every record carries OTel-compliant field names:
```json
{
  "ts": "2026-07-16T21:30:00.123Z",          // ISO8601 ms
  "observedTimeUnixNano": "1818...",          // OTel: observed time
  "severity": "INFO",                         // TRACE|DEBUG|INFO|WARN|ERROR
  "body": "curator spawned",                  // human msg
  "attributes": {                             // OTel attribute bag
    "service.name": "pi-curator",
    "scope.name": "curator.main",             // which module emitted
    "session.id": "019f6ae4-...",             // main session id
    "session.name": "spec-main",              // main session name
    "persona.alias": "spec",                  // curator persona
    "curator.session.id": "...",              // the curator child session id (runtime side)
    "turn": 5,                                // main turn number
    "phase": "spawned",                       // heartbeat/spawn phase
    "pid": 12345,
    "trace.id": "abc123...",                  // W3C-ish 32-hex; shared across one spawn lifecycle
    "span.id": "def456..."                    // 16-hex; per record (or per span group)
  }
}
```
A `trace.id` is minted once per curator spawn (main side) and inherited via env
into the curator child so a full lifecycle (spawn → heartbeat → signal → done)
shares one trace. This is the OTel "distributed trace" property.

### Public API
```ts
export interface CuratorLogger {
  trace(msg: string, attrs?: Record<string, unknown>): void;
  debug(msg: string, attrs?: Record<string, unknown>): void;
  info(msg: string, attrs?: Record<string, unknown>): void;
  warn(msg: string, attrs?: Record<string, unknown>): void;
  error(msg: string, attrs?: Record<string, unknown>): void;
  child(scope: string, extraAttrs?: Record<string, unknown>): CuratorLogger;
}
export function createCuratorLogger(opts: {
  logsDir?: string;            // default ~/.pi-curator/logs
  sessionId: string;           // for per-session subdir
  scope: string;               // e.g. "curator.main"
  maxBytes?: number;           // default 50*1024*1024 (50MB)
  level?: "trace"|"debug"|"info"|"warn"|"error"; // default "info"
  traceId?: string;            // inherited from spawner
  persistentAttrs?: Record<string, unknown>;
}): CuratorLogger;
```

### File backend + 50MB rotation
- Path: `<logsDir>/<sessionId>/curator.jsonl` (per-session subdir, mirrors the
  existing D11 `<logsDir>/<sessionId>/<alias>-<nowMs>.stderr` layout).
- Before each write: stat the file. If `size + newLine.length > maxBytes`:
  rotate → rename current to `curator.jsonl.1` (overwrite any existing roll),
  then open a fresh `curator.jsonl`. Append the new line.
- Rotation is best-effort and non-throwing (logger MUST never break the turn).
- This caps disk at ~`maxBytes * 2` (current + 1 roll). "max size (50mb)" =
  per-file cap; roll keeps the most recent 50MB and starts a new 50MB file.

### Env knobs
- `PI_CURATOR_LOG_ENABLED=0` → logger is a no-op sink (still returns the API).
- `PI_CURATOR_LOG_DIR=<path>` → override logsDir.
- `PI_CURATOR_LOG_MAX_BYTES=<n>` → override per-file cap.
- `PI_CURATOR_LOG_LEVEL=<trace|...|error>` → override level.

## Instrumentation points (every "step")

### Main side (`src/main/index.ts`)
- `curatorMainExtension` load (D8 flag set) — scope `curator.main`.
- `turn_end` fired — attrs: turn, sessionId, sessionName.
- Gate evaluated per persona — attrs: alias, turnsSince, minsSince, spawn(bool), reason.
- Filter+trim (writeForkFile) — attrs: alias, inputBytes, outputBytes, forkPath.
- Claim acquire — attrs: alias, claimPath, ok(bool), heldBy.
- Spawn attempt/success/fail — attrs: alias, pid, argvLen, intercomPath, runtimePath.
- pid seed — attrs: alias, claimPath, childPid, phase.
- Liveness summary — attrs: alive, stale, dead counts.
- Every existing `safeNotify(error)` ALSO logs `error`.

### Runtime side (`src/runtime/index.ts`, `heartbeat.ts`, `signal-main.ts`)
- Identity load — attrs: alias, mainId, mainName, curatorSessionId, traceId.
- Heartbeat start / each tick / phase transition — attrs: alias, phase, claimPath, heartbeatAt.
- `beforeExit` done-write — attrs: alias, phase, result.
- `signal_main.execute` attempt/retry/success/fail — attrs: alias, kind(steer|append), attempt, ok(bool), error.

### Janitor (`src/janitor/pi-curator-janitor.ts`, `run-tick.ts`)
- Tick start — attrs: pidRoot, forkRoot, logsDir.
- Per-pid sweep — attrs: pid, alias, liveness, action(gc|keep).
- Log GC (D11 stderr GC) — attrs: deletedFiles, bytesFreed.

### Receiver (`src/curator-receiver/index.ts`, `curator-receiver.ts`)
- Signal received — attrs: from(name,id), kind, alias.
- Dispatch — attrs: kind, ok.

## Trace propagation
Main mints `traceId` (crypto.randomUUID().replaceAll('-','').slice(0,32)) at
spawn time, sets `PI_CURATOR_TRACE_ID` in the child env (alongside the existing
D4 identity env). Runtime reads it via `readCuratorIdentity()`. This gives one
trace per curator lifecycle across two processes.

## TDD plan (RED separate from GREEN per goal custom-prompt)
RED agents write ONLY failing tests in `src/util/logger.test.ts` + instrument
assertion tests at each step (mock the logger, assert it was called with
expected scope/attrs at the right points). GREEN agents implement `logger.ts`
and wire it in — RED tests must go green with ZERO modification.

## Verification
- `npm test` green (all RED tests + baseline).
- `npm run typecheck` clean.
- jewilo verifier loop or 2/2 fan-out APPROVE.
