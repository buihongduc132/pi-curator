/**
 * trim-session.test.ts — co-located unit tests for context trim (REQ-LC-03,
 * foundation T2).
 *
 * Test matrix (from task description + REQ-LC-03 scenarios):
 *   - estimateTokens matches pi core chars/4 heuristic
 *   - budget boundary (exact fit, just over, just under)
 *   - toolResult NEVER a cut point (turn atomicity)
 *   - includeThinking opt-in affects token estimation
 *   - whole session fits → no trim
 *   - recency preference (oldest dropped first)
 *   - single oversized turn (best-effort keep)
 *   - compaction preserved when in kept range
 *   - computeBudget 90% ceiling
 */
import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  estimateEntryTokens,
  estimateContentChars,
  isValidCutPoint,
  findValidCutPoints,
  computeBudget,
  trimSessionEntries,
  trimToWindow,
  type TrimResult,
} from "./trim-session";
import type { SessionEntry } from "./filter-session";

// ─── Helpers ────────────────────────────────────────────────────────────────

function entry(
  id: string,
  type: string,
  message: Record<string, unknown> | null,
): SessionEntry {
  const e: SessionEntry & Record<string, unknown> = { type, id };
  if (message) e.message = message;
  return e;
}

/** A user message entry with a text string of the given char length. */
function userEntry(id: string, text: string): SessionEntry {
  return entry(id, "message", { role: "user", content: text });
}

/** An assistant entry with text content blocks of given char lengths. */
function assistantEntry(id: string, texts: string[]): SessionEntry {
  return entry(id, "message", {
    role: "assistant",
    content: texts.map((t) => ({ type: "text", text: t })),
  });
}

/** A toolResult entry (content text). */
function toolResultEntry(id: string, text: string): SessionEntry {
  return entry(id, "message", {
    role: "toolResult",
    toolCallId: "tc1",
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
  });
}

// ─── estimateContentChars ───────────────────────────────────────────────────

describe("estimateContentChars", () => {
  it("counts string content by length", () => {
    expect(estimateContentChars("hello world")).toBe(11);
  });

  it("sums text block lengths", () => {
    expect(estimateContentChars([{ type: "text", text: "abc" }, { type: "text", text: "de" }])).toBe(5);
  });

  it("counts image blocks as ~4800 chars", () => {
    expect(estimateContentChars([{ type: "image", data: "x", mimeType: "image/png" }])).toBe(4800);
  });

  it("returns 0 for non-array non-string content", () => {
    expect(estimateContentChars(undefined)).toBe(0);
    expect(estimateContentChars(42)).toBe(0);
  });
});

// ─── estimateTokens (matches pi core chars/4) ───────────────────────────────

describe("estimateTokens (pi core chars/4 heuristic)", () => {
  it("user message: string content / 4, ceil", () => {
    // 8 chars → 2 tokens
    expect(estimateTokens({ role: "user", content: "12345678" })).toBe(2);
    // 9 chars → 3 tokens (ceil)
    expect(estimateTokens({ role: "user", content: "123456789" })).toBe(3);
  });

  it("assistant message: text block / 4", () => {
    // 8 chars → 2 tokens
    expect(estimateTokens({ role: "assistant", content: [{ type: "text", text: "12345678" }] })).toBe(2);
  });

  it("assistant message: thinking block counted (chars/4)", () => {
    // 8 chars of thinking → 2 tokens
    expect(estimateTokens({ role: "assistant", content: [{ type: "thinking", thinking: "12345678" }] })).toBe(2);
  });

  it("assistant message: toolCall counts name + JSON args", () => {
    const msg = {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls -la" } }],
    };
    // name "bash" = 4 chars, args JSON = {"command":"ls -la"} = 21 chars → 25 → ceil(25/4) = 7
    const expected = Math.ceil((4 + JSON.stringify({ command: "ls -la" }).length) / 4);
    expect(estimateTokens(msg)).toBe(expected);
  });

  it("toolResult: content chars / 4", () => {
    expect(estimateTokens({ role: "toolResult", content: [{ type: "text", text: "12345678" }] })).toBe(2);
  });

  it("bashExecution: (command + output) / 4", () => {
    const msg = { role: "bashExecution", command: "ls", output: "file.txt" };
    // "ls" (2) + "file.txt" (8) = 10 → ceil(10/4) = 3
    expect(estimateTokens(msg as Record<string, unknown> as never)).toBe(3);
  });

  it("branchSummary / compactionSummary: summary / 4", () => {
    expect(estimateTokens({ role: "branchSummary", summary: "12345678" })).toBe(2);
    expect(estimateTokens({ role: "compactionSummary", summary: "12345678" })).toBe(2);
  });

  it("unknown role → 0 tokens", () => {
    expect(estimateTokens({ role: "mystery", content: "12345678" })).toBe(0);
  });
});

