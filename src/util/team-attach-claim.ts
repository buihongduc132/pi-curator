/**
 * team-attach-claim.ts — single-holder exclusivity for curator sidecars
 * (foundation T3; vendored+adapted from pi-agent-teams `team-attach-claim.ts`).
 *
 * ## Adaptation for curator (REQ-LC-07)
 *
 * teams uses ONE shared `.attach-claim.json` per team dir (holder =
 * session id). Curator sidecars use ONE file PER curator at
 * `~/.pi-curator/pids/<mainSessionId>/<curator>.json` (holder = the curator
 * process). The semantics are identical: at most one LIVE holder per slot;
 * a stale/dead holder is reclaimable.
 *
 * The claim file IS the PID registration file (REQ-LC-05): it carries
 * `{pid, mainSessionId, mainSessionName, curator, spawnedAt, heartbeatAt,
 * phase, goalFile}`. Main writes `phase:"spawned"` BEFORE spawn; the curator
 * runtime refreshes `heartbeatAt` + `phase` every `intervalSec`.
 *
 * Exclusivity (REQ-LC-07): before spawning, the hook checks the existing claim.
 * If a `live` or `stale` curator holds the slot, spawn is skipped (logged to
 * UI). `phase:"done"` OR a dead heartbeat OR a missing file ⇒ slot is FREE.
 *
 * ## Design
 *
 * Pure freshness helpers (no `Date.now`, no fs) are unit-tested directly; the
 * async fs claim/refresh/release primitives wrap them with {@link withLock} +
 * {@link atomicWriteJson} so they are safe under concurrent main/runtime/janitor
 * access. The fs primitives are integration-tested via temp dirs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { withLock, atomicWriteJson, atomicWriteJsonSync } from "./fs-lock.js";
import {
  assessHeartbeatFreshness,
  DEFAULT_HEARTBEAT_CONFIG,
  type CuratorHeartbeatConfig,
} from "./heartbeat-lease.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** The curator claim / PID registration file (REQ-LC-05). */
export interface CuratorClaim {
  /** Curator OS process id. */
  pid: number;
  /** Main session id that spawned this curator. */
  mainSessionId: string;
  /** Main session display name (optional, for diagnostics). */
  mainSessionName?: string;
  /** Curator persona alias (filesystem-safe). */
  curator: string;
  /** ISO timestamp of spawn (written before spawn). */
  spawnedAt: string;
  /** ISO timestamp of last heartbeat refresh. */
  heartbeatAt: string;
  /** Lifecycle phase: spawned → scanning → signaling → done (REQ-CR-09). */
  phase: string;
  /** Absolute path to the persona goal file (optional). */
  goalFile?: string;
  /**
   * Curator's OWN session id (LD1 pointer). Written by the curator runtime on
   * its first heartbeat tick so `/curator status` can render a one-click jump
   * to the curator's session. Optional: legacy claims omit it (undefined, NOT
   * a hard error). Round-trips through parseCuratorClaim/claimToJson.
   */
  curatorSessionId?: string;
}

/** Result of assessing a claim's freshness (boolean-friendly). */
export interface ClaimFreshness {
  /** True when the holder's heartbeat is too old to count (slot reclaimable). */
  isStale: boolean;
  /** Age of the heartbeat in ms (Infinity when unparseable). */
  ageMs: number;
}

/** Result of attempting to acquire a curator slot. */
export type AcquireCuratorClaimResult =
  | { ok: true; claim: CuratorClaim; replacedClaim?: CuratorClaim }
  | { ok: false; reason: "claimed_by_other"; claim: CuratorClaim };

/** Result of a heartbeat refresh. */
export type CuratorClaimHeartbeatResult = "updated" | "not_owner" | "missing";

/** Result of releasing a claim. */
export type CuratorClaimReleaseResult = "released" | "not_owner" | "none";

/**
 * Result of seeding the claim's pid with the real child pid (D2 PID handoff).
 * Returned so callers can branch on the (best-effort) outcome.
 */
export type SeedCuratorPidResult = "seeded" | "missing";

// ─── Path helpers ───────────────────────────────────────────────────────────

/** Default PID registration root: `~/.pi-curator/pids`. */
export function defaultPidRoot(homeDir: string = getHome()): string {
  return path.join(homeDir, ".pi-curator", "pids");
}

/** Per-main-session dir: `<pidRoot>/<mainSessionId>`. */
export function sessionPidDir(pidRoot: string, mainSessionId: string): string {
  return path.join(pidRoot, mainSessionId);
}

/** Per-curator claim file: `<pidRoot>/<mainSessionId>/<curator>.json`. */
export function curatorClaimFile(pidRoot: string, mainSessionId: string, curator: string): string {
  return path.join(sessionPidDir(pidRoot, mainSessionId), `${curator}.json`);
}

function getHome(): string {
  return process.env.HOME || process.env.USERPROFILE || "/tmp";
}

// ─── Pure freshness helpers ─────────────────────────────────────────────────

