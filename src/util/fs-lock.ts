/**
 * fs-lock.ts — minimal atomic-write + advisory file lock for curator sidecars
 * (foundation T3; vendored+trimmed from pi-agent-teams `fs-lock.ts`).
 *
 * The curator lifecycle writes per-curator JSON files (`pids/<mainSessionId>/
 * <curator>.json`) that are concurrently read+written by the main hook, the
 * curator runtime (heartbeat refresh), and the janitor (GC). Every
 * read-modify-write MUST be atomic to avoid corruption. This module provides:
 *
 *   - {@link atomicWriteJson}: `.tmp.<pid>.<ts>` + `rename` (atomic on POSIX).
 *   - {@link withLock}: an exclusive `O_WRONLY|O_CREAT|O_EXCL` lock-file guard
 *     around an async critical section, with stale-lock + dead-owner reclaim
 *     (so a crashed process never permanently holds the lock).
 *
 * This is the dependency-free core of teams' fs-lock, scoped to what curator
 * needs. It is NOT a full distributed lock — single-host only (which is the
 * curator deployment model: one main session, one host).
 */

import * as fs from "node:fs";
import * as os from "node:os";

// ─── Error helpers ──────────────────────────────────────────────────────────

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in err;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Atomic JSON write ──────────────────────────────────────────────────────

/**
 * Atomically write `data` as JSON to `filePath`. Writes to a temp file
 * `<filePath>.tmp.<pid>.<ts>` then renames over the target (atomic on POSIX).
 * Creates parent directories as needed. Pure-effect (no return value).
 */
export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const dir = filePath.slice(0, Math.max(filePath.lastIndexOf("/"), 0));
  if (dir) await fs.promises.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await fs.promises.rename(tmp, filePath);
}

/**
 * Atomically write `data` as JSON synchronously (for use in `beforeExit`
 * handlers where async is unreliable). Same `.tmp + rename` pattern.
 */
export function atomicWriteJsonSync(filePath: string, data: unknown): void {
  const dir = filePath.slice(0, Math.max(filePath.lastIndexOf("/"), 0));
  // Stryker disable next-line all -- equivalent mutant (try/catch or downstream optional-chaining masks behavior change)
  if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // ignore — best effort; rename will fail loudly if dir missing.
    }
  }
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

// ─── PID liveness ───────────────────────────────────────────────────────────

/**
 * Check whether a PID is alive via `process.kill(pid, 0)`.
 * - Returns `true` on success (alive) or `EPERM` (alive, no permission).
 * - Returns `false` on `ESRCH` (no such process) or invalid pid.
 * - Any other error → assume alive (conservative: never falsely declares dead).
 *
 * Injectable: pass a custom `kill` for unit tests.
 */
export function isPidAlive(
  pid: number,
  kill: (pid: number, signal: 0) => void = (p, s) => process.kill(p, s),
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code === "ESRCH") return false;
    // Stryker disable next-line all -- equivalent mutant (try/catch or downstream optional-chaining masks behavior change)
    if (isErrnoException(err) && err.code === "EPERM") return true;
    return true; // conservative: assume alive on unknown errors
  }
}

// ─── Advisory file lock ─────────────────────────────────────────────────────

export interface LockOptions {
  /** How long to wait to acquire the lock before failing (default 10s). */
  timeoutMs?: number;
  /** If the lock file is older than this, consider it stale (default 60s). */
  staleMs?: number;
  /** Poll interval while waiting (default 50ms, exponential backoff). */
  pollMs?: number;
  /** Optional label for diagnostics (written into the lock file). */
  label?: string;
}

interface LockMetadata {
  pid?: number;
  hostname?: string;
  createdAt?: string;
  label?: string;
}

