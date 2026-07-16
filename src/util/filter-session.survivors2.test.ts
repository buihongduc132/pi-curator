/**
 * filter-session.survivors2.test.ts — additional survivor kills in
 * src/util/filter-session.ts (round 2; survivors.test.ts already covers
 * stripThinkingBlocks / transformEntry message-field guard / renderSession /
 * analyzeFilter thinking tally).
 *
 * Killable:
 *  - id 2322/2329 (computeActiveBranchIds `cursor = typeof parent==="string" &&
 *    parent.length>0 ? parent : undefined`): an empty parentId must STOP the walk.
 *  - id 2328 (`typeof parent === "string"` → true): a missing parentId must not
 *    crash (mutant calls undefined.length).
 *  - id 2384 (transformEntry message guard → false): a NULL `message` field must
 *    pass through unchanged (mutant dereferences null.role).
 *  - id 2488 (analyzeFilter assistant check → true): a message entry with an
 *    undefined message must not crash (mutant dereferences undefined.role).
 *
 * EQUIVALENT:
 *  - id 2306 (`if (typeof e.id === "string") byId.set`): non-string ids are never
 *    looked up (the walk uses string cursors only).
 *  - id 2312/2313/2314 (`while (cursor && active.size < max)`): the explicit
 *    `if (active.has(cursor)) break` cycle-guard and `if (!node) break` already
 *    terminate the walk; the `active.size < max` cap is redundant defense.
 *  - id 2363/2506 already killed by survivors.test.ts (round 1) and verified.
 *  - id 2406 (parseSession JSON.parse catch → empty): after the emptied catch,
 *    `parsed` is undefined and the following `if (!parsed || typeof !== "object")`
 *    guard counts it as malformed identically.
 */
import { describe, it, expect } from "vitest";
import { computeActiveBranchIds, transformEntry, analyzeFilter } from "./filter-session.js";

describe("filter-session survivors (round 2)", () => {
  it("computeActiveBranchIds: empty parentId stops the walk (kills cursor-chain mutants)", () => {
    const entries = [
      { type: "message", id: "a", parentId: "" },
      { type: "message", id: "", parentId: null },
    ] as never;
    const active = computeActiveBranchIds(entries, "a");
    expect(active.size).toBe(1);
    expect(active.has("a")).toBe(true);
    expect(active.has("")).toBe(false);
  });

  it("computeActiveBranchIds: missing parentId does not crash (kills typeof→true mutant)", () => {
    const entries = [{ type: "message", id: "a" }] as never; // parentId undefined
    expect(() => computeActiveBranchIds(entries, "a")).not.toThrow();
    expect(computeActiveBranchIds(entries, "a").has("a")).toBe(true);
  });

  it("transformEntry: null message passes through (kills guard→false mutant)", () => {
    const e = { type: "message", id: "m", message: null } as never;
    expect(() => transformEntry(e)).not.toThrow();
    expect(transformEntry(e)).toBe(e);
  });

  it("analyzeFilter: undefined message does not crash (kills assistant-check→true mutant)", () => {
    const entries = [{ type: "message", id: "m" }] as never; // message undefined
    expect(() => analyzeFilter(entries)).not.toThrow();
    expect(analyzeFilter(entries).kept).toBe(1);
  });
});
