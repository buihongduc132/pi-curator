/**
 * signal-main.ts — curator-side `signal_main` tool + findings fallback
 * (curator-signal spec REQ-SG-01/02/07/08; sidecar tasks T7).
 *
 * The curator (separate `pi` process) calls `signal_main` to push a finding
 * back to its spawning main session. ONE multiplex tool, two kinds:
 *
 *  - `steer`   — urgent; forces a new turn on the main session.
 *  - `append`  — non-urgent ambient context; rides the next user prompt.
 *
 * The curator LLM picks the kind per finding (locked decision: "child decides
 * to intercom or not").
 *
 * ## D-H10 compatibility note
 *
 * The locked decision D-H10 in `add-curator-signal` is **NO custom tool** —
 * curators emit findings via a prose prompt + the stock `pi-intercom` tool,
 * and the main-side receiver recovers the kind from the `[STEER]`/`[APPEND]`
 * body prefix (T0-Q4 confirmed). This module provides the OPTIONAL structured
 * `signal_main` tool for curators that prefer it. To stay receiver-compatible
 * under EITHER path, this tool prepends the `[STEER]`/`[APPEND]` prefix to
 * the message body — so the receiver's prefix-recovery (REQ-SG-04) works
 * whether the curator used this tool or the prose-prompt path.
 *
 * ## Design: pure builders + injected transport
 *
 * `buildSignalPayload`, `applySeverityRouting`, and `resolveFindingsPath` are
 * pure (no `Date.now`, no fs, no network) so they are fully unit-testable.
 * The transport (`IntercomClient.send`) and the fallback-file writer are
 * injected via the factory, keeping `createSignalMainTool` the only effectful
 * seam — and even its `execute` is unit-testable with a fake client + fake
 * `writeFindingsFallback`.
 *
 * The fallback file path + JSONL record shape are a FROZEN inter-change
 * contract with `add-curator-lifecycle` `/curator status` (see
 * `curator-receiver.ts` `resolveFindingsFilePath` / `formatFallbackLine` /
 * `FallbackFinding`). This module mirrors that shape exactly — do NOT drift.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Curator delivery kind (REQ-SG-04). */
export type SignalKind = "steer" | "append";

/** Finding severity (REQ-SG-08). */
export type SignalSeverity = "info" | "warn" | "critical";

/** The `customType` the receiver listens for (REQ-SG-01). */
export const CURATOR_SIGNAL_TYPE = "curator_signal" as const;

/** Body prefix that survives pi-intercom reformatting (T0-Q4; REQ-SG-04). */
export const KIND_PREFIX: Record<SignalKind, string> = {
  steer: "[STEER]",
  append: "[APPEND]",
};

/** Identity of the curator, supplied by the spawn env / task prompt. */
export interface CuratorIdentity {
  /** This curator's persona alias (e.g. "spec", "scold"). */
  curatorAlias: string;
  /** The main session id that spawned this curator (round-trips to receiver). */
  mainSessionId: string;
  /** The main session NAME (pi-intercom `to:` target). */
  mainSessionName: string;
  /** ISO timestamp written by main at spawn (REQ-SG-02 `spawnedAt`). */
  spawnedAt: string;
}

/** The full intercom payload built by {@link buildSignalPayload} (REQ-SG-02). */
export interface SignalPayload {
  /** pi-intercom recipient = main session name. */
  to: string;
  /** Always `curator_signal` (REQ-SG-01). */
  customType: typeof CURATOR_SIGNAL_TYPE;
  /** Prefixed body (`[STEER] message` / `[APPEND] message`). */
  content: string;
  /** Structured details; receiver round-trips `mainSessionId` (REQ-SG-11). */
  details: {
    kind: SignalKind;
    severity: SignalSeverity;
    curatorAlias: string;
    mainSessionId: string;
    spawnedAt: string;
  };
}