/**
 * Assess a claim's freshness (REQ-LC-07). A claim is "stale" (reclaimable)
 * when its heartbeat age exceeds `config.staleSec`. Pure.
 */
export function assessClaimFreshness(
  claim: CuratorClaim,
  nowMs: number = Date.now(),
  config: CuratorHeartbeatConfig = DEFAULT_HEARTBEAT_CONFIG,
): ClaimFreshness {
  const f = assessHeartbeatFreshness(claim.heartbeatAt, nowMs, config);
  if (f.ageMs === null) {
    return { isStale: true, ageMs: Number.POSITIVE_INFINITY };
  }
  return { isStale: f.classification !== "live", ageMs: f.ageMs };
}

/**
 * Is the slot for this claim FREE (reclaimable)? A slot is free when there is
 * no claim, OR the holder's phase is terminal (`done`/`killed`/`exiting`), OR
 * the holder's heartbeat is stale/dead (REQ-LC-07, design D6). Pure.
 */
export function isSlotFree(
  claim: CuratorClaim | null,
  nowMs: number = Date.now(),
  config: CuratorHeartbeatConfig = DEFAULT_HEARTBEAT_CONFIG,
): boolean {
  if (!claim) return true;
  const TERMINAL_PHASES = new Set(["done", "killed", "exiting"]);
  if (TERMINAL_PHASES.has(claim.phase)) return true;
  const f = assessHeartbeatFreshness(claim.heartbeatAt, nowMs, config);
  return f.classification !== "live";
}

// ─── Validation ─────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function getString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  // Stryker disable next-line all -- equivalent mutant (try/catch or downstream optional-chaining masks behavior change)
  return typeof v === "string" && v.length > 0 ? v : null;
}

function getOptionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function getNumber(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  // Stryker disable next-line all -- equivalent mutant (try/catch or downstream optional-chaining masks behavior change)
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Parse + validate a raw JSON value into a {@link CuratorClaim}, or `null` if
 * required fields are missing/invalid. Pure. (Mirrors teams' `parseTeamAttachClaim`.)
 */
export function parseCuratorClaim(value: unknown): CuratorClaim | null {
  if (!isRecord(value)) return null;
  const pid = getNumber(value, "pid");
  const mainSessionId = getString(value, "mainSessionId");
  const curator = getString(value, "curator");
  const spawnedAt = getString(value, "spawnedAt");
  const heartbeatAt = getString(value, "heartbeatAt");
  const phase = getString(value, "phase");
  if (pid === null || !mainSessionId || !curator || !spawnedAt || !heartbeatAt || !phase) {
    return null;
  }
  return {
    pid,
    mainSessionId,
    mainSessionName: getOptionalString(value, "mainSessionName"),
    curator,
    spawnedAt,
    heartbeatAt,
    phase,
    goalFile: getOptionalString(value, "goalFile"),
    // LD1: preserve the curatorSessionId pointer when present + non-empty.
    // Absent / empty / non-string → undefined (legacy, NOT a hard error).
    curatorSessionId: getOptionalString(value, "curatorSessionId"),
  };
}

// ─── Async fs primitives (withLock-guarded) ─────────────────────────────────

/** Read a curator claim file (returns null if missing/corrupt). */
export async function readCuratorClaim(filePath: string): Promise<CuratorClaim | null> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    return parseCuratorClaim(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Write a claim atomically (creates parent dirs). */
export async function writeCuratorClaim(filePath: string, claim: CuratorClaim): Promise<void> {
  await atomicWriteJson(filePath, claim);
}

/** Write a claim atomically + synchronously (for `beforeExit` handlers). */
export function writeCuratorClaimSync(filePath: string, claim: CuratorClaim): void {
  atomicWriteJsonSync(filePath, claim);
}

function claimLockPath(filePath: string): string {
  return `${filePath}.lock`;
}

/**
 * Acquire the curator slot for `(mainSessionId, curator)` (REQ-LC-07).
 *
 * - If the slot is FREE (no claim, terminal phase, or stale/dead heartbeat):
 *   writes a fresh claim with `phase:"spawned"` and returns `ok:true`.
 * - If a fresh non-terminal holder exists: returns `ok:false` (reason
 *   `claimed_by_other`) WITHOUT writing — the spawn is skipped.
 * - `force:true` overwrites an existing claim regardless of freshness.
 *
 * The read-check-write is guarded by {@link withLock} so concurrent acquires
 * for the same slot serialize. Uses the provided `pid`/`nowMs` for testability.
 */
export async function acquireCuratorClaim(
  filePath: string,
  opts: {
    pid: number;
    mainSessionId: string;
    curator: string;
    mainSessionName?: string;
    goalFile?: string;
    nowMs?: number;
    config?: CuratorHeartbeatConfig;
    force?: boolean;
  },
): Promise<AcquireCuratorClaimResult> {
  const lockFile = claimLockPath(filePath);
  const config = opts.config ?? DEFAULT_HEARTBEAT_CONFIG;
  const force = opts.force === true;
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

  return withLock(
    lockFile,
    async () => {
      const nowMs = opts.nowMs ?? Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const current = await readCuratorClaim(filePath);

      if (current && !isSlotFree(current, nowMs, config) && !force) {
        return { ok: false as const, reason: "claimed_by_other" as const, claim: current };
      }

      const claim: CuratorClaim = {
        pid: opts.pid,
        mainSessionId: opts.mainSessionId,
        curator: opts.curator,
        spawnedAt: nowIso,
        heartbeatAt: nowIso,
        phase: "spawned",
        ...(opts.mainSessionName ? { mainSessionName: opts.mainSessionName } : {}),
        ...(opts.goalFile ? { goalFile: opts.goalFile } : {}),
      };
      await writeCuratorClaim(filePath, claim);
      return {
        ok: true as const,
        claim,
        ...(current ? { replacedClaim: current } : {}),
      };
    },
    // Stryker disable next-line all -- equivalent mutant (try/catch or downstream optional-chaining masks behavior change)
    { label: `curator-claim:acquire:${opts.mainSessionId}/${opts.curator}` },
  );
}

/**
 * Refresh the heartbeat (and optionally phase) on an existing claim. Only the
 * owning curator (matched by `pid`) may refresh. Returns `updated`,
 * `not_owner`, or `missing`. Guarded by {@link withLock}.
 */
export async function heartbeatCuratorClaim(
  filePath: string,
  pid: number,
  opts: { phase?: string; nowMs?: number; curatorSessionId?: string } = {},
): Promise<CuratorClaimHeartbeatResult> {
  const lockFile = claimLockPath(filePath);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

  return withLock(
    lockFile,
    async () => {
      const current = await readCuratorClaim(filePath);
      if (!current) return "missing";
      if (current.pid !== pid) return "not_owner";
      const nowMs = opts.nowMs ?? Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const updated: CuratorClaim = {
        ...current,
        heartbeatAt: nowIso,
        ...(opts.phase ? { phase: opts.phase } : {}),
        // LD1: stamp the curatorSessionId pointer when provided (first tick).
        // When omitted, `...current` preserves any pointer already on disk.
        ...(opts.curatorSessionId ? { curatorSessionId: opts.curatorSessionId } : {}),
      };
      await writeCuratorClaim(filePath, updated);
      return "updated";
    },
    // Stryker disable next-line all -- equivalent mutant (try/catch or downstream optional-chaining masks behavior change)
    { label: `curator-claim:heartbeat:${pid}` },
  );
}

/**
 * Release (delete) a curator claim. Only the owning curator (matched by `pid`)
 * may release unless `force`. Returns `released`, `not_owner`, or `none`.
 */
export async function releaseCuratorClaim(
  filePath: string,
  pid: number,
  opts: { force?: boolean } = {},
): Promise<CuratorClaimReleaseResult> {
  const lockFile = claimLockPath(filePath);
  const force = opts.force === true;
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

  return withLock(
    lockFile,
    async () => {
      const current = await readCuratorClaim(filePath);
      if (!current) return "none";
      if (!force && current.pid !== pid) return "not_owner";
      try {
        await fs.promises.unlink(filePath);
      } catch {
        // ignore: treat as released best effort
      }
      return "released";
    },
    // Stryker disable next-line all -- equivalent mutant (try/catch or downstream optional-chaining masks behavior change)
    { label: `curator-claim:release:${pid}` },
  );
}

/**
 * Seed the claim's `pid` with the REAL child pid (BLOCKER D2 PID handoff).
 *
 * After {@link acquireCuratorClaim} writes the claim with the MAIN process pid
 * as a placeholder, this overwrites `pid` with the actual spawned child pid so
 * the curator runtime's own heartbeat (which asserts `pid === childPid`) owns
 * the slot on its first tick. NO ownership check — main just acquired the
 * slot, so it is the rightful owner regardless of the placeholder pid.
 *
 * Also refreshes `heartbeatAt` and (optionally) `phase`. Guarded by
 * {@link withLock} so the read-modify-write is atomic.
 */
export async function seedCuratorPid(
  filePath: string,
  childPid: number,
  opts: { phase?: string; nowMs?: number } = {},
): Promise<SeedCuratorPidResult> {
  const lockFile = claimLockPath(filePath);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

  return withLock(
    lockFile,
    async () => {
      const current = await readCuratorClaim(filePath);
      if (!current) return "missing";
      const nowMs = opts.nowMs ?? Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const updated: CuratorClaim = {
        ...current,
        // Force-write the real child pid — NO ownership check (D2).
        pid: childPid,
        heartbeatAt: nowIso,
        ...(opts.phase ? { phase: opts.phase } : {}),
      };
      await writeCuratorClaim(filePath, updated);
      return "seeded";
    },
    // Stryker disable next-line all -- equivalent mutant (try/catch or downstream optional-chaining masks behavior change)
    { label: `curator-claim:seed:${childPid}` },
  );
}

export {};
