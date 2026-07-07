/**
 * run-tick.ts — pure stateless janitor tick (REQ-LC-08).
 *
 * One tick of the pm2 janitor:
 *   1. Enumerate `pids/<mainSessionId>/*.json`. For each `dead` entry (per
 *      REQ-LC-06), SIGTERM the PID (if alive) and archive the pids file to
 *      `pids-archive/<mainSessionId>/<curator>-<ts>.json`.
 *   2. Enumerate `forks/*.jsonl` older than `forkTTL` and delete them.
 *
 * Stateless: killing/restarting the janitor never affects live curators. The
 * tick only touches dead/stale entries. Pure logic is exported for unit tests;
 * the fs side-effects are thin wrappers over {@link fs.promises}.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  classifyLiveness,
  heartbeatAgeMs,
  type StalePidEntry,
} from "../util/staleness.js";
import { parseCuratorClaim, type CuratorClaim } from "../util/team-attach-claim.js";
import { isPidAlive } from "../util/fs-lock.js";
import type { CuratorHeartbeatConfig } from "../util/heartbeat-lease.js";

/** Result of a single tick (counts of actions taken). */
export interface TickResult {
  /** Number of dead pids SIGTERMd + archived. */
  swept: number;
  /** Number of forks deleted (older than forkTTL). */
  forksDeleted: number;
  /** Number of stderr log files GC'd (older than forkTTL, D11). */
  logsDeleted: number;
  /** Number of live curators left untouched (for diagnostics). */
  live: number;
  /** Errors encountered (non-fatal — logged, tick continues). */
  errors: string[];
}

export interface TickOptions {
  /** Heartbeat thresholds (defaults applied by caller). */
  heartbeatConfig?: CuratorHeartbeatConfig;
  /** Whether to actually SIGTERM (default true; tests pass false). */
  killPids?: boolean;
  /**
   * Whether to run the `process.kill(pid, 0)` fast-path during classification
   * (default true). Tests set this to false to avoid touching real processes.
   */
  checkPid?: boolean;
  /** Injectable kill (default process.kill). */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Explicit timestamp for deterministic tests. */
  nowMs?: number;
  /** Fork TTL in ms (default 24h). */
  forkTTLms?: number;
  /** Injectable now for fork mtime comparison. */
  stat?: (p: string) => { mtimeMs: number };
  /**
   * Logs directory to GC alongside forks (D11). Recursively scanned for
   * `*.stderr` files older than `forkTTL`; missing dir is a no-op.
   */
  logsDir?: string;
}

/** Classify all pids files in a directory as live/stale/dead. Pure-ish (fs). */
export async function classifyPids(
  pidsDir: string,
  opts: TickOptions = {},
): Promise<StalePidEntry[]> {
  const nowMs = opts.nowMs ?? Date.now();
  let entries: string[];
  try {
    entries = await fs.promises.readdir(pidsDir);
  } catch {
    return [];
  }
  const result: StalePidEntry[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(pidsDir, entry);
    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const claim = parseCuratorClaim(parsed);
    if (!claim) continue;
    const liveness = classifyLiveness(claim, {
      config: opts.heartbeatConfig,
      nowMs,
      checkPid: opts.checkPid !== false,
      // Root-cause fix (builder-runtime, 2026-07-07): `opts.kill` is
      // `((pid, signal: Signals) => void) | undefined`. The cast target
      // `(pid, signal: 0) => void` is unsound when `opts.kill` is undefined,
      // so provide a default (process.kill) before casting. The `signal: 0`
      // literal is a POSIX "check if process exists" signal — process.kill
      // accepts it at runtime even though its type signature says Signals.
      kill: (opts.kill ?? ((p: number, s: NodeJS.Signals) => process.kill(p, s))) as unknown as (pid: number, signal: 0) => void,
    });
    const ageMs = heartbeatAgeMs(claim, nowMs);
    result.push({ ...claim, liveness, ageMs });
  }
  return result;
}

/**
 * Run one janitor tick over a pids directory and a forks directory.
 *
 * Side effects (per REQ-LC-08):
 * - For each `dead` curator: SIGTERM the pid (if alive), then move its pids
 *   file to the archive directory.
 * - For each fork older than `forkTTL`: unlink it.
 *
 * Never throws — all errors are collected in `result.errors` and the tick
 * continues (stateless + non-fatal).
 */