// ─── includeThinking opt-in affects token estimation ────────────────────────

describe("includeThinking opt-in affects token estimation", () => {
  it("an assistant message WITH thinking has more tokens than without", () => {
    const withThinking = estimateTokens({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "x".repeat(400) },
        { type: "text", text: "answer" },
      ],
    });
    const withoutThinking = estimateTokens({
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
    });
    expect(withThinking).toBeGreaterThan(withoutThinking);
    // 400 chars of thinking = 100 extra tokens
    expect(withThinking - withoutThinking).toBe(100);
  });

  it("trim budget reflects thinking tokens: a session that fits without thinking may exceed with it", () => {
    // Without thinking: 1 assistant text (8 chars=2 tok) + 1 user (8 chars=2 tok) = 4 tokens.
    // With thinking: adds 400 chars = 100 tokens → 104 tokens.
    const entriesWithThinking: SessionEntry[] = [
      userEntry("u1", "12345678"),
      entry("a1", "message", {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "x".repeat(400) },
          { type: "text", text: "12345678" },
        ],
      }),
    ];
    // budget = 50: without thinking (4 tok) fits; with thinking (104 tok) the
    // assistant entry alone (102 tok) exceeds → oversized-turn best-effort keeps
    // from the assistant (last valid cut point).
    const result = trimSessionEntries(entriesWithThinking, { budget: 50 });
    expect(result.totalTokens).toBe(104);
    // The user entry (2 tok) + assistant (102 tok) = 104 > 50. Walking cut
    // points: u1 (suffix 104 > 50), a1 (suffix 102 > 50). None fits → best
    // effort keeps from last cut point (a1).
    expect(result.cutIndex).toBe(1);
    expect(result.entries.map((e) => e.id)).toEqual(["a1"]);
  });
});

// ─── estimateEntryTokens ────────────────────────────────────────────────────

describe("estimateEntryTokens", () => {
  it("estimates a message entry's tokens", () => {
    expect(estimateEntryTokens(userEntry("u1", "12345678"))).toBe(2);
  });

  it("estimates a custom_message entry as a custom-role message", () => {
    const e: SessionEntry = { type: "custom_message", id: "c1", content: "12345678" };
    expect(estimateEntryTokens(e)).toBe(2);
  });

  it("estimates a branch_summary entry", () => {
    const e: SessionEntry = { type: "branch_summary", id: "b1", summary: "12345678" };
    expect(estimateEntryTokens(e)).toBe(2);
  });

  it("estimates a compaction entry", () => {
    const e: SessionEntry = { type: "compaction", id: "k1", summary: "12345678" };
    expect(estimateEntryTokens(e)).toBe(2);
  });

  it("returns 0 for non-context entries", () => {
    expect(estimateEntryTokens({ type: "session_info", id: "s1" })).toBe(0);
    expect(estimateEntryTokens({ type: "label", id: "l1" })).toBe(0);
  });
});

// ─── isValidCutPoint / findValidCutPoints ───────────────────────────────────

