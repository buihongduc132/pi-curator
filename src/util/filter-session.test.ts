/**
 * filter-session.test.ts — co-located unit tests for the non-bias context
 * filter (REQ-LC-02, foundation T2).
 *
 * Tests exercise the pure helpers so behavior is fully unit-testable with no
 * filesystem or pi binary. Each test constructs a minimal JSONL fixture and
 * asserts the filter's output.
 *
 * Test matrix (from task description + REQ-LC-02 scenarios):
 *   - malformed line → skipped, never throws (REQ-LC-10)
 *   - thinking blocks stripped from assistant messages (default)
 *   - compaction entries preserved intact (REQ-LC-02, verifier C5)
 *   - off-branch entries dropped (REQ-LC-02 active-branch only)
 *   - non-context entry types dropped (session_info, model_change, etc.)
 *   - message/custom_message/branch_summary preserved
 *   - includeThinking opt-in keeps thinking blocks
 *   - session header preserved (needed for `pi --fork`)
 *   - empty input → empty output
 */
import { describe, it, expect } from "vitest";
import {
  filterSession,
  parseSession,
  filterEntries,
  computeActiveBranchIds,
  stripThinkingBlocks,
  isContextEntryType,
  resolveLeafId,
  analyzeFilter,
  type SessionEntry,
} from "./filter-session";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal session JSONL from a header + entries. */
function makeJsonl(
  header: Record<string, unknown> | null,
  entries: Record<string, unknown>[],
): string {
  const lines: string[] = [];
  if (header) lines.push(JSON.stringify(header));
  for (const e of entries) lines.push(JSON.stringify(e));
  return lines.join("\n") + "\n";
}

/** Default session header. */
const HEADER = { type: "session", version: 3, id: "ses-uuid", cwd: "/tmp/proj" };

/** Build a `message` entry with a given role and content. */
function msgEntry(
  id: string,
  parentId: string | null,
  role: string,
  content: unknown,
): Record<string, unknown> {
  return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z", message: { role, content } };
}

/** Build a `custom_message` entry. */
function customMsgEntry(id: string, parentId: string | null, customType: string, content: string): Record<string, unknown> {
  return { type: "custom_message", id, parentId, timestamp: "2026-01-01T00:00:00Z", customType, content, display: false };
}

/** Build a `compaction` entry. */
function compactionEntry(id: string, parentId: string | null, summary: string, firstKeptEntryId: string): Record<string, unknown> {
  return { type: "compaction", id, parentId, timestamp: "2026-01-01T00:00:00Z", summary, firstKeptEntryId, tokensBefore: 50000 };
}

/** Build a `branch_summary` entry. */
function branchSummaryEntry(id: string, parentId: string | null, summary: string, fromId: string): Record<string, unknown> {
  return { type: "branch_summary", id, parentId, timestamp: "2026-01-01T00:00:00Z", summary, fromId };
}

// ─── parseSession ───────────────────────────────────────────────────────────

describe("parseSession", () => {
  it("parses header + entries from valid JSONL", () => {
    const input = makeJsonl(HEADER, [
      msgEntry("a1", null, "user", "hello"),
      msgEntry("a2", "a1", "assistant", [{ type: "text", text: "hi" }]),
    ]);
    const parsed = parseSession(input);
    expect(parsed.header).not.toBeNull();
    expect(parsed.header!.type).toBe("session");
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.malformedLines).toBe(0);
  });

  it("skips malformed lines without throwing (REQ-LC-10)", () => {
    const input = [
      JSON.stringify(HEADER),
      "NOT VALID JSON {{{",
      JSON.stringify(msgEntry("a1", null, "user", "hello")),
      "",
      "another bad line",
      JSON.stringify(msgEntry("a2", "a1", "assistant", "hi")),
    ].join("\n");
    const parsed = parseSession(input);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.malformedLines).toBe(2);
    expect(parsed.blankLines).toBe(1);
  });

  it("handles empty input gracefully", () => {
    const parsed = parseSession("");
    expect(parsed.header).toBeNull();
    expect(parsed.entries).toHaveLength(0);
  });

  it("handles all-malformed input", () => {
    const parsed = parseSession("bad1\nbad2\nbad3");
    expect(parsed.header).toBeNull();
    expect(parsed.entries).toHaveLength(0);
    expect(parsed.malformedLines).toBe(3);
  });
});

