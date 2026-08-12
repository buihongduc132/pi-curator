/**
 * severity-handler.test.ts — TDD RED phase for GAP-31 severity-based delivery.
 *
 * Requirements:
 * - Critical signals block main turn (deliverAs: "steer", triggerTurn: true)
 * - Info/warning signals queue as append
 * - Critical signals with file paths auto-create files
 */

import { describe, it, expect } from "vitest";
import type { IncomingMessage } from "./curator-receiver.js";
import {
  decideSeverityAction,
  extractFilePath,
  shouldAutoCreateFile,
  type SeverityDecision,
} from "./severity-handler.js";

describe("GAP-31: Severity Handler", () => {
  describe("decideSeverityAction", () => {
    it("should block turn for critical severity", () => {
      const message = {
        content: "CRITICAL: Evil merge detected",
        details: { severity: "critical" },
      } as IncomingMessage;

      const result = decideSeverityAction(message, "critical");

      expect(result.shouldBlock).toBe(true);
      expect(result.deliverAs).toBe("steer");
      expect(result.triggerTurn).toBe(true);
    });

    it("should not block for info severity", () => {
      const message = {
        content: "Info: Task completed",
        details: { severity: "info" },
      } as IncomingMessage;

      const result = decideSeverityAction(message, "info");

      expect(result.shouldBlock).toBe(false);
      expect(result.deliverAs).toBe("followUp");
      expect(result.triggerTurn).toBe(false);
    });

    it("should not block for warning severity", () => {
      const message = {
        content: "Warning: Minor issue",
        details: { severity: "warning" },
      } as IncomingMessage;

      const result = decideSeverityAction(message, "warning");

      expect(result.shouldBlock).toBe(false);
      expect(result.deliverAs).toBe("followUp");
      expect(result.triggerTurn).toBe(false);
    });

    it("should default to safe (block) when severity undefined", () => {
      const message = {
        content: "Unknown severity signal",
        details: {},
      } as IncomingMessage;

      const result = decideSeverityAction(message, undefined);

      expect(result.shouldBlock).toBe(true);
      expect(result.deliverAs).toBe("steer");
    });
  });

  describe("extractFilePath", () => {
    it("should extract file path from curator recommendation", () => {
      const content = `
## Critical Finding

Evil merge detected. Create tracking doc at:
\`flow/findings/DEFECT-2-evil-merge.md\`

Details...
`;

      const result = extractFilePath(content);

      expect(result).toBe("flow/findings/DEFECT-2-evil-merge.md");
    });

    it("should extract path after 'Create' keyword", () => {
      const content = "Curator recommends: Create flow/worktree/wt-fix.md to track this.";

      const result = extractFilePath(content);

      expect(result).toBe("flow/worktree/wt-fix.md");
    });

    it("should return undefined when no file path found", () => {
      const content = "This is just a message with no file path";

      const result = extractFilePath(content);

      expect(result).toBeUndefined();
    });

    it("should handle markdown code blocks", () => {
      const content = "```\nflow/plans/fix-plan.md\n```";

      const result = extractFilePath(content);

      expect(result).toBe("flow/plans/fix-plan.md");
    });
  });

  describe("shouldAutoCreateFile", () => {
    it("should auto-create file for critical + file path", () => {
      const result = shouldAutoCreateFile("critical", "flow/findings/defect.md");

      expect(result).toBe(true);
    });

    it("should not auto-create file for info severity", () => {
      const result = shouldAutoCreateFile("info", "flow/findings/info.md");

      expect(result).toBe(false);
    });

    it("should not auto-create file when no path", () => {
      const result = shouldAutoCreateFile("critical", undefined);

      expect(result).toBe(false);
    });

    it("should not auto-create file when severity undefined", () => {
      const result = shouldAutoCreateFile(undefined, "flow/findings/test.md");

      expect(result).toBe(false);
    });
  });

  describe("integration: severity + file path", () => {
    it("should include autoCreateFile in decision for critical + path", () => {
      const message = {
        content: "CRITICAL: Create flow/findings/DEFECT-2.md to track evil merge",
        details: { severity: "critical" },
      } as IncomingMessage;

      const result = decideSeverityAction(message, "critical");

      expect(result.shouldBlock).toBe(true);
      expect(result.autoCreateFile).toBe("flow/findings/DEFECT-2.md");
    });

    it("should not include autoCreateFile for info even with path", () => {
      const message = {
        content: "Info: See flow/notes/info.md for details",
        details: { severity: "info" },
      } as IncomingMessage;

      const result = decideSeverityAction(message, "info");

      expect(result.shouldBlock).toBe(false);
      expect(result.autoCreateFile).toBeUndefined();
    });
  });
});
