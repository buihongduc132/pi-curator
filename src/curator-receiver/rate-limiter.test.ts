/**
 * rate-limiter.test.ts — TDD RED phase for GAP-31/32 rate limiting.
 *
 * Requirements:
 * - Max 1 signal delivery per turn (batch multiple signals)
 * - Signals older than N turns auto-expire
 * - Deduplication based on signal hash
 */

import { describe, it, expect } from "vitest";
import type { IncomingMessage } from "./curator-receiver.js";
import {
  addToQueue,
  shouldDeliver,
  expireOldSignals,
  deduplicateQueue,
  batchSignals,
  type RateLimiterState,
} from "./rate-limiter.js";

describe("GAP-31/32: Rate Limiter", () => {
  describe("addToQueue", () => {
    it("should add signal to queue with current turn", () => {
      const state: RateLimiterState = {
        queue: [],
        currentTurn: 5,
        deliveredThisTurn: false,
      };
      const message = {
        content: "test signal",
        details: { severity: "info" },
      } as IncomingMessage;

      const result = addToQueue(state, message, "hash123");

      expect(result.queue).toHaveLength(1);
      expect(result.queue[0].hash).toBe("hash123");
      expect(result.queue[0].turnReceived).toBe(5);
    });
  });

  describe("shouldDeliver", () => {
    it("should allow delivery when none delivered this turn", () => {
      const state: RateLimiterState = {
        queue: [
          {
            message: { content: "signal" } as IncomingMessage,
            turnReceived: 1,
            hash: "hash1",
          },
        ],
        currentTurn: 1,
        deliveredThisTurn: false,
      };

      expect(shouldDeliver(state)).toBe(true);
    });

    it("should block delivery when already delivered this turn", () => {
      const state: RateLimiterState = {
        queue: [
          {
            message: { content: "signal" } as IncomingMessage,
            turnReceived: 1,
            hash: "hash1",
          },
        ],
        currentTurn: 1,
        deliveredThisTurn: true,
      };

      expect(shouldDeliver(state)).toBe(false);
    });

    it("should block when queue is empty", () => {
      const state: RateLimiterState = {
        queue: [],
        currentTurn: 1,
        deliveredThisTurn: false,
      };

      expect(shouldDeliver(state)).toBe(false);
    });
  });

  describe("expireOldSignals", () => {
    it("should remove signals older than maxAgeTurns", () => {
      const state: RateLimiterState = {
        queue: [
          {
            message: { content: "old" } as IncomingMessage,
            turnReceived: 1,
            hash: "hash1",
          },
          {
            message: { content: "recent" } as IncomingMessage,
            turnReceived: 8,
            hash: "hash2",
          },
        ],
        currentTurn: 10,
        deliveredThisTurn: false,
      };

      const result = expireOldSignals(state, 5);

      expect(result.queue).toHaveLength(1);
      expect(result.queue[0].hash).toBe("hash2");
    });

    it("should keep all signals when within age limit", () => {
      const state: RateLimiterState = {
        queue: [
          {
            message: { content: "sig1" } as IncomingMessage,
            turnReceived: 8,
            hash: "hash1",
          },
          {
            message: { content: "sig2" } as IncomingMessage,
            turnReceived: 9,
            hash: "hash2",
          },
        ],
        currentTurn: 10,
        deliveredThisTurn: false,
      };

      const result = expireOldSignals(state, 5);

      expect(result.queue).toHaveLength(2);
    });
  });

  describe("deduplicateQueue", () => {
    it("should remove duplicate signals based on hash", () => {
      const state: RateLimiterState = {
        queue: [
          {
            message: { content: "signal A" } as IncomingMessage,
            turnReceived: 1,
            hash: "hashA",
          },
          {
            message: { content: "signal B" } as IncomingMessage,
            turnReceived: 2,
            hash: "hashB",
          },
          {
            message: { content: "signal A duplicate" } as IncomingMessage,
            turnReceived: 3,
            hash: "hashA", // duplicate
          },
        ],
        currentTurn: 5,
        deliveredThisTurn: false,
      };

      const result = deduplicateQueue(state);

      expect(result.queue).toHaveLength(2);
      expect(result.queue.map((s) => s.hash)).toEqual(["hashA", "hashB"]);
      // Should keep first occurrence
      expect(result.queue[0].turnReceived).toBe(1);
    });

    it("should handle empty queue", () => {
      const state: RateLimiterState = {
        queue: [],
        currentTurn: 1,
        deliveredThisTurn: false,
      };

      const result = deduplicateQueue(state);

      expect(result.queue).toHaveLength(0);
    });
  });

  describe("batchSignals", () => {
    it("should combine multiple signals into one summary message", () => {
      const signals: QueuedSignal[] = [
        {
          message: {
            content: "Signal 1: DEFECT-1 found",
            details: { severity: "high" },
          } as IncomingMessage,
          turnReceived: 1,
          hash: "hash1",
        },
        {
          message: {
            content: "Signal 2: DEFECT-2 found",
            details: { severity: "critical" },
          } as IncomingMessage,
          turnReceived: 2,
          hash: "hash2",
        },
      ];

      const result = batchSignals(signals);

      expect(result.content).toContain("2 curator signals");
      expect(result.content).toContain("DEFECT-1");
      expect(result.content).toContain("DEFECT-2");
    });

    it("should return single signal unchanged when batch size = 1", () => {
      const signals: QueuedSignal[] = [
        {
          message: {
            content: "Single signal",
            details: { severity: "info" },
          } as IncomingMessage,
          turnReceived: 1,
          hash: "hash1",
        },
      ];

      const result = batchSignals(signals);

      expect(result.content).toBe("Single signal");
    });
  });
});