describe("isValidCutPoint (REQ-LC-03)", () => {
  it("user/assistant/bashExecution/custom/branchSummary/compactionSummary are valid", () => {
    expect(isValidCutPoint(entry("u", "message", { role: "user", content: "x" }))).toBe(true);
    expect(isValidCutPoint(entry("a", "message", { role: "assistant", content: [] }))).toBe(true);
    expect(isValidCutPoint(entry("b", "message", { role: "bashExecution", command: "x", output: "y" }))).toBe(true);
    expect(isValidCutPoint(entry("c", "message", { role: "custom", content: "x" }))).toBe(true);
    expect(isValidCutPoint(entry("bs", "message", { role: "branchSummary", summary: "x" }))).toBe(true);
    expect(isValidCutPoint(entry("cs", "message", { role: "compactionSummary", summary: "x" }))).toBe(true);
  });

  it("custom_message and branch_summary entries are valid cut points", () => {
    expect(isValidCutPoint({ type: "custom_message", id: "c1", content: "x" })).toBe(true);
    expect(isValidCutPoint({ type: "branch_summary", id: "b1", summary: "x" })).toBe(true);
  });

  it("toolResult is NEVER a valid cut point (REQ-LC-03)", () => {
    expect(isValidCutPoint(toolResultEntry("t1", "output"))).toBe(false);
  });

  it("compaction entries are NOT cut points (kept in range only)", () => {
    expect(isValidCutPoint({ type: "compaction", id: "k1", summary: "x" })).toBe(false);
  });

  it("non-context entries are not cut points", () => {
    expect(isValidCutPoint({ type: "session_info", id: "s1" })).toBe(false);
    expect(isValidCutPoint({ type: "label", id: "l1" })).toBe(false);
    expect(isValidCutPoint({ type: "model_change", id: "m1" })).toBe(false);
  });
});

describe("findValidCutPoints", () => {
  it("returns indices of valid cut points in range", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", "hi"),           // 0: valid
      assistantEntry("a1", ["hi"]),    // 1: valid
      toolResultEntry("t1", "output"), // 2: NOT valid
      userEntry("u2", "bye"),          // 3: valid
    ];
    expect(findValidCutPoints(entries)).toEqual([0, 1, 3]);
  });
});

// ─── computeBudget (90% ceiling) ────────────────────────────────────────────

describe("computeBudget (REQ-LC-03 90% ceiling)", () => {
  it("returns floor(window * 0.9) - reserveForOutput", () => {
    // 200000 window → 180000 - 8192 = 171808
    expect(computeBudget(200000)).toBe(171808);
  });

  it("honors custom reserveForOutput", () => {
    expect(computeBudget(200000, { reserveForOutput: 0 })).toBe(180000);
  });

  it("honors custom ceilingRatio", () => {
    expect(computeBudget(100000, { ceilingRatio: 0.6, reserveForOutput: 0 })).toBe(60000);
  });

  it("clamps to 0 for tiny windows", () => {
    expect(computeBudget(1000)).toBe(0);
  });
});

// ─── trimSessionEntries (core algorithm) ────────────────────────────────────