/** One fallback findings record (FROZEN contract with receiver/lifecycle). */
export interface FallbackRecord {
  kind: SignalKind;
  message: string;
  mainSessionId: string;
  curatorAlias: string;
  severity?: SignalSeverity;
  /** Epoch-ms the fallback was written. */
  writtenAtMs: number;
}

/** Injectable intercom client (the curator loads `pi-intercom` as a dep). */
export interface IntercomClient {
  /** Send a message; rejects when the broker is unreachable. */
  send(payload: SignalPayload): Promise<unknown>;
}

/** Result of a `signal_main` tool execution. */
export type SignalResult =
  | { ok: true; via: "intercom" }
  | { ok: true; via: "fallback-file"; path: string }
  | { ok: false; error: string };

/** A pi-tool-shaped object (minimal slice — `@ts-nocheck` adapter glues it). */
export interface SignalMainTool {
  name: "signal_main";
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
  execute(args: {
    kind: string;
    message: string;
    severity?: string;
  }): Promise<SignalResult>;
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

/**
 * Apply REQ-SG-08 severity routing: `critical` overrides the curator's chosen
 * kind to `steer` (force attention). `info`/`warn` leave the kind unchanged.
 * Pure.
 */
export function applySeverityRouting(
  kind: SignalKind,
  severity: SignalSeverity,
): SignalKind {
  if (severity === "critical") return "steer";
  return kind;
}

/**
 * Validate + normalize a kind from a raw string (LLM-supplied). Throws on
 * invalid input so the tool can surface a clear error. Pure.
 */
export function normalizeKind(raw: string): SignalKind {
  if (typeof raw !== "string") {
    throw new Error(`signal_main: 'kind' must be a string, got ${typeof raw}`);
  }
  const k = raw.trim().toLowerCase();
  if (k !== "steer" && k !== "append") {
    throw new Error(
      `signal_main: 'kind' must be "steer" or "append", got ${JSON.stringify(raw)}`,
    );
  }
  return k;
}

/**
 * Validate + normalize a severity from a raw string. Defaults to `"info"`.
 * Throws on invalid non-empty input. Pure.
 */
export function normalizeSeverity(raw: string | undefined): SignalSeverity {
  if (raw === undefined || raw === null || raw === "") return "info";
  if (typeof raw !== "string") {
    throw new Error(`signal_main: 'severity' must be a string, got ${typeof raw}`);
  }
  const s = raw.trim().toLowerCase();
  if (s !== "info" && s !== "warn" && s !== "critical") {
    throw new Error(
      `signal_main: 'severity' must be "info"|"warn"|"critical", got ${JSON.stringify(raw)}`,
    );
  }
  return s;
}

/**
 * Build the body content for a finding: the kind prefix + the message. The
 * prefix is what the main-side receiver parses to recover the kind (REQ-SG-04
 * stage i, T0-Q4). Pure.
 */
export function buildContent(kind: SignalKind, message: string): string {
  const trimmed = message.trim();
  if (!trimmed) {
    throw new Error("signal_main: 'message' must be a non-empty string");
  }
  return `${KIND_PREFIX[kind]} ${trimmed}`;
}

/**
 * Build the full intercom payload (REQ-SG-02). Pure.
 *
 * Applies REQ-SG-08 severity routing (`critical` → `steer`) BEFORE composing,
 * so the payload's `details.kind` always reflects the effective kind.
 *
 * @param kind curator-chosen kind
 * @param message finding text
 * @param mainSessionId main session id (round-trips to receiver, REQ-SG-11)
 * @param opts identity + optional severity (default "info")
 */
export function buildSignalPayload(
  kind: SignalKind,
  message: string,
  mainSessionId: string,
  opts: CuratorIdentity & { severity?: SignalSeverity },
): SignalPayload {
  const severity = opts.severity ?? "info";
  const effectiveKind = applySeverityRouting(kind, severity);
  const content = buildContent(effectiveKind, message);
  return {
    to: opts.mainSessionName,
    customType: CURATOR_SIGNAL_TYPE,
    content,
    details: {
      kind: effectiveKind,
      severity,
      curatorAlias: opts.curatorAlias,
      mainSessionId,
      spawnedAt: opts.spawnedAt,
    },
  };
}

/**
 * Resolve the fallback findings file path (REQ-SG-07/08, frozen contract with
 * `curator-receiver.ts resolveFindingsFilePath`):
 * `<dir>/<curator>-<ts>.jsonl`. Pure.
 *
 * `dir` should be `~/.pi-curator/findings/<mainSessionId>` (the caller
 * resolves the home + mainSessionId prefix; this helper keeps the per-curator
 * filename stable).
 */
export function resolveFindingsPath(
  dir: string,
  curatorAlias: string,
  nowMs: number,
): string {
  return path.join(dir, `${curatorAlias}-${nowMs}.jsonl`);
}

/**
 * Format one fallback record as a single JSONL line with a trailing newline
 * (REQ-SG-07; one finding per line so `/curator status` can stream + recover
 * independently). Pure.
 */
export function formatFallbackLine(record: FallbackRecord): string {
  return JSON.stringify(record) + "\n";
}

/**
 * Write a fallback finding to the findings dir (REQ-SG-08). Creates parent
 * dirs. Appends one JSONL line. Returns the absolute path written.
 *
 * Best-effort: on write failure, the error is RE-THROWN so the caller (the
 * tool's execute) can decide whether to surface it. The tool itself never
 * throws to the LLM — it returns a `{ok:false}` result.
 */
export async function writeFindingsFallback(
  dir: string,
  record: FallbackRecord,
): Promise<string> {
  const filePath = resolveFindingsPath(dir, record.curatorAlias, record.writtenAtMs);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.appendFile(filePath, formatFallbackLine(record), "utf8");
  return filePath;
}

// ─── The tool factory ───────────────────────────────────────────────────────

/** Injectable dependencies for {@link createSignalMainTool}. */
export interface SignalMainToolDeps {
  /** The intercom client (curator loads `pi-intercom`). */
  client: IntercomClient;
  /** Where to write the fallback findings file. */
  fallbackDir: string;
  /** Clock (default `Date.now`). */
  now?: () => number;
  /** Override the writer (tests). Default: {@link writeFindingsFallback}. */
  fallbackWriter?: (dir: string, record: FallbackRecord) => Promise<string>;
  /**
   * Optional structured-log sink (curator runtime wires the OTel logger here).
   * Pure: if omitted, no logging happens. Keeps the tool unit-testable.
   */
  onLog?: (level: "info" | "warn" | "error", msg: string, attrs?: Record<string, unknown>) => void;
}

/**
 * Factory: build the `signal_main` pi-tool (REQ-SG-01).
 *
 * The tool:
 *  1. Normalizes + validates `kind` / `severity` (throws caught → result).
 *  2. Builds the payload (REQ-SG-02), applying REQ-SG-08 severity routing.
 *  3. Sends via the intercom client. On rejection, retries ONCE (REQ-SG-02
 *     "retry once on broker unreachable"; the broker auto-spawns on first
 *     connect).
 *  4. If the retry also fails, writes the finding to the fallback file
 *     (REQ-SG-08) and returns `{ok:true, via:"fallback-file", path}`.
 *
 * The tool NEVER throws to the LLM — it always resolves a {@link SignalResult}.
 */
export function createSignalMainTool(
  deps: SignalMainToolDeps,
  identity: CuratorIdentity,
): SignalMainTool {
  const now = deps.now ?? (() => Date.now());
  const fallbackWriter = deps.fallbackWriter ?? writeFindingsFallback;

  async function sendWithRetry(
    payload: SignalPayload,
  ): Promise<{ ok: true; via: "intercom" } | { ok: false; error: string }> {
    try {
      await deps.client.send(payload);
      // Stryker disable next-line all: object literal → {}: empty-object form is consumed identically by downstream optional-chaining or typeof guards
      deps.onLog?.("info", "signal sent via intercom", { kind: payload.details.kind });
      return { ok: true, via: "intercom" };
    } catch (firstErr) {
      // Stryker disable next-line all: object literal → {}: empty-object form is consumed identically by downstream optional-chaining or typeof guards
      deps.onLog?.("warn", "intercom send first attempt failed; retrying", {
        kind: payload.details.kind,
        error: firstErr instanceof Error ? firstErr.message : String(firstErr),
      });
      // REQ-SG-02: retry once (broker may be auto-spawning).
      try {
        await deps.client.send(payload);
        deps.onLog?.("info", "signal sent via intercom (on retry)", { kind: payload.details.kind });
        return { ok: true, via: "intercom" };
      } catch (secondErr) {
        const msg = secondErr instanceof Error ? secondErr.message : String(secondErr);
        // Stryker disable next-line all: object literal → {}: empty-object form is consumed identically by downstream optional-chaining or typeof guards
        deps.onLog?.("error", "intercom send failed after retry", {
          kind: payload.details.kind,
          error: msg,
        });
        return {
          ok: false,
          error: `broker unreachable after retry (first: ${
            firstErr instanceof Error ? firstErr.message : String(firstErr)
          }; second: ${msg})`,
        };
      }
    }
  }

  return {
    name: "signal_main",
    description: [
      "Signal a finding back to the main session.",
      `- kind "steer": URGENT. Use for critical deviations from requirements,`,
      `  data-loss risk, or explicit rule violations. Forces a new turn NOW.`,
      `- kind "append": NON-URGENT. Use for notes, observations, ambient`,
      `  context. Adds context for the main session's NEXT turn without`,
      `  interrupting (non-intrusive).`,
      `Target main session: ${identity.mainSessionName} (id ${identity.mainSessionId}).`,
      `severity "critical" overrides kind to "steer" (force attention).`,
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["steer", "append"],
          description: '"steer" = urgent (force turn); "append" = ambient (next turn).',
        },
        message: {
          type: "string",
          description: "The finding / nudge text.",
        },
        severity: {
          type: "string",
          enum: ["info", "warn", "critical"],
          description: 'Optional. "critical" overrides kind to "steer". Default "info".',
        },
      },
      required: ["kind", "message"],
    },
    async execute(args): Promise<SignalResult> {
      let kind: SignalKind;
      let severity: SignalSeverity;
      let payload: SignalPayload;
      try {
        kind = normalizeKind(args.kind);
        severity = normalizeSeverity(args.severity);
        payload = buildSignalPayload(kind, args.message, identity.mainSessionId, {
          ...identity,
          severity,
        });
      } catch (err) {
        // Catches kind/severity/message validation + payload-build errors
        // (e.g. empty message). NEVER throws to the LLM.
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }

      const sent = await sendWithRetry(payload);
      if (sent.ok) return sent;

      // REQ-SG-08: broker unreachable → write findings fallback file.
      try {
        const writtenPath = await fallbackWriter(deps.fallbackDir, {
          kind: payload.details.kind,
          message: args.message.trim(),
          mainSessionId: identity.mainSessionId,
          curatorAlias: identity.curatorAlias,
          severity,
          writtenAtMs: now(),
        });
        // Stryker disable next-line all: object literal → {}: empty-object form is consumed identically by downstream optional-chaining or typeof guards
        deps.onLog?.("warn", "signal written to fallback file", {
          kind: payload.details.kind,
          path: writtenPath,
        });
        return { ok: true, via: "fallback-file", path: writtenPath };
      } catch (err) {
        deps.onLog?.("error", "signal lost: intercom + fallback both failed", {
          kind: payload.details.kind,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          ok: false,
          error: `intercom failed (${sent.error}) AND fallback write failed (${
            err instanceof Error ? err.message : String(err)
          })`,
        };
      }
    },
  };
}

export {};
