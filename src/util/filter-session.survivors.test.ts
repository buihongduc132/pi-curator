/**
 * filter-session.survivors.test.ts — kills surviving mutants in
 * src/util/filter-session.ts:
 *   - stripThinkingBlocks: assert thinking blocks are actually removed (a
 *     `filter => true` mutant would keep them).
 *   - transformEntry: a message entry with a non-object `message` field must
 *     pass through unchanged (a guard-removal mutant would throw).
 *   - renderSession: non-empty rendering + exact format (a StringLiteral mutant
 *     would collapse output to "").
 */
import { describe, it, expect } from "vitest";
import { stripThinkingBlocks, transformEntry, renderSession, analyzeFilter } from "./filter-session.js";

describe("stripThinkingBlocks — actually removes thinking", () => {
  it("removes thinking blocks from an assistant message", () => {
    const out = stripThinkingBlocks({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "SECRET" },
        { type: "text", text: "answer" },
      ],
    } as any);
    expect((out.content as any[]).some((b) => b.type === "thinking")).toBe(false);
    expect((out.content as any[]).some((b) => b.type === "text")).toBe(true);
  });

  it("returns the original message unchanged when no thinking blocks are present", () => {
    const msg = { role: "assistant", content: [{ type: "text", text: "x" }] } as any;
    expect(stripThinkingBlocks(msg)).toBe(msg);
  });

  it("returns non-assistant messages unchanged", () => {
    const msg = { role: "user", content: [{ type: "thinking", thinking: "x" }] } as any;
    // user messages are never stripped.
    expect(stripThinkingBlocks(msg)).toBe(msg);
  });
});

describe("transformEntry — message-field guard", () => {
  it("passes through a message entry whose `message` field is undefined", () => {
    const entry = { type: "message", id: "e1", parentId: null } as any;
    // A guard-removal mutant would call stripThinkingBlocks(undefined) and throw.
    const out = transformEntry(entry);
    expect(out).toBe(entry);
  });

  it("passes through a message entry whose `message` field is a non-object", () => {
    const entry = { type: "message", id: "e1", parentId: null, message: "nope" } as any;
    expect(transformEntry(entry)).toBe(entry);
  });

  it("strips thinking from a well-formed assistant message entry (includeThinking false)", () => {
    const entry = {
      type: "message",
      id: "e1",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "X" }, { type: "text", text: "y" }],
      },
    } as any;
    const out = transformEntry(entry) as any;
    expect(out.message.content.some((b: any) => b.type === "thinking")).toBe(false);
  });

  it("keeps thinking when includeThinking is true", () => {
    const entry = {
      type: "message",
      id: "e1",
      parentId: null,
      message: { role: "assistant", content: [{ type: "thinking", thinking: "X" }] },
    } as any;
    expect(transformEntry(entry, { includeThinking: true })).toBe(entry);
  });
});

describe("renderSession — non-empty exact format", () => {
  it("renders header + entries joined by newlines with a trailing newline", () => {
    const header = { type: "session", id: "s", version: 1 } as any;
    const entries = [{ type: "message", id: "e1" }, { type: "message", id: "e2" }] as any;
    const out = renderSession(header, entries);
    expect(out).toBe(
      JSON.stringify(header) + "\n" + JSON.stringify(entries[0]) + "\n" + JSON.stringify(entries[1]) + "\n",
    );
  });

  it("renders entries only (no header) with a trailing newline", () => {
    const entries = [{ type: "message", id: "e1" }] as any;
    expect(renderSession(null, entries)).toBe(JSON.stringify(entries[0]) + "\n");
  });

  it("renders empty string when there is no header and no entries", () => {
    expect(renderSession(null, [])).toBe("");
  });
});

describe("analyzeFilter — thinkingStripped tally (assistant only)", () => {
  it("counts only assistant thinking blocks, not user-side thinking", () => {
    // A user message carrying a thinking block must NOT be counted; an assistant
    // message carrying a thinking block MUST be counted. Distinguishes the
    // `role === "assistant"` guard (L358) and the thinking filter (L364).
    const entries = [
      {
        type: "message",
        id: "u1",
        parentId: null,
        message: { role: "user", content: [{ type: "thinking", thinking: "u" }, { type: "text", text: "q" }] },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        message: { role: "assistant", content: [{ type: "thinking", thinking: "a" }, { type: "text", text: "r" }] },
      },
    ] as any;
    const stats = analyzeFilter(entries, { leafId: "a1" });
    expect(stats.thinkingStripped).toBe(1); // assistant only
    expect(stats.kept).toBe(2);
  });

  it("counts 0 thinking stripped when includeThinking is true", () => {
    const entries = [
      {
        type: "message",
        id: "a1",
        parentId: null,
        message: { role: "assistant", content: [{ type: "thinking", thinking: "a" }] },
      },
    ] as any;
    expect(analyzeFilter(entries, { leafId: "a1", includeThinking: true }).thinkingStripped).toBe(0);
  });
});