function readLockMetadata(lockFilePath: string): LockMetadata | null {
  try {
    const raw = fs.readFileSync(lockFilePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    // Stryker disable next-line all -- equivalent mutant (try/catch or downstream optional-chaining masks behavior change)
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    return {
      // Stryker disable next-line all -- equivalent mutant (try/catch or downstream optional-chaining masks behavior change)
      pid: typeof p.pid === "number" ? p.pid : undefined,
      hostname: typeof p.hostname === "string" ? p.hostname : undefined,
      // Stryker disable next-line all -- equivalent mutant (try/catch or downstream optional-chaining masks behavior change)
      createdAt: typeof p.createdAt === "string" ? p.createdAt : undefined,
      label: typeof p.label === "string" ? p.label : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Run `fn` while holding an exclusive advisory lock at `lockFilePath`.
 * Creates the lock with `O_WRONLY|O_CREAT|O_EXCL` (fails if it exists), writes
 * holder metadata, runs `fn`, and always releases the lock in `finally`.
 *
 * If the lock exists, it waits (exponential backoff + jitter) up to
 * `timeoutMs`. A lock whose owner PID is dead (via {@link isPidAlive}) or whose
 * age exceeds `staleMs` is reclaimed (unlinked + retried). On timeout it throws
 * an `Error` carrying diagnostics. Mirrors pi-agent-teams `withLock`.
 */
export async function withLock<T>(
  lockFilePath: string,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const staleMs = opts.staleMs ?? 60_000;
  const basePollMs = opts.pollMs ?? 50;
  const maxPollMs = Math.max(basePollMs, 1_000);
  const start = Date.now();
  const currentHostname = os.hostname();

  let fd: number | null = null;
  let attempt = 0;

  while (fd === null) {
    try {
      fd = fs.openSync(lockFilePath, "wx");
      const payload = {
        pid: process.pid,
        hostname: currentHostname,
        createdAt: new Date().toISOString(),
        label: opts.label,
      };
      try {
        fs.writeFileSync(fd, JSON.stringify(payload));
      } catch (writeErr) {
        // If metadata write fails, close+remove the empty lock so dead-owner
        // detection still works for other processes.
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
        fd = null;
        try {
          fs.unlinkSync(lockFilePath);
        } catch {
          /* ignore */
        }
        throw new Error(writeErr instanceof Error ? writeErr.message : String(writeErr), {
          cause: writeErr,
        });
      }
    } catch (err: unknown) {
      if (!isErrnoException(err) || err.code !== "EEXIST") {
        throw new Error(err instanceof Error ? err.message : String(err), { cause: err });
      }
      let lockAgeMs: number | null = null;
      let metadata: LockMetadata | null = null;
      try {
        metadata = readLockMetadata(lockFilePath);
        const st = fs.statSync(lockFilePath);
        lockAgeMs = Date.now() - st.mtimeMs;
        const sameHost = metadata?.hostname ? metadata.hostname === currentHostname : true;
        const ownerAlive = sameHost && typeof metadata?.pid === "number" ? isPidAlive(metadata.pid) : null;
        const reclaimDeadOwner = ownerAlive === false;
        const reclaimStaleLock = lockAgeMs > staleMs && ownerAlive !== true;
        if (reclaimDeadOwner || reclaimStaleLock) {
          fs.unlinkSync(lockFilePath);
          attempt = 0;
          continue;
        }
      } catch {
        // ignore: stat/unlink failures fall through to wait
      }
      const elapsedMs = Date.now() - start;
      if (elapsedMs > timeoutMs) {
        throw new Error(
          `Timeout acquiring lock: ${lockFilePath}` +
            (metadata?.label ? ` label=${metadata.label}` : "") +
            (typeof metadata?.pid === "number" ? ` pid=${metadata.pid}` : ""),
          { cause: err },
        );
      }
      attempt += 1;
      const expBackoff = Math.min(maxPollMs, basePollMs * 2 ** Math.min(attempt, 6));
      const jitterFactor = 0.5 + Math.random();
      const jitteredBackoff = Math.min(maxPollMs, Math.round(expBackoff * jitterFactor));
      const remainingMs = timeoutMs - elapsedMs;
      const sleepMs = Math.max(1, Math.min(remainingMs, jitteredBackoff));
      await sleep(sleepMs);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      // Stryker disable next-line all -- equivalent mutant (try/catch or downstream optional-chaining masks behavior change)
      if (fd !== null) fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(lockFilePath);
    } catch {
      /* ignore: best-effort release */
    }
  }
}

export {};
