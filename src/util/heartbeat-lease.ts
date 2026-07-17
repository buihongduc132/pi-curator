/**
 * heartbeat-lease.ts — curator heartbeat freshness assessment (foundation T3;
 * vendored+adapted from pi-agent-teams `heartbeat-lease.ts`).
 *
 * ## Adaptation for curator
 *
 * pi-agent-teams tracks heartbeats across a `members[]` array with a single
 * `staleMs` threshold (worker online/offline). Curator sidecars use a richer
 * 3-class liveness model (REQ-LC-06):
 *
 *   - `live`:  `now - heartbeatAt ≤ staleSec`  (default 30s)
 *   - `stale`: `staleSec < now - heartbeatAt ≤ deadSec` (default 30–120s)
 *   - `dead`:  `now - heartbeatAt > deadSec` (default >120s)
 *
 * The heartbeat refresh interval (default 5s) is also configurable per the
 * persona's `heartbeat.{intervalSec,staleSec,deadSec}` (REQ-CF-03 persona
 * schema). Heartbeats are ON by default for curators (unlike teams, which is
 * opt-in).
 *
 * ## Design: pure functions
 *
 * Every function is pure over its arguments (no `Date.now`, no filesystem) so
 * it is fully unit-testable. The filesystem claim/refresh primitives live in
 * {@link "./team-attach-claim.ts"}; this module is the pure math layer shared
 * by staleness detection ({@link "./staleness.ts"}) and the claim guard.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** Curator liveness classification (REQ-LC-06). */
export type LivenessClass = "live" | "stale" | "dead";

/** Curator heartbeat thresholds (seconds). */
export interface CuratorHeartbeatConfig {
  /** Refresh interval (default 5s — the curator writes heartbeatAt this often). */
  intervalSec: number;
  /** `live` while heartbeat age ≤ staleSec (default 30s). */
  staleSec: number;
  /** `dead` once heartbeat age > deadSec (default 120s). Between stale/dead = stale. */
  deadSec: number;
}

/** Result of assessing a single heartbeat's freshness. */
export interface HeartbeatFreshness {
  /** The 3-class liveness verdict. */
  classification: LivenessClass;
  /** Discriminator matching {@link classification} (useful for exhaustive switches). */
  reason: "fresh" | "stale" | "dead" | "missing" | "invalid";
  /** Age of the heartbeat in ms (null when heartbeatAt is missing/invalid). */
  ageMs: number | null;
  /** Parsed heartbeat timestamp in epoch ms (null when missing/invalid). */
  lastSeenMs: number | null;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

/** Default curator heartbeat thresholds (REQ-LC-06, REQ-CF-03 persona schema). */
export const DEFAULT_HEARTBEAT_CONFIG: CuratorHeartbeatConfig = {
  intervalSec: 5,
  staleSec: 30,
  deadSec: 120,
};

const ENV = {
  intervalSec: "PI_CURATOR_HEARTBEAT_INTERVAL_SEC",
  staleSec: "PI_CURATOR_HEARTBEAT_STALE_SEC",
  deadSec: "PI_CURATOR_HEARTBEAT_DEAD_SEC",
};

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolve the curator heartbeat config from env overrides (seconds) falling
 * back to {@link DEFAULT_HEARTBEAT_CONFIG}. Env-tunable per design D7 / locked
 * decision "reuse the heartbeat-lease pattern". Pure (takes env as arg).
 */
export function getCuratorHeartbeatConfig(
  env: NodeJS.ProcessEnv = process.env,
): CuratorHeartbeatConfig {
  return {
    intervalSec: parsePositiveNumber(env[ENV.intervalSec], DEFAULT_HEARTBEAT_CONFIG.intervalSec),
    staleSec: parsePositiveNumber(env[ENV.staleSec], DEFAULT_HEARTBEAT_CONFIG.staleSec),
    deadSec: parsePositiveNumber(env[ENV.deadSec], DEFAULT_HEARTBEAT_CONFIG.deadSec),
  };
}

// ─── Parsing ────────────────────────────────────────────────────────────────

/**
 * Parse an ISO-8601 timestamp to epoch ms. Returns `null` when missing or
 * unparseable. Pure. (Mirrors teams' `parseIsoMs`.)
 */
export function parseIsoMs(value: string | undefined | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// ─── Freshness assessment (the core math) ───────────────────────────────────

/**
 * Assess a single heartbeat's freshness against the curator thresholds
 * (REQ-LC-06). Returns the 3-class verdict plus age + reason.
 *
 * Classification:
 * - `heartbeatAt` missing → `dead` (reason `missing`).
 * - `heartbeatAt` unparseable → `dead` (reason `invalid`).
 * - age ≤ staleSec*1000 → `live` (reason `fresh`).
 * - staleSec < age ≤ deadSec → `stale`.
 * - age > deadSec → `dead`.
 *
 * Pure (takes `nowMs` explicitly so tests are deterministic).
 */
export function assessHeartbeatFreshness(
  heartbeatAt: string | undefined | null,
  nowMs: number,
  config: CuratorHeartbeatConfig = DEFAULT_HEARTBEAT_CONFIG,
): HeartbeatFreshness {
  const staleMs = config.staleSec * 1000;
  const deadMs = config.deadSec * 1000;

  if (!heartbeatAt) {
    return { classification: "dead", reason: "missing", ageMs: null, lastSeenMs: null };
  }
  const lastSeenMs = parseIsoMs(heartbeatAt);
  if (lastSeenMs === null) {
    return { classification: "dead", reason: "invalid", ageMs: null, lastSeenMs: null };
  }
  const ageMs = Math.max(0, nowMs - lastSeenMs);
  if (ageMs <= staleMs) {
    return { classification: "live", reason: "fresh", ageMs, lastSeenMs };
  }
  if (ageMs <= deadMs) {
    return { classification: "stale", reason: "stale", ageMs, lastSeenMs };
  }
  return { classification: "dead", reason: "dead", ageMs, lastSeenMs };
}

/**
 * Convenience: the boolean "is this slot free for a new curator?" — true when
 * there is no fresh heartbeat holder (the slot is free if the last claim is
 * stale/dead/missing). Used by the exclusivity check (REQ-LC-07). Pure.
 */
export function isSlotHeld(
  heartbeatAt: string | undefined | null,
  nowMs: number,
  config: CuratorHeartbeatConfig = DEFAULT_HEARTBEAT_CONFIG,
): boolean {
  const f = assessHeartbeatFreshness(heartbeatAt, nowMs, config);
  return f.classification === "live" || f.classification === "stale";
}

export {};
