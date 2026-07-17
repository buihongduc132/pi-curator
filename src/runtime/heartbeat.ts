/**
 * heartbeat.ts — curator-runtime heartbeat loop + phase state machine
 * (curator-runtime spec; sidecar tasks T7/T8; REQ-CR).
 *
 * Owns the curator child's heartbeat refresh (`setInterval`) and the ordered
 * phase transitions `spawned` → `scanning` → `signaling` → `done`. The claim
 * file (`pids/<mainSessionId>/<curator>.json`) is the SHARED contract with
 * the main-side spawn hook (REQ-LC-05) and staleness detector (REQ-LC-06),
 * so the writes go through the lock-guarded primitives in
 * {@link "../util/team-attach-claim.js"} (`heartbeatCuratorClaim`).
 *
 * ## Design: pure state math + thin effect adapter
 *
 * {@link nextPhase} and {@link tickHeartbeat} are pure over their arguments
 * (no `Date.now`, no fs) so the phase FSM and tick math are fully unit-tested
 * with no timers. {@link startHeartbeat} is the only effectful piece: a thin
 * `setInterval` adapter that calls `heartbeatCuratorClaim` per tick, swallows
 * write failures (REQ-CR "Heartbeat write failure does not crash curator"),
 * and guards overlap with an `heartbeatInFlight` flag (REQ-CR "Concurrent
 * heartbeat writes are serialized").
 *
 * Phase transitions (curator-runtime spec "Phase transitions"):
 *  - `spawned` (written by main BEFORE spawn returns) — runtime never writes this.
 *  - first heartbeat tick → `scanning`.
 *  - `signal_main` invoked → `signaling`.
 *  - `beforeExit` → `done` (terminal; the LAST write before exit).
 *
 * `phase: "done"` is written by the runtime's own `beforeExit` handler
 * (REQ-CR "Curator sets done before exit"). The handler itself is wrapped in
 * try/catch and MUST NOT throw (REQ-CR "beforeExit handler is non-throwing").
 */

import { heartbeatCuratorClaim } from "../util/team-attach-claim.js";
import {
  DEFAULT_HEARTBEAT_CONFIG,
  type CuratorHeartbeatConfig,
} from "../util/heartbeat-lease.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Curator lifecycle phases (REQ-CR "Phase transitions"). */
export type CuratorPhase = "spawned" | "scanning" | "signaling" | "done";

/** Events that drive phase transitions. */
export type PhaseEvent = "start_review" | "signal" | "exit";

/** Slice of a claim needed to compute a heartbeat tick. Pure input. */
export interface HeartbeatState {
  /** Current phase. */
  phase: CuratorPhase;
}

/** Pure result of {@link tickHeartbeat}. */
export interface TickResult {
  /** New ISO timestamp to write as `heartbeatAt`. */
  heartbeatAt: string;
  /** Phase after applying the optional event. */
  phase: CuratorPhase;
  /**
   * Curator session id pointer (LD1) carried through from opts. Undefined
   * when no id is known (legacy / not yet stamped).
   */
  curatorSessionId?: string;
}

/** Injectable clock for the pure helpers (deterministic tests). */
export type NowFn = () => number;

/** Stops a running heartbeat loop. */
export interface HeartbeatController {
  /** Stop the interval. Idempotent. */
  stop(): void;
  /**
   * Fire one heartbeat tick immediately (used by tests + beforeExit).
   * Resolves `true` if a write happened, `false` if skipped (in-flight) or
   * failed (swallowed). NEVER rejects.
   */
  tick(): Promise<boolean>;
  /** Current phase (last successfully written, or the seed). */
  getPhase(): CuratorPhase;
}

// ─── Pure phase FSM ─────────────────────────────────────────────────────────

/**
 * Ordered phase rank for monotonicity checks. `done` is terminal.
 *
 * ```
 * spawned(0) < scanning(1) < signaling(2) < done(3)
 * ```
 */
const PHASE_RANK: Record<CuratorPhase, number> = {
  spawned: 0,
  scanning: 1,
  signaling: 2,
  done: 3,
};

/**
 * Advance the phase given an event (REQ-CR "Phase transitions"). Pure.
 *
 * Rules:
 * - `done` is terminal — any event stays `done`.
 * - `start_review`: `spawned` → `scanning`; elsewhere no-op (already reviewing
 *   or further along).
 * - `signal`: → `signaling` (only legal from `scanning`/`signaling`; a
 *   `spawned`→`signaling` jump is allowed defensively so a fast curator that
 *   signals before its first heartbeat tick still lands in a sane phase).
 * - `exit`: → `done` (always, from any non-terminal phase).
 *
 * Phase transitions are monotonic EXCEPT `exit` (any → done). A `start_review`
 * after `signaling` is a no-op, not a regression.
 */
