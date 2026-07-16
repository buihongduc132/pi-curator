/**
 * config.survivors2.test.ts — exercises the surviving mutants in
 * src/util/config.ts (stripJsonc comment-skip, deepMerge `key in result`,
 * resolveMergedConfig projectRoot/scope). All 7 are genuinely EQUIVALENT;
 * these tests pin the documented behavior so any future regression is caught.
 *
 * Equivalent justifications:
 *  - id 2021/2041 (`i += 2` → `i -= 2` in line/block comment skip): after the
 *    skip, the following `while (... !== "\n" | closing)` resyncs the cursor to
 *    the exact same terminator regardless of starting ±2, and NO characters are
 *    appended during the skip — so output is byte-identical.
 *  - id 2025/2045 (`while (i < len ...)` → `i <= len`): one extra no-op read of
 *    `input[len]` (undefined) that satisfies/short-circuits the inner condition
 *    without appending; the outer `while (i < len)` terminates identically.
 *  - id 2094 (`if (key in result)` → true): the else branch `result[key] = val`
 *    and `deepMerge(undefined, val)` both reduce to `val`, and for present keys
 *    both merge — identical output.
 *  - id 2234 (`projectRoot ?? ""` → `projectRoot && ""`): `projectRoot` is
 *    assigned but never read again inside resolveMergedConfig (dead local).
 *  - id 2246 (`if (persona.scope === "all-sessions")` → true): for non-all-sessions
 *    personas the rewrite `{...persona, scope:"main-only"}` is content-equal to
 *    the already-main-only persona, so no observable difference.
 */
import { describe, it, expect } from "vitest";
import { stripJsonc, parseJsonc, deepMerge, resolveMergedConfig } from "./config.js";

describe("config survivors — behavior pins (all equivalent)", () => {
  it("stripJsonc: line comment at start", () => {
    expect(parseJsonc("// header\n{\"a\":1}")).toEqual({ a: 1 });
  });

  it("stripJsonc: line comment mid-content", () => {
    expect(parseJsonc("{\n  \"a\": 1 // hello\n}")).toEqual({ a: 1 });
  });

  it("stripJsonc: block comment mid-content", () => {
    expect(parseJsonc("{\"a\":/* c */1}")).toEqual({ a: 1 });
  });

  it("stripJsonc: block comment unclosed at EOF still terminates", () => {
    // The `i += 2` past EOF path: both original and mutant exit cleanly.
    expect(parseJsonc("{\"a\":1}/* never closed").a).toBe(1);
  });

  it("stripJsonc: strings containing comment-like text are preserved", () => {
    expect(parseJsonc('{"url":"http://x/y"}').url).toBe("http://x/y");
  });

  it("deepMerge: new keys replace, shared keys merge", () => {
    const merged = deepMerge<{ a?: { x?: number; y?: number }; b?: number }>(
      { a: { x: 1 }, b: 2 },
      { a: { y: 3 } },
    );
    expect(merged).toEqual({ a: { x: 1, y: 3 }, b: 2 });
  });

  it("deepMerge: key absent from base is simply assigned", () => {
    const merged = deepMerge<{ a?: number; b?: number }>({ a: 1 }, { b: 5 });
    expect(merged).toEqual({ a: 1, b: 5 });
  });

  it("resolveMergedConfig: all-sessions persona rewritten to main-only", () => {
    const loaded = resolveMergedConfig(
      { curators: { c: { alias: "c", scope: "all-sessions", goalFile: "/g" } } },
      { fileExists: () => true },
    );
    expect(loaded.config.curators.c.scope).toBe("main-only");
  });

  it("resolveMergedConfig: main-only persona stays main-only", () => {
    const loaded = resolveMergedConfig(
      { curators: { c: { alias: "c", scope: "main-only", goalFile: "/g" } } },
      { fileExists: () => true },
    );
    expect(loaded.config.curators.c.scope).toBe("main-only");
  });
});
