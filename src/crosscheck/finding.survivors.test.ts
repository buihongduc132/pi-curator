/**
 * finding.survivors.test.ts — kills surviving mutants in src/crosscheck/finding.ts.
 *
 * Survivors:
 *  - id 204 (`typeof raw.curator === "string" ? ...trim() : ""` → `true`): KILL —
 *    a numeric curator would throw `.trim()` under the mutant.
 *  - id 230 (`if (!raw || typeof raw !== "object") return null` → `false`): KILL —
 *    null/string input would dereference under the mutant.
 *
 * EQUIVALENT:
 *  - id 237 (`if (r.type === "agreement") return normalizeAgreement(r)` → `true`):
 *    only reached when `r.type !== "finding"`; for any non-"agreement" type
 *    normalizeAgreement returns null (its own type guard), identical to the
 *    fall-through `return null`.
 *  - id 252/255 (parseEntry `line.trim()` / `if (!trimmed) return null`):
 *    `JSON.parse` itself tolerates surrounding whitespace and throws on empty
 *    input (caught → null), so trimming + the empty-guard produce identical
 *    results for every input.
 */
import { describe, it, expect } from "vitest";
import { normalizeFinding, normalizeEntry, parseEntry } from "./finding.js";

describe("finding survivors", () => {
  it("normalizeFinding: numeric curator → null, not throw (kills typeof→true mutant)", () => {
    expect(() =>
      normalizeFinding({ type: "finding", topic: "x", curator: 123, severity: "info" } as never),
    ).not.toThrow();
    expect(
      normalizeFinding({ type: "finding", topic: "x", curator: 123, severity: "info" } as never),
    ).toBeNull();
  });

  it("normalizeEntry: null/non-object input → null, not throw (kills guard mutant)", () => {
    expect(() => normalizeEntry(null)).not.toThrow();
    expect(normalizeEntry(null)).toBeNull();
    expect(normalizeEntry(undefined)).toBeNull();
    expect(normalizeEntry("not-an-object")).toBeNull();
    expect(normalizeEntry(42)).toBeNull();
  });

  it("parseEntry: blank/whitespace-only lines → null (documents trim equivalents)", () => {
    expect(parseEntry("")).toBeNull();
    expect(parseEntry("   ")).toBeNull();
    expect(parseEntry("\t\n")).toBeNull();
  });

  it("parseEntry: padded valid JSON parses fine (documents trim equivalent)", () => {
    const e = parseEntry('   {"type":"finding","topic":"x","curator":"c","ts":"t","severity":"info","summary":"s"}   ');
    expect(e).not.toBeNull();
    expect(e!.type).toBe("finding");
  });
});
