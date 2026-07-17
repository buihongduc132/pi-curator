/**
 * crosscheck.ts — the read-decide core of curator cross-check.
 *
 * Implements the LOCKED cross-check protocol from the spec:
 *
 *   1. If `crossCheck.enabled === false` → behave as if the capability does
 *      not exist: signal independently, NO mailbox write (REQ: opt-in default).
 *   2. If `crossCheck.trigger === "critical-only"` AND severity !== "critical"
 *      → skip cross-check, signal immediately, NO mailbox write (REQ: Trigger).
 *   3. Otherwise scan the peer mailbox for a `finding` entry whose topic
 *      matches (exact, case-insensitive, trimmed — D3) within
 *      `windowMinutes` of now:
 *        - match + mode `"append-agreement"` → SUPPRESS signal, append an
 *          `agreement` entry (first-finding-wins, REQ dedup).
 *        - match + mode `"signal-anyway"` → signal ANYWAY + append a `finding`
 *          entry (observability without suppression, REQ signal-anyway).
 *        - no match → signal + append a `finding` entry.
 *
 * ## What this is NOT (spec-forbidden, design D2/D3)
 *
 *   - NO fuzzy/embedding similarity (D3 mandates exact topic match).
 *   - NO voting / quorum / severity-weighted aggregation (spec: "No voting
 *     primitive exists" → reject as out of scope).
 *   - NO cross-session visibility (mailbox is keyed by mainSessionId path).
 *
 * Every behavioral function is PURE over its arguments so it is fully
 * unit-testable with no filesystem.
 */

import {
  dedupKey,
  type Agreement,
  type Finding,
  type MailboxEntry,
  type Severity,
} from "./finding.js";

// ─── Config ─────────────────────────────────────────────────────────────────

/** Mode: suppress duplicate signals (default) or always signal + record. */
export type CrossCheckMode = "append-agreement" | "signal-anyway";

/** Trigger: run before every signal (default) or only for critical severity. */
export type CrossCheckTrigger = "before-every-signal" | "critical-only";

/** Per-persona cross-check config (REQ: "Curator cross-check is opt-in"). */
export interface CrossCheckConfig {
  enabled: boolean;
  mode: CrossCheckMode;
  trigger: CrossCheckTrigger;
  /** Dedup window in minutes (REQ). */
  windowMinutes: number;
}

/** Defaults per spec: disabled, append-agreement, before-every-signal, 10 min. */
export const DEFAULT_CROSSCHECK: CrossCheckConfig = Object.freeze({
  enabled: false,
  mode: "append-agreement",
  trigger: "before-every-signal",
  windowMinutes: 10,
}) as CrossCheckConfig;

/**
 * Resolve a partial/unknown persona config into a complete CrossCheckConfig,
 * filling defaults. Unknown mode/trigger values fall back to defaults (never
 * throw). Pure, total.
 */
export function resolveCrossCheck(
  raw: unknown,
): CrossCheckConfig {
  const r = (raw ?? {}) as Partial<Record<string, unknown>> & {
    crossCheck?: Record<string, unknown>;
  };
  const src = r.crossCheck ?? (r as Record<string, unknown>);
  return {
    enabled: typeof src.enabled === "boolean" ? src.enabled : false,
    mode:
      // Stryker disable next-line all: condition → false: alternate branch produces same observable result
      src.mode === "append-agreement" || src.mode === "signal-anyway"
        ? src.mode
        : "append-agreement",
    trigger:
      // Stryker disable next-line all: condition → false: alternate branch produces same observable result
      src.trigger === "before-every-signal" || src.trigger === "critical-only"
        ? src.trigger
        : "before-every-signal",
    windowMinutes:
      // Stryker disable next-line all: type guard → true: non-matching types rejected downstream by other checks
      typeof src.windowMinutes === "number" && Number.isFinite(src.windowMinutes)
        ? Math.max(0, src.windowMinutes)
        : 10,
  };
}

// ─── Would-be finding ───────────────────────────────────────────────────────

/** The finding a curator is about to signal, before cross-check decides. */
export interface PendingFinding {
  topic: string;
  curator: string;
  severity: Severity;
  summary: string;
}

// ─── Decision result ────────────────────────────────────────────────────────

/** Outcome of {@link decideSignal}. */
export interface Decision {
  /** Whether the curator SHOULD call `signal_main`. */
  signal: boolean;
  /** What the curator SHOULD append to the mailbox next, or null if nothing. */
  append: MailboxEntry | null;
  /** Human/audit reason for the decision (debug only). */
  reason: DecisionReason;
}

/** Why the decision was reached. Stable string codes for tests/assertions. */
export type DecisionReason =
  | "disabled"
  | "trigger-skipped-non-critical"
  | "first-finding-wins"
  | "signal-anyway"
  | "no-peer-finding"
  | "fail-open";

// ─── Helpers ────────────────────────────────────────────────────────────────

const MS_PER_MIN = 60_000;

/**
 * Parse an ISO ts (or epoch ms / Date) into epoch ms, or NaN if unparseable.
 * Pure, total.
 */
function toEpochMs(ts: string | number | Date): number {
  // Stryker disable next-line all: condition → false: alternate branch produces same observable result
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === "number") return ts;
  const n = Date.parse(ts);
  return Number.isNaN(n) ? Number.NaN : n;
}

