/**
 * trim-session.survivors.test.ts — kills surviving mutants in src/util/trim-session.ts.
 *
 * Killable:
 *  - id 3053/3088 (estimateContentChars/estimateTokens `typeof block!==object || null` → false):
 *    a `null` content block must be skipped (mutant dereferences null.type → throws).
 *  - id 3143 (getMessageFromEntry default): an unknown entry type must return null
 *    (a no-default mutant returns undefined).
 *  - id 3178/3179 (isValidCutPoint role guard): a toolResult message must NOT be a
 *    valid cut point (mutant returns true).
 *  - id 3212/3213/3215 (trimSessionEntries `totalTokens <= budget` early-return):
 *    a session that fits budget but starts with a non-cut-point entry must keep
 *    ALL entries (cutIndex 0); the mutants fall into the general path and drop
 *    the leading non-cut entry.
 *
 * EQUIVALENT:
 *  - id 3180 (`typeof role === "string"` → true) and id 3183 (`role !== "toolResult"` → true):
 *    VALID_CUT_ROLES already excludes "toolResult" and every non-string role, so
 *    mutating either sub-condition cannot change the final `.has(role)` result.
 */
import { describe, it, expect } from "vitest";
import {
  estimateContentChars,
  estimateTokens,
  getMessageFromEntry,
  isValidCutPoint,
  trimSessionEntries,
} from "./trim-session.js";

describe("trim-session survivors", () => {
  it("estimateContentChars skips a null block without throwing (kills guard→false mutant)", () => {
    expect(() => estimateContentChars([null])).not.toThrow();
    expect(estimateContentChars([null])).toBe(0);
  });

  it("estimateTokens (assistant) skips a null block without throwing (kills guard→false mutant)", () => {
    expect(() =>
      estimateTokens({ role: "assistant", content: [null, { type: "text", text: "hi" }] }),
    ).not.toThrow();
    expect(estimateTokens({ role: "assistant", content: [null, { type: "text", text: "hi" }] })).toBe(
      Math.ceil(2 / 4),
    );
  });

  it("getMessageFromEntry: unknown entry type → null (kills default-case mutant)", () => {
    expect(getMessageFromEntry({ type: "session_info" } as never)).toBeNull();
    expect(getMessageFromEntry({ type: "model_change" } as never)).toBeNull();
  });

  it("isValidCutPoint: toolResult message is NOT a cut point (kills role-guard mutants)", () => {
    expect(isValidCutPoint({ type: "message", message: { role: "toolResult" } } as never)).toBe(
      false,
    );
  });

  it("isValidCutPoint: unknown role is NOT a cut point (covers the .has guard)", () => {
    expect(isValidCutPoint({ type: "message", message: { role: "weird" } } as never)).toBe(false);
  });

  it("trimSessionEntries: a fitting session whose first entry is a non-cut-point keeps EVERYTHING (kills <=budget mutants)", () => {
    // toolResult message is NOT a valid cut point; user message is.
    // totalTokens (both) fits a large budget. Original: cutIndex 0, both kept.
    // Mutant (drop the fits-early-return, or `<=`→`<` at equality): finds cutPoint
    // at index 1 (the user msg) and drops the leading toolResult.
    const entries = [
      { type: "message", id: "a", message: { role: "toolResult", content: "x".repeat(40) } },
      { type: "message", id: "b", message: { role: "user", content: "y".repeat(40) } },
    ] as never;
    // Budget exactly equal to total tokens (kills `<=`→`<` too).
    const total = entries.reduce((s, e) => s + estimateTokens((e as never).message), 0);
    const res = trimSessionEntries(entries, { budget: total });
    expect(res.cutIndex).toBe(0);
    expect(res.entries).toHaveLength(2);
    expect(res.trimmed).toBe(false);
  });
});