export async function runTick(
  pidsDir: string,
  opts: TickOptions & {
    /** Archive root: `<archiveDir>/<mainSessionId>/<curator>-<ts>.json`. */
    archiveDir: string;
    /** Forks directory to GC. */
    forksDir: string;
  },
): Promise<TickResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const killPids = opts.killPids !== false;
  const forkTTLms = opts.forkTTLms ?? 24 * 60 * 60 * 1000;
  const result: TickResult = { swept: 0, forksDeleted: 0, logsDeleted: 0, live: 0, errors: [] };

  // ── Phase 1: sweep dead curators ──────────────────────────────────────
  const entries = await classifyPids(pidsDir, opts);
  for (const entry of entries) {
    if (entry.liveness === "live") {
      result.live += 1;
      continue;
    }
    if (entry.liveness !== "dead") {
      // stale — leave alone; janitor only reaps dead (REQ-LC-08).
      continue;
    }

    const pidFile = path.join(pidsDir, `${entry.curator}.json`);

    // SIGTERM the pid if it's still alive.
    if (killPids) {
      try {
        // Root-cause fix (builder-runtime, 2026-07-07): provide default before cast.
        if (isPidAlive(entry.pid, (opts.kill ?? ((p: number, s: NodeJS.Signals) => process.kill(p, s))) as unknown as (pid: number, signal: 0) => void)) {
          try {
            (opts.kill ?? ((p: number, s: NodeJS.Signals) => process.kill(p, s)))(
              entry.pid,
              "SIGTERM",
            );
          } catch (killErr) {
            result.errors.push(
              `failed to SIGTERM pid ${entry.pid} (${entry.curator}): ${
                killErr instanceof Error ? killErr.message : String(killErr)
              }`,
            );
          }
        }
      } catch (aliveErr) {
        result.errors.push(
          `isPidAlive check failed for pid ${entry.pid}: ${
            aliveErr instanceof Error ? aliveErr.message : String(aliveErr)
          }`,
        );
      }
    }

    // Archive the pids file: pids-archive/<mainSessionId>/<curator>-<ts>.json
    try {
      const sessionArchiveDir = path.join(opts.archiveDir, entry.mainSessionId);
      await fs.promises.mkdir(sessionArchiveDir, { recursive: true });
      const archivePath = path.join(
        sessionArchiveDir,
        `${entry.curator}-${nowMs}.json`,
      );
      await fs.promises.rename(pidFile, archivePath);
      result.swept += 1;
    } catch (archiveErr) {
      result.errors.push(
        `failed to archive pids file ${pidFile}: ${
          archiveErr instanceof Error ? archiveErr.message : String(archiveErr)
        }`,
      );
    }
  }

  // ── Phase 2: GC old forks ─────────────────────────────────────────────
  let forks: string[];
  try {
    forks = await fs.promises.readdir(opts.forksDir);
  } catch {
    forks = []; // forks dir missing → nothing to GC
  }
  for (const fork of forks) {
    if (!fork.endsWith(".jsonl")) continue;
    const forkPath = path.join(opts.forksDir, fork);
    try {
      const stat = opts.stat
        ? opts.stat(forkPath)
        : await fs.promises.stat(forkPath);
      if (nowMs - stat.mtimeMs > forkTTLms) {
        try {
          await fs.promises.unlink(forkPath);
          result.forksDeleted += 1;
        } catch (delErr) {
          result.errors.push(
            `failed to delete fork ${forkPath}: ${
              delErr instanceof Error ? delErr.message : String(delErr)
            }`,
          );
        }
      }
    } catch (statErr) {
      result.errors.push(
        `failed to stat fork ${forkPath}: ${
          statErr instanceof Error ? statErr.message : String(statErr)
        }`,
      );
    }
  }

  // ── Phase 3: GC old stderr logs (D11) ────────────────────────────────
  // Same TTL as fork artifacts; recursively scans logsDir for *.stderr.
  if (opts.logsDir) {
    let logFiles: string[];
    try {
      logFiles = await collectLogFiles(opts.logsDir);
    } catch {
      logFiles = []; // logs dir missing/unreadable → nothing to GC
    }
    for (const logPath of logFiles) {
      try {
        const stat = opts.stat
          ? opts.stat(logPath)
          : await fs.promises.stat(logPath);
        if (nowMs - stat.mtimeMs > forkTTLms) {
          try {
            await fs.promises.unlink(logPath);
            result.logsDeleted += 1;
          } catch (delErr) {
            result.errors.push(
              `failed to delete log ${logPath}: ${
                delErr instanceof Error ? delErr.message : String(delErr)
              }`,
            );
          }
        }
      } catch (statErr) {
        result.errors.push(
          `failed to stat log ${logPath}: ${
            statErr instanceof Error ? statErr.message : String(statErr)
          }`,
        );
      }
    }
  }

  return result;
}

/**
 * Recursively collect all `*.stderr` file paths under `root`. Missing `root`
 * resolves to an empty array (never throws). Used by the D11 log GC phase.
 */
async function collectLogFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  let top: string[];
  try {
    top = await fs.promises.readdir(root);
  } catch {
    return [];
  }
  for (const entry of top) {
    const entryPath = path.join(root, entry);
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(entryPath);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      // session subdirectory — scan one level deeper (matches the
      // <logsBaseDir>/<mainSessionId>/*.stderr layout).
      let inner: string[];
      try {
        inner = await fs.promises.readdir(entryPath);
      } catch {
        continue;
      }
      for (const f of inner) {
        if (f.endsWith(".stderr")) out.push(path.join(entryPath, f));
      }
    } else if (entry.endsWith(".stderr")) {
      out.push(entryPath);
    }
  }
  return out;
}

export {};