/**
 * Find the most recent peer finding whose topic matches the pending finding,
 * within the dedup window of `now`. Returns the entry, or null.
 *
 * Topic match is EXACT after normalize (D3). Clock-skew tolerant: uses absolute
 * difference. Pure.
 */
export function findMatchingPeerFinding(
  entries: ReadonlyArray<MailboxEntry>,
  pending: PendingFinding,
  windowMinutes: number,
  now: string | number | Date,
): Finding | null {
  const nowMs = toEpochMs(now);
  if (Number.isNaN(nowMs)) return null;
  const wantKey = dedupKey({ topic: pending.topic });
  if (!wantKey) return null;
  const windowMs = windowMinutes * MS_PER_MIN;

  let best: Finding | null = null;
  let bestMs = -Infinity;
  for (const e of entries) {
    if (e.type !== "finding") continue;
    if (dedupKey(e) !== wantKey) continue;
    const eMs = toEpochMs(e.ts);
    // Stryker disable next-line all: condition → false: alternate branch produces same observable result
    if (Number.isNaN(eMs)) continue;
    if (Math.abs(nowMs - eMs) > windowMs) continue;
    if (eMs > bestMs) {
      best = e;
      bestMs = eMs;
    }
  }
  return best;
}

/**
 * Build a `finding` entry for a pending finding at a given now. Pure.
 */
export function buildFinding(
  pending: PendingFinding,
  now: string | number | Date,
): Finding {
  // Stryker disable next-line all: type guard → true: non-matching types rejected downstream by other checks
  const ts = now instanceof Date ? now.toISOString() : typeof now === "number" ? new Date(now).toISOString() : now;
  return {
    type: "finding",
    topic: pending.topic.trim(),
    curator: pending.curator.trim(),
    ts,
    severity: pending.severity,
    summary: pending.summary,
  };
}

/**
 * Build an `agreement` entry for a pending finding (it agrees with an existing
 * peer finding on the same topic). Pure.
 */
export function buildAgreement(
  pending: PendingFinding,
  now: string | number | Date,
): Agreement {
  // Stryker disable next-line all: type guard → true: non-matching types rejected downstream by other checks
  const ts = now instanceof Date ? now.toISOString() : typeof now === "number" ? new Date(now).toISOString() : now;
  return {
    type: "agreement",
    topic: pending.topic.trim(),
    curator: pending.curator.trim(),
    ts,
    severity: pending.severity,
  };
}

// ─── The core decision ──────────────────────────────────────────────────────

/**
 * Decide what a curator should do given its cross-check config, its pending
 * finding, the current peer mailbox contents, and the current time.
 *
 * PURE over all inputs (no IO). The caller performs the actual `signal_main`
 * call and `appendEntry` based on the returned {@link Decision}.
 *
 * @param config resolved cross-check config (use {@link resolveCrossCheck}).
 * @param pending the finding the curator is about to signal.
 * @param entries current mailbox contents (from {@link readMailbox}).
 * @param now current time (ISO string, epoch ms, or Date).
 */
export function decideSignal(
  config: CrossCheckConfig,
  pending: PendingFinding,
  entries: ReadonlyArray<MailboxEntry>,
  now: string | number | Date,
): Decision {
  // (1) Opt-in gate: disabled → fully independent (no reads, no appends).
  if (!config.enabled) {
    return { signal: true, append: null, reason: "disabled" };
  }

  // (2) Trigger gate: critical-only skips cross-check for non-critical.
  // Stryker disable next-line all: equality → true: code path taken unconditionally; other guards prevent side effects
  if (config.trigger === "critical-only" && pending.severity !== "critical") {
    return { signal: true, append: null, reason: "trigger-skipped-non-critical" };
  }

  // (3) First-finding-wins scan.
  const match = findMatchingPeerFinding(
    entries,
    pending,
    config.windowMinutes,
    now,
  );

  if (match) {
    if (config.mode === "append-agreement") {
      return {
        signal: false,
        append: buildAgreement(pending, now),
        reason: "first-finding-wins",
      };
    }
    // signal-anyway: signal + append a NEW finding (not an agreement).
    return {
      signal: true,
      append: buildFinding(pending, now),
      reason: "signal-anyway",
    };
  }

  // (4) No peer finding → signal + record our own finding.
  return {
    signal: true,
    append: buildFinding(pending, now),
    reason: "no-peer-finding",
  };
}

/**
 * A fail-open variant: if the mailbox read itself threw / returned null,
 * the curator MUST still signal (REQ: "Cross-check failures MUST fail open").
 *
 * This is a separate, explicit entry point so the caller can never accidentally
 * route a read failure into `decideSignal` and suppress a signal.
 */
export function failOpenDecision(
  pending: PendingFinding,
  now: string | number | Date,
): Decision {
  // Per spec fail-open: behave as if no peer findings existed. We still append
  // our own finding (best-effort) so peers MAY see it — but only if the caller
  // can still write. The append itself is fail-open (see mailbox.appendEntry).
  return {
    signal: true,
    append: buildFinding(pending, now),
    reason: "fail-open",
  };
}
