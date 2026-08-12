/**
 * Integration tests for GAP-31/32 implementation.
 * Verifies rate-limiter and severity-handler work together correctly.
 */

import { describe, it, expect } from "vitest";
import type { IncomingMessage } from "./curator-receiver.js";
import {
  addToQueue,
  shouldDeliver,
  expireOldSignals,
  deduplicateQueue,
  batchSignals,
  markDelivered,
  removeFromQueue,
  type RateLimiterState,
} from "./rate-limiter.js";
import {
  decideSeverityAction,
  extractFilePath,
  shouldAutoCreateFile,
} from "./severity-handler.js";

describe("GAP-31/32 Integration", () => {
  describe("Full signal processing pipeline", () => {
    it("should process multiple signals with rate limiting and severity", () => {
      // Start with empty state
      let state: RateLimiterState = {
        queue: [],
        currentTurn: 1,
        deliveredThisTurn: false,
      };

      // Add critical signal
      const criticalMsg: IncomingMessage = {
        content: "Create `flow/findings/DEFECT-1.md` to track this issue",
        details: { severity: "critical" },
      };
      state = addToQueue(state, criticalMsg, "hash1");

      // Add warning signal
      const warningMsg: IncomingMessage = {
        content: "Warning: potential issue detected",
        details: { severity: "warning" },
      };
      state = addToQueue(state, warningMsg, "hash2");

      // Verify queue has 2 signals
      expect(state.queue).toHaveLength(2);
      expect(shouldDeliver(state)).toBe(true);

      // Batch and deliver
      const batched = batchSignals(state.queue);
      expect(batched.content).toContain("2 curator signals");

      // Mark delivered
      state = markDelivered(state);
      expect(shouldDeliver(state)).toBe(false);

      // Remove delivered signals
      state = removeFromQueue(state);
      state = removeFromQueue(state);
      expect(state.queue).toHaveLength(0);
    });

    it("should handle severity-based routing correctly", () => {
      // Critical signal should block
      const criticalMsg: IncomingMessage = {
        content: "Create `flow/findings/DEFECT-2.md`",
        details: { severity: "critical" },
      };
      const criticalDecision = decideSeverityAction(criticalMsg, "critical");
      expect(criticalDecision.shouldBlock).toBe(true);
      expect(criticalDecision.deliverAs).toBe("steer");
      expect(criticalDecision.autoCreateFile).toBe("flow/findings/DEFECT-2.md");

      // Warning signal should not block
      const warningMsg: IncomingMessage = {
        content: "Warning message",
        details: { severity: "warning" },
      };
      const warningDecision = decideSeverityAction(warningMsg, "warning");
      expect(warningDecision.shouldBlock).toBe(false);
      expect(warningDecision.deliverAs).toBe("followUp");
      expect(warningDecision.autoCreateFile).toBeUndefined();
    });

    it("should deduplicate identical signals", () => {
      let state: RateLimiterState = {
        queue: [],
        currentTurn: 1,
        deliveredThisTurn: false,
      };

      // Add same signal twice
      const msg: IncomingMessage = {
        content: "Same signal content",
        details: { severity: "info" },
      };
      state = addToQueue(state, msg, "same-hash");
      state = addToQueue(state, msg, "same-hash");

      expect(state.queue).toHaveLength(2);

      // Deduplicate
      state = deduplicateQueue(state);
      expect(state.queue).toHaveLength(1);
    });

    it("should expire old signals", () => {
      let state: RateLimiterState = {
        queue: [],
        currentTurn: 10,
        deliveredThisTurn: false,
      };

      // Add old signal (turn 1)
      const oldMsg: IncomingMessage = {
        content: "Old signal",
        details: { severity: "info" },
      };
      state = addToQueue(state, oldMsg, "old-hash");
      state.queue[0].turnReceived = 1;

      // Add recent signal (turn 9)
      const recentMsg: IncomingMessage = {
        content: "Recent signal",
        details: { severity: "info" },
      };
      state = addToQueue(state, recentMsg, "recent-hash");
      state.queue[1].turnReceived = 9;

      expect(state.queue).toHaveLength(2);

      // Expire signals older than 5 turns
      state = expireOldSignals(state, 5);
      expect(state.queue).toHaveLength(1);
      expect(state.queue[0].hash).toBe("recent-hash");
    });

    it("should auto-create file for critical signals with path", () => {
      const msg: IncomingMessage = {
        content: "Critical issue found. Create `flow/findings/CRITICAL-1.md` immediately",
        details: { severity: "critical" },
      };

      const filePath = extractFilePath(msg.content || "");
      expect(filePath).toBe("flow/findings/CRITICAL-1.md");

      const shouldCreate = shouldAutoCreateFile("critical", filePath);
      expect(shouldCreate).toBe(true);

      const decision = decideSeverityAction(msg, "critical");
      expect(decision.autoCreateFile).toBe("flow/findings/CRITICAL-1.md");
    });

    it("should batch single signal without wrapping", () => {
      const msg: IncomingMessage = {
        content: "Single signal",
        details: { severity: "info" },
      };

      const state: RateLimiterState = {
        queue: [{ message: msg, turnReceived: 1, hash: "hash1" }],
        currentTurn: 1,
        deliveredThisTurn: false,
      };

      const batched = batchSignals(state.queue);
      expect(batched.content).toBe("Single signal");
      expect(batched.details).toEqual({ severity: "info" });
    });

    it("should handle mixed severity signals in batch", () => {
      let state: RateLimiterState = {
        queue: [],
        currentTurn: 1,
        deliveredThisTurn: false,
      };

      // Add critical, warning, and info signals
      const criticalMsg: IncomingMessage = {
        content: "Create `flow/findings/DEFECT-1.md`",
        details: { severity: "critical" },
      };
      state = addToQueue(state, criticalMsg, "hash1");

      const warningMsg: IncomingMessage = {
        content: "Warning message",
        details: { severity: "warning" },
      };
      state = addToQueue(state, warningMsg, "hash2");

      const infoMsg: IncomingMessage = {
        content: "Info message",
        details: { severity: "info" },
      };
      state = addToQueue(state, infoMsg, "hash3");

      expect(state.queue).toHaveLength(3);

      // Batch all signals
      const batched = batchSignals(state.queue);
      expect(batched.content).toContain("3 curator signals");
      expect(batched.content).toContain("DEFECT-1");
      expect(batched.content).toContain("Warning");
      expect(batched.content).toContain("Info");
    });
  });
});