// ─── isContextEntryType ─────────────────────────────────────────────────────

describe("isContextEntryType (REQ-LC-02 type classification)", () => {
  it("message, custom_message, branch_summary, compaction are context types", () => {
    expect(isContextEntryType("message")).toBe(true);
    expect(isContextEntryType("custom_message")).toBe(true);
    expect(isContextEntryType("branch_summary")).toBe(true);
    expect(isContextEntryType("compaction")).toBe(true);
  });

  it("session_info, model_change, thinking_level_change, label are NOT context types", () => {
    expect(isContextEntryType("session_info")).toBe(false);
    expect(isContextEntryType("model_change")).toBe(false);
    expect(isContextEntryType("thinking_level_change")).toBe(false);
    expect(isContextEntryType("label")).toBe(false);
  });

  it("custom (extension state) is NOT a context type", () => {
    expect(isContextEntryType("custom")).toBe(false);
  });
});

// ─── stripThinkingBlocks ────────────────────────────────────────────────────

describe("stripThinkingBlocks (REQ-LC-02 thinking strip)", () => {
  it("removes thinking blocks from assistant messages", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "let me think..." },
        { type: "text", text: "Here is my answer" },
        { type: "toolCall", id: "c1", name: "bash", arguments: {} },
      ],
    };
    const result = stripThinkingBlocks(msg);
    expect(result.content).toHaveLength(2);
    expect((result.content as unknown[])[0]).toEqual({ type: "text", text: "Here is my answer" });
    expect((result.content as unknown[])[1]).toEqual({ type: "toolCall", id: "c1", name: "bash", arguments: {} });
  });

  it("returns user messages unchanged (no thinking to strip)", () => {
    const msg = { role: "user", content: "hello" };
    expect(stripThinkingBlocks(msg)).toBe(msg);
  });

  it("returns assistant messages with no thinking blocks unchanged (no copy)", () => {
    const msg = { role: "assistant", content: [{ type: "text", text: "hi" }] };
    expect(stripThinkingBlocks(msg)).toBe(msg);
  });

  it("handles assistant message with only thinking blocks (becomes empty content array)", () => {
    const msg = { role: "assistant", content: [{ type: "thinking", thinking: "..." }] };
    const result = stripThinkingBlocks(msg);
    expect(result.content).toEqual([]);
  });

  it("handles string content (no blocks to strip)", () => {
    const msg = { role: "assistant", content: "plain text" };
    expect(stripThinkingBlocks(msg)).toBe(msg);
  });
});

// ─── computeActiveBranchIds ─────────────────────────────────────────────────

describe("computeActiveBranchIds (active-branch walk)", () => {
  it("walks from leaf to root via parentId", () => {
    const entries: SessionEntry[] = [
      { type: "message", id: "e1", parentId: null },
      { type: "message", id: "e2", parentId: "e1" },
      { type: "message", id: "e3", parentId: "e2" },
    ];
    const active = computeActiveBranchIds(entries, "e3");
    expect(active).toEqual(new Set(["e3", "e2", "e1"]));
  });

  it("excludes off-branch entries", () => {
    // Tree:
    //   e1 → e2 → e3 (old branch, abandoned)
    //   e1 → e4 → e5 (active branch)
    const entries: SessionEntry[] = [
      { type: "message", id: "e1", parentId: null },
      { type: "message", id: "e2", parentId: "e1" },
      { type: "message", id: "e3", parentId: "e2" },
      { type: "message", id: "e4", parentId: "e1" },
      { type: "message", id: "e5", parentId: "e4" },
    ];
    const active = computeActiveBranchIds(entries, "e5");
    expect(active).toEqual(new Set(["e5", "e4", "e1"]));
    expect(active.has("e2")).toBe(false);
    expect(active.has("e3")).toBe(false);
  });

  it("handles dangling parentId (tolerant — stops walk)", () => {
    const entries: SessionEntry[] = [
      { type: "message", id: "e1", parentId: null },
      { type: "message", id: "e2", parentId: "MISSING" }, // dangling parent
    ];
    const active = computeActiveBranchIds(entries, "e2");
    expect(active).toEqual(new Set(["e2"])); // stops at dangling parent
  });

  it("handles cycle guard (never infinite loops)", () => {
    const entries: SessionEntry[] = [
      { type: "message", id: "e1", parentId: "e2" }, // cycle
      { type: "message", id: "e2", parentId: "e1" },
    ];
    const active = computeActiveBranchIds(entries, "e1");
    expect(active.size).toBe(2);
  });
});

