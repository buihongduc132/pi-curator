/**
 * rate-limiter.ts — GAP-31/32 implementation: rate limiting, deduplication, expiry.
 *
 * Prevents signal fatigue by:
 * - Limiting to 1 signal delivery per turn
 * - Batching multiple signals into summary
 * - Expiring old signals (>N turns)
 * - Deduplicating identical signals (by hash)
 */

import type { IncomingMessage } from "./curator-receiver.js";

export interface QueuedSignal {
  message: IncomingMessage;
  turnReceived: number;
  hash: string;
}

export interface RateLimiterState {
  queue: QueuedSignal[];
  currentTurn: number;
  deliveredThisTurn: boolean;
}

/**
 * Add signal to queue with current turn tracking.
 */
export function addToQueue(
  state: RateLimiterState,
  message: IncomingMessage,
  hash: string,
): RateLimiterState {
  return {
    ...state,
    queue: [
      ...state.queue,
      {
        message,
        turnReceived: state.currentTurn,
        hash,
      },
    ],
  };
}

/**
 * Check if we should deliver a signal this turn.
 * Returns true if queue has signals AND we haven't delivered yet this turn.
 */
export function shouldDeliver(state: RateLimiterState): boolean {
  return state.queue.length > 0 && !state.deliveredThisTurn;
}

/**
 * Remove signals older than maxAgeTurns from queue.
 * Prevents stale signals from accumulating.
 */
export function expireOldSignals(
  state: RateLimiterState,
  maxAgeTurns: number,
): RateLimiterState {
  const minTurn = state.currentTurn - maxAgeTurns;
  return {
    ...state,
    queue: state.queue.filter((signal) => signal.turnReceived >= minTurn),
  };
}

/**
 * Remove duplicate signals based on hash.
 * Keeps first occurrence of each unique hash.
 */
export function deduplicateQueue(state: RateLimiterState): RateLimiterState {
  const seen = new Set<string>();
  const deduped: QueuedSignal[] = [];

  for (const signal of state.queue) {
    if (!seen.has(signal.hash)) {
      seen.add(signal.hash);
      deduped.push(signal);
    }
  }

  return {
    ...state,
    queue: deduped,
  };
}

/**
 * Batch multiple signals into one summary message.
 * Single signal passes through unchanged.
 */
export function batchSignals(signals: QueuedSignal[]): IncomingMessage {
  if (signals.length === 1) {
    return signals[0].message;
  }

  const contents = signals.map((s) => s.message.content || "").filter(Boolean);
  const summary = `Received ${signals.length} curator signals:\n\n${contents.join("\n\n---\n\n")}`;

  return {
    content: summary,
    details: {
      ...signals[0].message.details,
      batched: true,
      signalCount: signals.length,
    },
  };
}

/**
 * Mark that we've delivered a signal this turn.
 * Call after successful delivery to prevent multiple deliveries.
 */
export function markDelivered(state: RateLimiterState): RateLimiterState {
  return {
    ...state,
    deliveredThisTurn: true,
  };
}

/**
 * Advance to next turn (reset deliveredThisTurn flag).
 * Call at start of each new turn.
 */
export function advanceTurn(state: RateLimiterState): RateLimiterState {
  return {
    ...state,
    currentTurn: state.currentTurn + 1,
    deliveredThisTurn: false,
  };
}

/**
 * Remove delivered signal from queue.
 * Call after successful delivery.
 */
export function removeFromQueue(state: RateLimiterState): RateLimiterState {
  return {
    ...state,
    queue: state.queue.slice(1), // Remove first (oldest) signal
  };
}