describe("trimSessionEntries (REQ-LC-03 core algorithm)", () => {
  it("keeps everything when the whole session fits in budget", () => {
    const entries = [userEntry("u1", "1234"), assistantEntry("a1", ["1234"])];
    // 1 + 1 = 2 tokens; budget 100.
    const result = trimSessionEntries(entries, { budget: 100 });
    expect(result.trimmed).toBe(false);
    expect(result.cutIndex).toBe(0);
    expect(result.entries.map((e) => e.id)).toEqual(["u1", "a1"]);
    expect(result.keptTokens).toBe(2);
  });

  it("trims oldest entries first when over budget (recency preference)", () => {
    // 4 user messages, 40 chars each = 10 tokens each = 40 total.
    const entries = [
      userEntry("u1", "x".repeat(40)),
      userEntry("u2", "x".repeat(40)),
      userEntry("u3", "x".repeat(40)),
      userEntry("u4", "x".repeat(40)),
    ];
    // budget 25: keep u3+u4 (20 tok). u2+u3+u4 = 30 > 25.
    const result = trimSessionEntries(entries, { budget: 25 });
    expect(result.trimmed).toBe(true);
    expect(result.cutIndex).toBe(2);
    expect(result.entries.map((e) => e.id)).toEqual(["u3", "u4"]);
    expect(result.keptTokens).toBe(20);
    expect(result.totalTokens).toBe(40);
  });

  it("budget boundary: exact fit keeps the suffix that exactly equals budget", () => {
    // 3 user messages, 40 chars = 10 tokens each.
    const entries = [
      userEntry("u1", "x".repeat(40)),
      userEntry("u2", "x".repeat(40)),
      userEntry("u3", "x".repeat(40)),
    ];
    // budget exactly 20 → keep u2+u3 (20 tok). u1+u2+u3 = 30 > 20.
    const result = trimSessionEntries(entries, { budget: 20 });
    expect(result.keptTokens).toBe(20);
    expect(result.cutIndex).toBe(1);
    expect(result.entries.map((e) => e.id)).toEqual(["u2", "u3"]);
  });

  it("budget boundary: just under keeps more; just over trims more", () => {
    const entries = [
      userEntry("u1", "x".repeat(40)), // 10 tok
      userEntry("u2", "x".repeat(40)), // 10 tok
      userEntry("u3", "x".repeat(40)), // 10 tok
    ];
    // budget 21: u2+u3 = 20 ≤ 21 → keep u2,u3 (earliest cut ≤ budget).
    expect(trimSessionEntries(entries, { budget: 21 }).entries.map((e) => e.id)).toEqual(["u2", "u3"]);
    // budget 19: u2+u3 = 20 > 19; u3 alone = 10 ≤ 19 → keep u3.
    expect(trimSessionEntries(entries, { budget: 19 }).entries.map((e) => e.id)).toEqual(["u3"]);
  });

  it("NEVER cuts at a toolResult — keeps it attached to its tool call", () => {
    // assistant(toolCall) → toolResult → user. If budget forces a cut that
    // would land on the toolResult, the cut moves to the user (forward),
    // NEVER orphaning the toolResult from its tool call.
    const entries: SessionEntry[] = [
      assistantEntry("a1", ["call"]),               // small
      entry("a1b", "message", {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "x" } }],
      }),
      toolResultEntry("t1", "x".repeat(400)),       // 100 tokens — big
      userEntry("u1", "x".repeat(40)),              // 10 tokens
    ];
    // budget small enough that keeping from t1 would exceed, but t1 is not a
    // valid cut point anyway → cut must land on u1 (the next valid point).
    const result = trimSessionEntries(entries, { budget: 15 });
    // The cut never lands on t1 (index 2). It lands on u1 (index 3).
    expect(result.cutIndex).not.toBe(2);
    expect(result.entries[0].id).toBe("u1");
  });

  it("toolResult at the start of kept range is impossible — cut skips it", () => {
    // Sequence: user(big) → assistant → toolResult → user(small)
    // Budget only fits the last user. The toolResult must NOT become the first
    // kept entry.
    const entries: SessionEntry[] = [
      userEntry("u1", "x".repeat(400)),  // 100 tokens
      assistantEntry("a1", ["x"]),         // 1 token
      toolResultEntry("t1", "x".repeat(8)), // 2 tokens
      userEntry("u2", "x".repeat(8)),     // 2 tokens
    ];
    const result = trimSessionEntries(entries, { budget: 5 });
    // First kept entry is a valid cut point (user), never the toolResult.
    const firstKept = result.entries[0];
    expect(isValidCutPoint(firstKept)).toBe(true);
    expect((firstKept.message as { role: string }).role).not.toBe("toolResult");
  });

  it("single oversized turn: keeps from last valid cut point (best effort)", () => {
    // One huge user message that alone exceeds budget.
    const entries = [userEntry("u1", "x".repeat(4000))]; // 1000 tokens
    const result = trimSessionEntries(entries, { budget: 100 });
    expect(result.totalTokens).toBe(1000);
    // Best effort: keep from the last (only) valid cut point — can't split.
    expect(result.cutIndex).toBe(0);
    expect(result.entries).toHaveLength(1);
  });

  it("preserves compaction entries that fall within the kept range", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", "x".repeat(40)),                          // 10 tok
      { type: "compaction", id: "k1", summary: "x".repeat(40) }, // 10 tok (not a cut point)
      userEntry("u2", "x".repeat(40)),                          // 10 tok
      userEntry("u3", "x".repeat(40)),                          // 10 tok
    ];
    // budget 25: keep from u2 (u2+u3 = 20 ≤ 25; k1 is between u1 and u2 so it's
    // NOT in the kept suffix). Hmm — k1 is at index 1, u2 at index 2. Suffix
    // from u2 (index 2) = u2+u3 = 20. k1 is excluded. Let's instead make budget
    // large enough to include k1.
    const resultBig = trimSessionEntries(entries, { budget: 35 });
    // u1 is a cut point, suffix from u1 = 40 > 35. k1 is NOT a cut point.
    // u2 is a cut point, suffix from u2 = 20 ≤ 35. But can we include k1?
    // k1 is index 1, not a valid cut point, so cut can't land there.
    // The earliest valid cut with suffix ≤ 35: u2 (20). k1 stays excluded
    // because we can't cut at a non-cut-point. This is correct: compaction is
    // preserved ONLY if a valid cut point at/before it keeps it.
    expect(resultBig.cutIndex).toBe(2);
    // Now test that compaction IS preserved when the cut lands before it.
    const entriesWithCompactionLast: SessionEntry[] = [
      userEntry("u1", "x".repeat(40)),
      { type: "compaction", id: "k1", summary: "summary text" },
      userEntry("u2", "x".repeat(40)),
    ];
    // budget huge → keep all, compaction preserved.
    const keepAll = trimSessionEntries(entriesWithCompactionLast, { budget: 1000 });
    expect(keepAll.entries.find((e) => e.type === "compaction")).toBeDefined();
  });

  it("handles empty entries", () => {
    const result = trimSessionEntries([], { budget: 100 });
    expect(result.entries).toEqual([]);
    expect(result.trimmed).toBe(false);
    expect(result.totalTokens).toBe(0);
  });

  it("handles zero budget", () => {
    const entries = [userEntry("u1", "1234")];
    const result = trimSessionEntries(entries, { budget: 0 });
    // Single entry, best effort keeps from last valid cut point.
    expect(result.entries).toHaveLength(1);
  });

  it("returns entries in original chronological order", () => {
    const entries = [
      userEntry("u1", "x".repeat(40)),
      userEntry("u2", "x".repeat(40)),
      userEntry("u3", "x".repeat(40)),
    ];
    const result = trimSessionEntries(entries, { budget: 15 });
    expect(result.entries.map((e) => e.id)).toEqual(["u3"]); // newest kept, in order
  });
});

// ─── trimToWindow (convenience) ─────────────────────────────────────────────

describe("trimToWindow (90% budget convenience)", () => {
  it("computes 90% budget and trims", () => {
    // window 100000 → budget floor(90000) - 8192 = 81808
    const entries = [
      userEntry("u1", "x".repeat(400000)), // 100000 tokens — exceeds budget
      userEntry("u2", "x".repeat(40)),       // 10 tokens
    ];
    const result = trimToWindow(entries, 100000);
    expect(result.totalTokens).toBe(100010);
    // u1 alone (100000) > 81808; u2 (10) fits. Best effort keeps from u2.
    expect(result.cutIndex).toBe(1);
  });
});
