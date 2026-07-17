/**
 * trim-session.ts — context trim for curator forks (REQ-LC-03, foundation T2).
 *
 * After the non-bias filter ({@link "./filter-session"}) produces the active-
 * branch, thinking-stripped entries, this module trims from the top (oldest
 * first) so the resulting context fits the curator's budget.
 *
 * ## Algorithm (REQ-LC-03, design D4/D5)
 *
 * 1. **Token estimation** reuses pi core's `estimateTokens` heuristic exactly
 *    (chars/4 per content block; tool results count chars of their content;
 *    thinking blocks count their chars — matched to pi so there is no drift).
 * 2. **Walk backwards** from the newest entry, accumulating tokens.
 * 3. **Cut at the earliest valid cut point** that keeps the kept-suffix total
 *    ≤ budget. Valid cut points: `message` entries whose role is
 *    `user`/`assistant`/`bashExecution`/`custom`/`branchSummary`/
 *    `compactionSummary`, plus `custom_message` and `branch_summary` entries.
 * 4. **NEVER cut at a `toolResult` message** — it must stay attached to its
 *    tool call (turns are atomic units). If the budget-driven cut falls on a
 *    toolResult, the cut moves FORWARD to the next valid cut point.
 * 5. **Soft 60% recent / hard 90% budget**: the budget the caller passes IS
 *    the 90% hard ceiling (via {@link computeBudget}); greedy backward fill
 *    naturally prefers the most recent turns and drops the oldest — the
 *    "prefer keeping the most recent 60%" outcome (design D4 step 3). When the
 *    whole session fits in budget, nothing is trimmed.
 *
 * ## Design: pure functions
 *
 * Every function is pure over its arguments (no filesystem, no `Date.now`)
 * so it is fully unit-testable. `estimateTokens` mirrors pi's exported helper
 * verbatim (verified against `@earendil-works/pi-coding-agent` compaction.js).
 *
 * @see pi `docs/session-format.md` for the entry/message shapes consumed here.
 */

import type { SessionEntry, MessageLike, ContentBlock } from "./filter-session.js";

// ─── Token estimation (mirrors pi core `estimateTokens`) ────────────────────

/** Chars pi attributes to an image content block (≈ 4800 ≈ 1200 tokens). */
export const ESTIMATED_IMAGE_CHARS = 4800;

/**
 * Estimate the char count of a message's `content`, treating strings as their
 * `.length`, image blocks as {@link ESTIMATED_IMAGE_CHARS}, and text blocks as
 * their `.length`. Pure. (Mirrors pi's `estimateTextAndImageContentChars`.)
 */
export function estimateContentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as ContentBlock;
    if (b.type === "text" && typeof b.text === "string") chars += b.text.length;
    else if (b.type === "image") chars += ESTIMATED_IMAGE_CHARS;
  }
  return chars;
}

/**
 * Estimate the token count of a message using the chars/4 heuristic. This is
 * CONSERVATIVE (overestimates tokens). Matches pi core's `estimateTokens`
 * exactly so curator trimming never drifts from pi's own compaction math.
 *
 * Counted per role:
 * - `user` / `custom` / `toolResult`: chars of content / 4.
 * - `assistant`: text.length + thinking.length + toolCall(name + args JSON) / 4.
 * - `bashExecution`: (command + output).length / 4.
 * - `branchSummary` / `compactionSummary`: summary.length / 4.
 *
 * Pure.
 */
export function estimateTokens(message: MessageLike): number {
  let chars = 0;
  switch (message.role) {
    case "user":
    case "custom":
    case "toolResult":
      chars = estimateContentChars(message.content);
      break;
    case "assistant": {
      const content = message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block !== "object" || block === null) continue;
          const b = block as ContentBlock;
          if (b.type === "text" && typeof b.text === "string") chars += b.text.length;
          else if (b.type === "thinking" && typeof b.thinking === "string") chars += b.thinking.length;
          else if (b.type === "toolCall") {
            chars += typeof b.name === "string" ? b.name.length : 0;
            chars += JSON.stringify(b.arguments ?? {}).length;
          }
        }
      }
      break;
    }
    case "bashExecution":
      chars = (typeof message.command === "string" ? message.command.length : 0)
        + (typeof message.output === "string" ? message.output.length : 0);
      break;
    case "branchSummary":
    case "compactionSummary":
      chars = typeof message.summary === "string" ? message.summary.length : 0;
      break;
    default:
      chars = 0;
  }
  return Math.ceil(chars / 4);
}