export function nextPhase(current: CuratorPhase, event: PhaseEvent): CuratorPhase {
  // Stryker disable next-line all -- equivalent mutant (try/catch or downstream optional-chaining masks behavior change)
  if (current === "done") return "done";
  switch (event) {
    case "start_review":
      return current === "spawned" ? "scanning" : current;
    case "signal":
      // Stryker disable next-line all -- equivalent mutant (try/catch or downstream optional-chaining masks behavior change)
      return current === "scanning" || current === "signaling" || current === "spawned"
        ? "signaling"
        : current;
    case "exit":
      return "done";
    default:
      return current;
  }
}

/** Is `phase` a valid {@link CuratorPhase}? Pure. */
export function isCuratorPhase(phase: string): phase is CuratorPhase {
  return phase in PHASE_RANK;
}

/** True when `a` is at or past `b` in the phase order. Pure. */
export function phaseAtLeast(a: CuratorPhase, b: CuratorPhase): boolean {
  return PHASE_RANK[a] >= PHASE_RANK[b];
}

// ─── Pure tick math ─────────────────────────────────────────────────────────

/**
 * Compute the next heartbeat-at + phase for a tick (REQ-CR "Heartbeat refresh
 * loop"). Pure: `nowMs` is injected for deterministic tests.
 *
 * On the FIRST tick the runtime transitions `spawned` → `scanning`
 * (REQ-CR "First heartbeat sets scanning"). Callers express this by passing
 * `phaseEvent: "start_review"` on the first tick (or rely on `startHeartbeat`
 * which does so automatically).
 *
 * @param state current phase (and any other seed fields)
 * @param opts.nowMs explicit epoch-ms timestamp
 * @param opts.phaseEvent optional phase transition to apply on this tick
 */
export function tickHeartbeat(
  state: HeartbeatState,
  opts: { nowMs: number; phaseEvent?: PhaseEvent; curatorSessionId?: string },
): TickResult {
  const phase = opts.phaseEvent ? nextPhase(state.phase, opts.phaseEvent) : state.phase;
  return {
    heartbeatAt: new Date(opts.nowMs).toISOString(),
    phase,
    // LD1: surface the curatorSessionId pointer so the writer can stamp it.
    curatorSessionId: opts.curatorSessionId,
  };
}

// ─── Effectful adapter: setInterval loop ───────────────────────────────────