// ─── resolveLeafId ──────────────────────────────────────────────────────────

describe("resolveLeafId", () => {
  it("returns the id of the last entry", () => {
    const entries: SessionEntry[] = [
      { type: "message", id: "e1" },
      { type: "message", id: "e2" },
    ];
    expect(resolveLeafId(entries)).toBe("e2");
  });

  it("returns null for empty entries", () => {
    expect(resolveLeafId([])).toBeNull();
  });
});

// ─── filterSession (full pipeline) ──────────────────────────────────────────

describe("filterSession (full pipeline, REQ-LC-02)", () => {
  it("preserves session header", () => {
    const input = makeJsonl(HEADER, [
      msgEntry("e1", null, "user", "hello"),
    ]);
    const output = filterSession(input);
    const lines = output.trim().split("\n");
    expect(lines[0]).toBe(JSON.stringify(HEADER));
  });

  it("preserves message entries (user + assistant)", () => {
    const input = makeJsonl(HEADER, [
      msgEntry("e1", null, "user", "hello"),
      msgEntry("e2", "e1", "assistant", [{ type: "text", text: "hi" }]),
    ]);
    const output = filterSession(input);
    const parsed = parseSession(output);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].type).toBe("message");
    expect(parsed.entries[1].type).toBe("message");
  });

  it("preserves custom_message entries", () => {
    const input = makeJsonl(HEADER, [
      msgEntry("e1", null, "user", "hello"),
      customMsgEntry("e2", "e1", "my-ext", "injected context"),
    ]);
    const output = filterSession(input);
    const parsed = parseSession(output);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[1].type).toBe("custom_message");
  });

  it("preserves branch_summary entries", () => {
    const input = makeJsonl(HEADER, [
      msgEntry("e1", null, "user", "hello"),
      branchSummaryEntry("e2", "e1", "Branch explored X", "e1"),
    ]);
    const output = filterSession(input);
    const parsed = parseSession(output);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[1].type).toBe("branch_summary");
  });

  it("PRESERVES compaction entries intact (REQ-LC-02, verifier C5)", () => {
    const input = makeJsonl(HEADER, [
      msgEntry("e1", null, "user", "hello"),
      compactionEntry("e2", "e1", "User discussed X, Y, Z", "e1"),
      msgEntry("e3", "e2", "assistant", [{ type: "text", text: "ok" }]),
    ]);
    const output = filterSession(input);
    const parsed = parseSession(output);
    expect(parsed.entries).toHaveLength(3);
    const compaction = parsed.entries[1];
    expect(compaction.type).toBe("compaction");
    expect(compaction.summary).toBe("User discussed X, Y, Z");
    expect(compaction.firstKeptEntryId).toBe("e1");
  });

  it("drops non-context entry types (session_info, model_change, thinking_level_change, label)", () => {
    const entries = [
      msgEntry("e1", null, "user", "hello"),
      { type: "session_info", id: "e2", parentId: "e1", timestamp: "2026-01-01T00:00:00Z", name: "My Session" },
      { type: "model_change", id: "e3", parentId: "e2", timestamp: "2026-01-01T00:00:00Z", provider: "anthropic", modelId: "sonnet" },
      { type: "thinking_level_change", id: "e4", parentId: "e3", timestamp: "2026-01-01T00:00:00Z", thinkingLevel: "high" },
      { type: "label", id: "e5", parentId: "e4", timestamp: "2026-01-01T00:00:00Z", targetId: "e1", label: "checkpoint" },
      msgEntry("e6", "e5", "assistant", [{ type: "text", text: "hi" }]),
    ];
    const input = makeJsonl(HEADER, entries);
    const output = filterSession(input);
    const parsed = parseSession(output);
    // Only e1 (message) and e6 (message) survive; e2-e5 are non-context types.
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].id).toBe("e1");
    expect(parsed.entries[1].id).toBe("e6");
  });

  it("drops custom (extension state) entries — they never participate in context", () => {
    const entries = [
      msgEntry("e1", null, "user", "hello"),
      { type: "custom", id: "e2", parentId: "e1", timestamp: "2026-01-01T00:00:00Z", customType: "my-ext", data: { count: 42 } },
      msgEntry("e3", "e2", "assistant", [{ type: "text", text: "hi" }]),
    ];
    const input = makeJsonl(HEADER, entries);
    const output = filterSession(input);
    const parsed = parseSession(output);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].id).toBe("e1");
    expect(parsed.entries[1].id).toBe("e3");
  });

  it("STRIPS thinking blocks from assistant messages by default (REQ-LC-02)", () => {
    const input = makeJsonl(HEADER, [
      msgEntry("e1", null, "user", "hello"),
      msgEntry("e2", "e1", "assistant", [
        { type: "thinking", thinking: "let me think deeply..." },
        { type: "text", text: "Here is my answer" },
      ]),
    ]);
    const output = filterSession(input);
    const parsed = parseSession(output);
    const assistantMsg = parsed.entries[1].message as { role: string; content: { type: string }[] };
    expect(assistantMsg.content).toHaveLength(1);
    expect(assistantMsg.content[0].type).toBe("text");
    // No thinking block in output.
    expect(assistantMsg.content.find((b) => b.type === "thinking")).toBeUndefined();
  });

  it("PRESERVES thinking blocks when includeThinking is true (opt-in)", () => {
    const input = makeJsonl(HEADER, [
      msgEntry("e1", null, "user", "hello"),
      msgEntry("e2", "e1", "assistant", [
        { type: "thinking", thinking: "deep reasoning" },
        { type: "text", text: "answer" },
      ]),
    ]);
    const output = filterSession(input, { includeThinking: true });
    const parsed = parseSession(output);
    const assistantMsg = parsed.entries[1].message as { role: string; content: { type: string }[] };
    expect(assistantMsg.content).toHaveLength(2);
    expect(assistantMsg.content[0].type).toBe("thinking");
    expect(assistantMsg.content[1].type).toBe("text");
  });

  it("drops off-branch entries (REQ-LC-02 active-branch only)", () => {
    // Tree:
    //   e1 → e2 → e3 (old branch, abandoned)
    //   e1 → e4 → e5 (active branch — leaf is e5)
    const entries = [
      msgEntry("e1", null, "user", "hello"),
      msgEntry("e2", "e1", "assistant", [{ type: "text", text: "branch A" }]),
      msgEntry("e3", "e2", "user", "follow-up on A"),
      msgEntry("e4", "e1", "assistant", [{ type: "text", text: "branch B" }]),
      msgEntry("e5", "e4", "user", "follow-up on B"),
    ];
    const input = makeJsonl(HEADER, entries);
    const output = filterSession(input);
    const parsed = parseSession(output);
    // Active branch: e5 → e4 → e1. Off-branch: e2, e3.
    const ids = parsed.entries.map((e) => e.id);
    expect(ids).toEqual(["e1", "e4", "e5"]);
    expect(ids).not.toContain("e2");
    expect(ids).not.toContain("e3");
  });

  it("handles malformed lines in the middle of the session", () => {
    const lines = [
      JSON.stringify(HEADER),
      JSON.stringify(msgEntry("e1", null, "user", "hello")),
      "THIS IS NOT JSON",
      JSON.stringify(msgEntry("e2", "e1", "assistant", [{ type: "text", text: "hi" }])),
    ];
    const output = filterSession(lines.join("\n"));
    const parsed = parseSession(output);
    // e1 and e2 survive; malformed line skipped.
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].id).toBe("e1");
    expect(parsed.entries[1].id).toBe("e2");
  });

  it("handles empty input", () => {
    expect(filterSession("")).toBe("");
  });

  it("handles header-only input", () => {
    const output = filterSession(JSON.stringify(HEADER) + "\n");
    const parsed = parseSession(output);
    expect(parsed.header).not.toBeNull();
    expect(parsed.entries).toHaveLength(0);
  });

  it("uses explicit leafId when provided", () => {
    // Tree: e1 → e2 → e3. If leafId=e2, only e1 and e2 are active.
    const entries = [
      msgEntry("e1", null, "user", "hello"),
      msgEntry("e2", "e1", "assistant", [{ type: "text", text: "hi" }]),
      msgEntry("e3", "e2", "user", "follow-up"),
    ];
    const input = makeJsonl(HEADER, entries);
    const output = filterSession(input, { leafId: "e2" });
    const parsed = parseSession(output);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries.map((e) => e.id)).toEqual(["e1", "e2"]);
  });
});