/**
 * Extract the AgentMessage-like object an entry contributes to LLM context,
 * mirroring pi's `getMessageFromEntry`. Returns `null` for entries that don't
 * contribute to context. Pure.
 */
export function getMessageFromEntry(entry: SessionEntry): MessageLike | null {
  switch (entry.type) {
    case "message":
      return (entry.message as MessageLike) ?? null;
    case "custom_message":
      // custom_message → custom-role message (content participates in context).
      return { role: "custom", content: entry.content };
    case "branch_summary":
      return { role: "branchSummary", summary: entry.summary };
    case "compaction":
      return { role: "compactionSummary", summary: entry.summary };
    default:
      return null;
  }
}

/**
 * Estimate the token cost of a single session entry. Returns 0 for entries
 * that don't contribute to LLM context. Pure.
 */
export function estimateEntryTokens(entry: SessionEntry): number {
  const message = getMessageFromEntry(entry);
  return message ? estimateTokens(message) : 0;
}

// ─── Cut-point detection (REQ-LC-03) ────────────────────────────────────────

/** Roles that are valid cut points when they appear on a `message` entry. */
const VALID_CUT_ROLES: ReadonlySet<string> = new Set([
  "user",
  "assistant",
  "bashExecution",
  "custom",
  "branchSummary",
  "compactionSummary",
]);

/**
 * Determine whether an entry is a VALID CUT POINT — a place where the kept
 * suffix may begin. Valid cut points:
 * - `message` entries whose role is NOT `toolResult` (user/assistant/
 *   bashExecution/custom/branchSummary/compactionSummary).
 * - `custom_message` and `branch_summary` entries.
 *
 * NEVER a `toolResult` message — it must stay attached to its tool call.
 * `compaction` entries are kept when in range but are NOT cut points (matches
 * pi's `findValidCutPoints`). Pure. (REQ-LC-03.)
 */
export function isValidCutPoint(entry: SessionEntry): boolean {
  switch (entry.type) {
    case "message": {
      const role = (entry.message as MessageLike | undefined)?.role;
      return typeof role === "string" && role !== "toolResult" && VALID_CUT_ROLES.has(role);
    }
    case "custom_message":
    case "branch_summary":
      return true;
    default:
      return false;
  }
}

/**
 * Find the indices of all valid cut points in the entry range. Pure.
 * (Mirrors pi's `findValidCutPoints`.)
 */
export function findValidCutPoints(
  entries: ReadonlyArray<SessionEntry>,
  startIndex = 0,
  endIndex = entries.length,
): number[] {
  const cutPoints: number[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    if (isValidCutPoint(entries[i])) cutPoints.push(i);
  }
  return cutPoints;
}

// ─── Budget computation (90% ceiling, REQ-LC-03) ────────────────────────────

export interface BudgetOptions {
  /** Tokens reserved for the curator's output (default 8192, design D4). */
  reserveForOutput?: number;
  /** Fraction of the context window that is the hard ceiling (default 0.9). */
  ceilingRatio?: number;
}

/**
 * Compute the effective trim budget = floor(contextWindow * ceilingRatio) -
 * reserveForOutput. The 90% ceiling leaves 10% headroom for the curator's
 * system prompt + output (REQ-LC-03 "90%-budget ceiling"). Pure.
 */
export function computeBudget(contextWindow: number, opts: BudgetOptions = {}): number {
  const ceilingRatio = opts.ceilingRatio ?? 0.9;
  const reserveForOutput = opts.reserveForOutput ?? 8192;
  return Math.max(0, Math.floor(contextWindow * ceilingRatio) - reserveForOutput);
}

// ─── Core trim ──────────────────────────────────────────────────────────────

export interface TrimOptions {
  /** Hard token budget (the kept-suffix total must be ≤ budget). */
  budget: number;
  /**
   * Soft target: aim to keep at least this fraction of the most recent turns
   * (default 0.6, REQ-LC-03 "60% recent"). Greedy backward fill keeps as much
   * recent context as fits; this ratio documents the recency preference and is
   * honored whenever budget allows (design D4 step 3).
   */
  recentTargetRatio?: number;
}

