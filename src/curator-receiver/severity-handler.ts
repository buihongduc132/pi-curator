/**
 * severity-handler.ts — GAP-31 severity-based delivery implementation.
 *
 * Determines how to deliver signals based on severity:
 * - critical: block turn, deliver immediately
 * - warning: deliver as follow-up
 * - info: deliver as next-turn (lowest priority)
 *
 * Also handles auto-creation of files when critical signals include file paths.
 */

import type { IncomingMessage } from "./curator-receiver.js";

export interface SeverityDecision {
  shouldBlock: boolean;
  deliverAs: "steer" | "followUp" | "nextTurn";
  triggerTurn: boolean;
  autoCreateFile?: string;
}

/**
 * Decide how to deliver a signal based on severity.
 *
 * - critical: block turn, deliver immediately (steer)
 * - warning: deliver as follow-up (don't block)
 * - info: deliver as next-turn (don't block, lowest priority)
 * - undefined: default to critical (safe default)
 */
export function decideSeverityAction(
  message: IncomingMessage,
  severity: string | undefined,
): SeverityDecision {
  const decision: SeverityDecision = {
    shouldBlock: false,
    deliverAs: "nextTurn",
    triggerTurn: false,
  };

  // Extract file path if present
  const content = message.content || "";
  const filePath = extractFilePath(content);

  if (severity === "critical") {
    decision.shouldBlock = true;
    decision.deliverAs = "steer";
    decision.triggerTurn = true;

    // Auto-create file if critical + has path
    if (filePath && shouldAutoCreateFile(severity, filePath)) {
      decision.autoCreateFile = filePath;
    }
  } else if (severity === "warning") {
    decision.shouldBlock = false;
    decision.deliverAs = "followUp";
    decision.triggerTurn = false;
  } else if (severity === "info") {
    decision.shouldBlock = false;
    decision.deliverAs = "followUp"; // Changed from nextTurn to followUp
    decision.triggerTurn = false;
  } else {
    // undefined or unknown severity - default to critical (safe)
    decision.shouldBlock = true;
    decision.deliverAs = "steer";
    decision.triggerTurn = true;
  }

  return decision;
}

/**
 * Extract file path from signal content.
 *
 * Looks for patterns like:
 * - "Create `path/to/file.md`" (backtick-enclosed, highest priority)
 * - "```path/to/file.md```" (code block)
 * - "Create path/to/file.md" (plain path after Create keyword)
 */
export function extractFilePath(content: string): string | undefined {
  // Pattern 1: Backtick-enclosed path (highest priority)
  const backtickPattern = /`([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)`/;
  const backtickMatch = content.match(backtickPattern);
  if (backtickMatch) {
    return backtickMatch[1];
  }

  // Pattern 2: Markdown code block with path
  const codeBlockPattern = /```\s*([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)\s*```/;
  const codeBlockMatch = content.match(codeBlockPattern);
  if (codeBlockMatch) {
    return codeBlockMatch[1];
  }

  // Pattern 3: "Create path/to/file.ext" (must include extension)
  const createPattern = /Create\s+([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)/i;
  const createMatch = content.match(createPattern);
  if (createMatch) {
    return createMatch[1];
  }

  return undefined;
}

/**
 * Determine if we should auto-create a file.
 *
 * Only auto-create when:
 * - severity is critical
 * - filePath is defined
 */
export function shouldAutoCreateFile(
  severity: string | undefined,
  filePath: string | undefined,
): boolean {
  return severity === "critical" && filePath !== undefined;
}
