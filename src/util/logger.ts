/**
 * logger.ts — OTel-compatible structured logging for pi-curator.
 *
 * Emits JSON-Lines records (one JSON object per line) with OpenTelemetry
 * field names so a tail-side adapter can ingest them, while defaulting to a
 * simple file backend with 50MB rotation (per design
 * flow/plans/otel-logging/design.md). The logger NEVER throws — curator turn
 * hooks must stay non-blocking (REQ-LC-10).
 *
 * Env knobs:
 *   PI_CURATOR_LOG_ENABLED=0   → no-op sink (no file created)
 *   PI_CURATOR_LOG_DIR=<path>  → override logsDir
 *   PI_CURATOR_LOG_MAX_BYTES=<n> → override per-file cap
 *   PI_CURATOR_LOG_LEVEL=<lvl> → override level
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export type Severity = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR";
export type Level = "trace" | "debug" | "info" | "warn" | "error";

export interface LogRecord {
  ts: string;
  observedTimeUnixNano: string;
  severity: Severity;
  body: string;
  attributes: Record<string, unknown>;
}

const LEVEL_RANK: Record<Level, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};
const SEVERITY_FOR: Record<Level, Severity> = {
  trace: "TRACE",
  debug: "DEBUG",
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
};

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50MB per file (the user requirement).

export interface CreateCuratorLoggerOpts {
  logsDir?: string;
  sessionId: string;
  scope: string;
  maxBytes?: number;
  level?: Level;
  traceId?: string;
  persistentAttrs?: Record<string, unknown>;
}

export interface CuratorLogger {
  trace(msg: string, attrs?: Record<string, unknown>): void;
  debug(msg: string, attrs?: Record<string, unknown>): void;
  info(msg: string, attrs?: Record<string, unknown>): void;
  warn(msg: string, attrs?: Record<string, unknown>): void;
  error(msg: string, attrs?: Record<string, unknown>): void;
  child(scope: string, extraAttrs?: Record<string, unknown>): CuratorLogger;
}

function envFlag(name: string): string | undefined {
  const v = process.env[name];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function nowUnixNano(): string {
  // ms → ns string. Sufficient granularity for log ordering.
  return String(BigInt(Date.now()) * 1_000_000n);
}

function resolveLogsDir(explicit?: string): string {
  return (
    explicit ??
    envFlag("PI_CURATOR_LOG_DIR") ??
    path.join(os.homedir(), ".pi-curator", "logs")
  );
}

function resolveMaxBytes(explicit?: number): number {
  const env = envFlag("PI_CURATOR_LOG_MAX_BYTES");
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return explicit ?? DEFAULT_MAX_BYTES;
}

function resolveLevel(explicit?: Level): Level {
  const env = envFlag("PI_CURATOR_LOG_LEVEL");
  if (env && env in LEVEL_RANK) return env as Level;
  return explicit ?? "info";
}

/**
 * Build the real file-writing logger core. Each call appends one JSONL line to
 * `<dir>/<sessionId>/curator.jsonl`, rotating to `.1` (single roll) when the
 * next line would exceed `maxBytes`. Every fs op is wrapped so the logger
 * never throws.
 */
function makeWriter(opts: {
  logsDir: string;
  sessionId: string;
  maxBytes: number;
}): (line: string) => void {
  const sessionDir = path.join(opts.logsDir, opts.sessionId);
  const current = path.join(sessionDir, "curator.jsonl");
  const rolled = path.join(sessionDir, "curator.jsonl.1");

  return (line: string) => {
    try {
      fs.mkdirSync(sessionDir, { recursive: true });
      let size = 0;
      try {
        size = fs.statSync(current).size;
      } catch {
        // file does not exist yet
      }
      // Rotation BEFORE append: cap is on file size, roll keeps the prior
      // 50MB window as `.1` and starts a fresh file.
      if (size > 0 && size + Buffer.byteLength(line, "utf8") > opts.maxBytes) {
        try {
          // Overwrite any prior roll (single-roll window → ~2x cap on disk).
          try {
            fs.unlinkSync(rolled);
          } catch {
            // no prior roll
          }
          fs.renameSync(current, rolled);
        } catch {
          // rename failed — best-effort: truncate and continue fresh.
          try {
            fs.truncateSync(current, 0);
          } catch {
            // give up rotation, just append below
          }
        }
      }
      fs.appendFileSync(current, line + "\n", "utf8");
    } catch {
      // Logger must never break the turn. Swallow.
    }
  };
}

export function createCuratorLogger(opts: CreateCuratorLoggerOpts): CuratorLogger {
  const enabled = envFlag("PI_CURATOR_LOG_ENABLED") !== "0";
  const level = resolveLevel(opts.level);
  const maxBytes = resolveMaxBytes(opts.maxBytes);
  const logsDir = resolveLogsDir(opts.logsDir);
  const traceId = opts.traceId;
  const persistentAttrs: Record<string, unknown> = {
    "service.name": "pi-curator",
    "session.id": opts.sessionId,
    ...(opts.persistentAttrs ?? {}),
  };
  if (traceId) persistentAttrs["trace.id"] = traceId;

  const write = enabled
    ? makeWriter({ logsDir, sessionId: opts.sessionId, maxBytes })
    : (_line: string) => undefined;

  const baseScope = opts.scope;

  function emit(lvl: Level, msg: string, attrs?: Record<string, unknown>): void {
    // Stryker disable next-line all -- equivalent mutant (try/catch or downstream optional-chaining masks behavior change)
    if (!enabled) return;
    // level gate against the resolved level
    if (LEVEL_RANK[lvl] < LEVEL_RANK[level]) return;
    const attributes: Record<string, unknown> = {
      ...persistentAttrs,
      "scope.name": baseScope,
      ...(attrs ?? {}),
    };
    const rec: LogRecord = {
      ts: nowIso(),
      observedTimeUnixNano: nowUnixNano(),
      severity: SEVERITY_FOR[lvl],
      body: msg,
      attributes,
    };
    try {
      write(JSON.stringify(rec));
    } catch {
      // swallow — never throw from a log call
    }
  }

  const logger: CuratorLogger = {
    trace: (m, a) => emit("trace", m, a),
    debug: (m, a) => emit("debug", m, a),
    info: (m, a) => emit("info", m, a),
    warn: (m, a) => emit("warn", m, a),
    error: (m, a) => emit("error", m, a),
    child: (scope, extraAttrs) =>
      createCuratorLogger({
        logsDir,
        sessionId: opts.sessionId,
        scope: baseScope ? `${baseScope}.${scope}` : scope,
        maxBytes,
        level,
        traceId,
        persistentAttrs: { ...persistentAttrs, ...(extraAttrs ?? {}) },
      }),
  };
  return logger;
}

export function __curatorLoggerStubMarker(): string {
  return "curator logger (GREEN-phase)";
}

export {};