export interface TrimResult {
  /** The trimmed entries (kept suffix), in original chronological order. */
  entries: SessionEntry[];
  /** Index in the input where the kept suffix begins. */
  cutIndex: number;
  /** Total estimated tokens of the kept entries. */
  keptTokens: number;
  /** Total estimated tokens of ALL input entries. */
  totalTokens: number;
  /** True when at least one entry was trimmed from the top. */
  trimmed: boolean;
}

/**
 * Trim session entries to fit a token budget, walking backwards from the
 * newest entry and cutting at the earliest valid cut point that keeps the
 * kept-suffix total ≤ budget (REQ-LC-03). Turns are atomic: a `toolResult`
 * is never a cut point, so the budget-driven cut moves forward to the next
 * valid cut point rather than orphaning a tool result from its call.
 *
 * Behavior:
 * - If the whole session fits in budget, returns everything (`cutIndex: 0`).
 * - If even the single most-recent turn exceeds budget (oversized turn),
 *   returns from the last valid cut point (best effort — no splitting within a
 *   turn; design D4 step 4 deferred to a future change).
 *
 * Pure. The 60% soft target is the recency preference greedy fill realizes:
 * oldest entries are dropped first, newest kept.
 */
export function trimSessionEntries(
  entries: ReadonlyArray<SessionEntry>,
  opts: TrimOptions,
): TrimResult {
  const budget = Math.max(0, opts.budget);
  const tokens = entries.map(estimateEntryTokens);
  const totalTokens = tokens.reduce((a, b) => a + b, 0);

  // Whole session fits → keep everything.
  if (totalTokens <= budget) {
    return { entries: entries.slice(), cutIndex: 0, keptTokens: totalTokens, totalTokens, trimmed: false };
  }

  // Suffix token sums: suffixTokens[i] = sum(tokens[i..end]).
  // Computed by walking backwards once.
  const n = entries.length;
  const suffixTokens = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    suffixTokens[i] = suffixTokens[i + 1] + tokens[i];
  }

  const cutPoints = findValidCutPoints(entries, 0, n);

  // Find the SMALLEST (earliest, most inclusive) valid cut index whose kept
  // suffix total is ≤ budget. Walking the cut points in ascending index order,
  // the first one with suffixTokens[i] ≤ budget is the answer.
  let cutIndex = -1;
  for (const i of cutPoints) {
    if (suffixTokens[i] <= budget) {
      cutIndex = i;
      break;
    }
  }

  if (cutIndex === -1) {
    // No valid cut point fits in budget — single oversized-turn case.
    // Keep from the LAST valid cut point (most recent turn) as best effort.
    if (cutPoints.length > 0) {
      cutIndex = cutPoints[cutPoints.length - 1];
    } else {
      // No valid cut points at all (e.g. only toolResult entries): keep all.
      cutIndex = 0;
    }
  }

  const kept = entries.slice(cutIndex);
  const keptTokens = suffixTokens[cutIndex];
  return { entries: kept, cutIndex, keptTokens, totalTokens, trimmed: cutIndex > 0 };
}

/**
 * Convenience: compute the 90% budget from a context window and trim.
 * Combines {@link computeBudget} + {@link trimSessionEntries}. Pure.
 */
export function trimToWindow(
  entries: ReadonlyArray<SessionEntry>,
  contextWindow: number,
  opts: BudgetOptions & { recentTargetRatio?: number } = {},
): TrimResult {
  const { reserveForOutput, ceilingRatio, recentTargetRatio } = opts;
  const budget = computeBudget(contextWindow, { reserveForOutput, ceilingRatio });
  return trimSessionEntries(entries, { budget, recentTargetRatio });
}

/**
 * Format a trimmed entry list back to JSONL text, preserving the session
 * header. Pure. (Used by the spawn hook to write the fork-input file.)
 */
export function renderTrimmed(
  header: unknown,
  entries: ReadonlyArray<SessionEntry>,
): string {
  const lines: string[] = [];
  if (header) lines.push(JSON.stringify(header));
  for (const e of entries) lines.push(JSON.stringify(e));
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

export {};
