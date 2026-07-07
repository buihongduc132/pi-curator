/**
 * staleness.ts — classify curator sidecar liveness from pids/*.json
 * (REQ-LC-06, foundation T3).
 *
 * The main hook reads every `~/.pi-curator/pids/<mainSessionId>/<curator>.json`
 * file at the end of each turn and classifies each curator as:
 *
 *   - `live`:   heartbeat ≤ `staleSec` (default 30s) and the PID is alive.
 *   - `stale`:  `staleSec` < heartbeat ≤ `deadSec` (default 30–120s) and PID alive.
 *   - `dead`:   heartbeat > `deadSec` (default 120s) OR the PID is gone
 *               (optional `process.kill(pid, 0)` fast-path).
 *
 * The summary is surfaced via `ctx.ui.setStatus` (e.g. "curator: 2 live, 1
 * stale, 0 dead") — UI-only, never injected into the session context per
 * AGENTS.md indicator-visibility (REQ-LC-06).
 *
 * ## Design: pure functions + thin I/O wrapper
 *
 * `classifyLiveness` and `summarizeLiveness` are pure (they take `nowMs` and
 * an injectable `kill` so unit tests do not need real processes). The optional
 * PID check is disabled by default in tests; in production the main hook passes
 * `checkPid: true`.
 *
 * `readPidEntries` is the only filesystem touch: it enumerates `*.json` files,
 * validates each with {@link parseCuratorClaim} from team-attach-claim,
 * classifies, and returns the enriched list.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isPidAlive } from "./fs-lock.js";
import {
  assessHeartbeatFreshness,
  DEFAULT_HEARTBEAT_CONFIG,
  type CuratorHeartbeatConfig,
  type LivenessClass,
  parseIsoMs,
} from "./heartbeat-lease.js";
import { parseCuratorClaim, type CuratorClaim } from "./team-attach-claim.js";

// Re-export the CuratorPidEntry shape for callers.
export type CuratorPidEntry = CuratorClaim;

/** A PID entry enriched with its liveness classification and heartbeat age. */
export interface StalePidEntry extends CuratorPidEntry {
  liveness: LivenessClass;
  /** Age of the heartbeat in milliseconds (positive). */
  ageMs: number;
}

/** Options for {@link classifyLiveness}. */
export interface LivenessOpts {
  /** Heartbeat thresholds (defaults to 5s/30s/120s). */
  config?: CuratorHeartbeatConfig;
  /**
   * Whether to run the `process.kill(pid, 0)` fast-path (default `true`).
   * Tests should set this to `false` to avoid touching real processes.
   */
  checkPid?: boolean;
  /**
   * Injectable `process.kill` replacement for tests. Default: Node.js
   * `process.kill`. The signature is `(pid, signal: 0) => void`.
   */
  kill?: (pid: number, signal: 0) => void;
  /** Explicit timestamp for deterministic tests. */
  nowMs?: number;
}

// ─── Core classification (REQ-LC-06) ───────────────────────────────────────────

/**
 * Classify a curator's liveness from its PID entry.
 *
 * Algorithm (REQ-LC-06):
 * 1. If the PID check is enabled and fails, the curator is `dead` regardless
 *    of heartbeat (fast-path).
 * 2. Otherwise, use the heartbeat age thresholds from `config`:
 *    - age ≤ staleSec → `live`
 *    - staleSec < age ≤ deadSec → `stale`
 *    - age > deadSec → `dead`
 * 3. Missing/invalid heartbeatAt → `dead`.
 *
 * Pure: `nowMs` and `kill` are injected.
 */
export function classifyLiveness(
  entry: CuratorPidEntry,
  opts: LivenessOpts = {},
): LivenessClass {
  const config = opts.config ?? DEFAULT_HEARTBEAT_CONFIG;
  const nowMs = opts.nowMs ?? Date.now();
  const checkPid = opts.checkPid !== false;

  if (checkPid) {
    if (!isPidAlive(entry.pid, opts.kill)) {
      return "dead";
    }
  }

  const f = assessHeartbeatFreshness(entry.heartbeatAt, nowMs, config);
  return f.classification;
}

/**
 * Compute the heartbeat age of a PID entry in milliseconds. Returns `Infinity`
 * when the heartbeat timestamp is missing or unparseable. Pure.
 */
export function heartbeatAgeMs(entry: CuratorPidEntry, nowMs: number = Date.now()): number {
  const lastSeenMs = parseIsoMs(entry.heartbeatAt);
  if (lastSeenMs === null) return Number.POSITIVE_INFINITY;
  return Math.max(0, nowMs - lastSeenMs);
}

// ─── Filesystem reading ─────────────────────────────────────────────────────

/** Read all curator PID entries from a directory and classify them. */
export async function readPidEntries(
  dir: string,
  opts: LivenessOpts = {},
): Promise<StalePidEntry[]> {
  let files: string[];
  try {
    files = await fs.promises.readdir(dir);
  } catch {
    return []; // directory missing or unreadable → no curators
  }

  const jsonFiles = files.filter((f) => f.endsWith(".json"));
  const results: StalePidEntry[] = [];
  for (const file of jsonFiles) {
    const filePath = path.join(dir, file);
    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, "utf8");
    } catch {
      continue; // unreadable file — skip
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // corrupt JSON — skip
    }
    const entry = parseCuratorClaim(parsed);
    if (!entry) continue; // invalid shape — skip

    const liveness = classifyLiveness(entry, opts);
    const ageMs = heartbeatAgeMs(entry, opts.nowMs);
    results.push({ ...entry, liveness, ageMs });
  }

  // Stable order: alphabetical by curator alias (filesystem order may vary).
  return results.sort((a, b) => a.curator.localeCompare(b.curator));
}

// ─── Summary ────────────────────────────────────────────────────────────────

/** Count live/stale/dead curators for UI status. */
export function summarizeLiveness(entries: ReadonlyArray<StalePidEntry>): {
  live: number;
  stale: number;
  dead: number;
  total: number;
} {
  let live = 0;
  let stale = 0;
  let dead = 0;
  for (const e of entries) {
    if (e.liveness === "live") live += 1;
    else if (e.liveness === "stale") stale += 1;
    else if (e.liveness === "dead") dead += 1;
  }
  return { live, stale, dead, total: entries.length };
}

/**
 * Format a liveness summary string for `ctx.ui.setStatus`
 * (e.g. "curator: 2 live, 1 stale, 0 dead"). Pure.
 */
export function formatLivenessStatus(summary: ReturnType<typeof summarizeLiveness>): string {
  return `curator: ${summary.live} live, ${summary.stale} stale, ${summary.dead} dead`;
}

export {};