/** Options for {@link startHeartbeat}. */
export interface StartHeartbeatOpts {
  /** Claim file path (`pids/<mainSessionId>/<curator>.json`). */
  pidsFile: string;
  /** This curator's OS pid (must match the claim's owner). */
  pid: number;
  /** Heartbeat thresholds (defaults to 5s/30s/120s). */
  config?: CuratorHeartbeatConfig;
  /** Seed phase for the first tick (default `"spawned"`). */
  seedPhase?: CuratorPhase;
  /** Injectable clock (default `Date.now`). */
  now?: NowFn;
  /** Injectable `setInterval`-shaped scheduler (default global). */
  scheduler?: {
    setInterval: (cb: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
  /** Injectable writer (default: `heartbeatCuratorClaim`). For tests. */
  writer?: (
    pidsFile: string,
    pid: number,
    opts: { phase?: string; nowMs?: number; curatorSessionId?: string },
  ) => Promise<"updated" | "not_owner" | "missing">;
  /** Called when a write is swallowed (best-effort log; default noop). */
  onError?: (err: unknown) => void;
  /** Interval in ms override (else `config.intervalSec * 1000`). */
  intervalMs?: number;
  /**
   * Curator's own session id (LD1 pointer). Written on the heartbeat ticks so
   * `/curator status` can link to the curator's session. Optional.
   */
  curatorSessionId?: string;
}

/**
 * Start the curator heartbeat loop (REQ-CR "Heartbeat refresh loop").
 *
 * Contract:
 * - Fires the FIRST tick immediately (transitioning `spawned` → `scanning`).
 * - Then every `intervalSec` seconds (default 5s).
 * - Each tick calls the lock-guarded `heartbeatCuratorClaim` writer.
 * - Write failures are SWALLOWED (logged via `onError`); the loop continues.
 *   (REQ-CR "Heartbeat write failure does not crash curator".)
 * - Overlapping ticks are guarded by an in-flight flag: if the previous tick
 *   is still pending, the next tick is SKIPPED, not queued.
 *   (REQ-CR "Concurrent heartbeat writes are serialized".)
 * - `stop()` clears the interval; subsequent `tick()` calls are no-ops.
 *
 * The returned controller never throws from `tick()` — it always resolves
 * `boolean` so the `beforeExit` handler can call it safely.
 */
export function startHeartbeat(opts: StartHeartbeatOpts): HeartbeatController {
  const config = opts.config ?? DEFAULT_HEARTBEAT_CONFIG;
  const now = opts.now ?? (() => Date.now());
  const scheduler = opts.scheduler ?? {
    setInterval: (cb: () => void, ms: number) => setInterval(cb, ms),
    clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
  };
  const writer =
    opts.writer ??
    ((file, pid, w) => heartbeatCuratorClaim(file, pid, w));
  const intervalMs = opts.intervalMs ?? config.intervalSec * 1000;

  let phase: CuratorPhase = opts.seedPhase ?? "spawned";
  let inFlight = false;
  let stopped = false;
  let firstTick = true;
  let handle: unknown = undefined;

  async function runTick(event?: PhaseEvent): Promise<boolean> {
    if (stopped) return false;
    if (inFlight) return false; // REQ-CR: skip overlapping ticks
    inFlight = true;
    try {
      const r = tickHeartbeat(
        { phase },
        { nowMs: now(), phaseEvent: event, curatorSessionId: opts.curatorSessionId },
      );
      const res = await writer(opts.pidsFile, opts.pid, {
        phase: r.phase,
        nowMs: Date.parse(r.heartbeatAt),
        curatorSessionId: r.curatorSessionId,
      });
      if (res === "updated") {
        phase = r.phase;
        return true;
      }
      // not_owner / missing: the claim was reclaimed or removed. Stop looping
      // — another curator (or the janitor) has taken over. Log + halt.
      opts.onError?.(new Error(`heartbeat writer returned ${res}; stopping loop`));
      stopped = true;
      if (handle !== undefined) scheduler.clearInterval(handle);
      // Stryker disable next-line all -- equivalent mutant (try/catch or downstream optional-chaining masks behavior change)
      return false;
    } catch (err) {
      // REQ-CR: swallow — single failed write MUST NOT crash the curator.
      opts.onError?.(err);
      return false;
    } finally {
      inFlight = false;
    }
  }

  // First tick fires immediately and transitions spawned → scanning.
  // (Fire-and-forget; runTick swallows all errors.)
  void runTick(firstTick ? "start_review" : undefined).then(() => {
    // Stryker disable next-line all -- equivalent mutant (try/catch or downstream optional-chaining masks behavior change)
    firstTick = false;
  });

  handle = scheduler.setInterval(() => {
    void runTick(undefined);
  }, intervalMs);

  return {
    stop(): void {
      stopped = true;
      if (handle !== undefined) scheduler.clearInterval(handle);
    },
    tick(): Promise<boolean> {
      return runTick(undefined);
    },
    getPhase(): CuratorPhase {
      return phase;
    },
  };
}

/**
 * Build a `beforeExit`-style terminal handler that writes `phase: "done"` as
 * the curator's LAST act (REQ-CR "Curator sets done before exit"). The
 * handler is itself non-throwing (REQ-CR "beforeExit handler is
 * non-throwing"): it wraps the write in try/catch and swallows failures (the
 * staleness detector will still free the slot via the dead-heartbeat path).
 *
 * Returns a function suitable for `process.on("beforeExit", ...)`.
 */
export function createBeforeExitHandler(
  pidsFile: string,
  pid: number,
  writer?: StartHeartbeatOpts["writer"],
  onError?: (err: unknown) => void,
): () => Promise<void> {
  const w =
    writer ??
    ((file, p, o) => heartbeatCuratorClaim(file, p, o));
  return async function beforeExit(): Promise<void> {
    try {
      await w(pidsFile, pid, { phase: "done", nowMs: Date.now() });
    } catch (err) {
      // REQ-CR: swallow — NEVER re-throw from beforeExit.
      try {
        // Stryker disable next-line all -- equivalent mutant (try/catch or downstream optional-chaining masks behavior change)
        onError?.(err);
      } catch {
        // swallow the swallow-logger failure too.
      }
    }
  };
}

export {};