// ─── analyzeFilter ──────────────────────────────────────────────────────────

describe("analyzeFilter (diagnostics)", () => {
  it("counts off-branch, non-context, and thinking-stripped entries", () => {
    const entries: SessionEntry[] = [
      { type: "message", id: "e1", parentId: null, message: { role: "user", content: "hi" } },
      { type: "session_info", id: "e2", parentId: "e1" },
      { type: "message", id: "e3", parentId: "e1", message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "y" }] } },
      { type: "message", id: "e4", parentId: "e3", message: { role: "user", content: "off-branch" } },
    ];
    // Leaf = e3 (last entry with id). e4 is off-branch (parent of e3, but e4 is after e3 in file — wait, no.
    // Actually: e4.parentId = "e3", so e4 is a child of e3. Leaf = last entry = e4.
    // Active branch: e4 → e3 → e1. e2 is on-branch (parent of e1? no, e2.parentId = e1).
    // Wait: e2.parentId = "e1", so e2 is a child of e1. Leaf = e4. Active: e4→e3→e1. e2 is NOT on active branch.
    // Hmm, but e2.parentId = e1 and e3.parentId = e1 too. So e2 and e3 are siblings.
    // Active branch from e4: e4 → e3 → e1. e2 is off-branch.
    const stats = analyzeFilter(entries);
    expect(stats.total).toBe(4);
    expect(stats.kept).toBe(3); // e1, e3, e4
    expect(stats.offBranch).toBe(1); // e2 (off-branch)
    expect(stats.nonContext).toBe(0); // session_info e2 is off-branch, counted there first
    expect(stats.thinkingStripped).toBe(1); // e3 has thinking stripped
  });
});

// ─── filterEntries (direct, no header) ──────────────────────────────────────

describe("filterEntries (pure, no header)", () => {
  it("returns empty for empty entries", () => {
    expect(filterEntries([])).toEqual([]);
  });

  it("preserves toolResult messages (they are `message` type entries)", () => {
    const entries: SessionEntry[] = [
      { type: "message", id: "e1", parentId: null, message: { role: "user", content: "do it" } },
      { type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }] } },
      { type: "message", id: "e3", parentId: "e2", message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "file.txt" }], isError: false } },
    ];
    const kept = filterEntries(entries);
    expect(kept).toHaveLength(3);
    expect(kept[2].id).toBe("e3");
    expect((kept[2].message as { role: string }).role).toBe("toolResult");
  });
});
