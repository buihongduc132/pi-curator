/**
 * config.survivors.test.ts — kills surviving mutants in src/util/config.ts:
 *   - validatePersona message StringLiterals (assert exact message text, not
 *     just `code` — the existing tests only check `code`).
 *   - stripJsonc comment-stripping exact output (line + block comments,
 *     trailing comma, strings containing comment-like text).
 *   - resolveMergedConfig scope=all-sessions → main-only rewrite.
 */
import { describe, it, expect } from "vitest";
import {
  stripJsonc,
  validatePersona,
  resolvePersona,
  resolveMergedConfig,
} from "./config.js";

const fileExistsYes = () => true;
const fileExistsNo = () => false;
const basePersona = () => ({ goalFile: "/tmp/g.md" });

describe("validatePersona — message text (survivor round 2)", () => {
  it("alias_required message names the missing alias", () => {
    const issues = validatePersona(resolvePersona("", basePersona()), { fileExists: fileExistsYes });
    const i = issues.find((x) => x.code === "alias_required")!;
    expect(i.message).toBe("persona is missing its alias");
    expect(i.level).toBe("error");
  });

  it("alias_not_filesystem_safe message includes the alias + pattern hint", () => {
    const issues = validatePersona(resolvePersona("bad alias!", basePersona()), { fileExists: fileExistsYes });
    const i = issues.find((x) => x.code === "alias_not_filesystem_safe")!;
    expect(i.message).toContain('"bad alias!"');
    expect(i.message).toContain("filesystem-safe");
  });

  it("tools_mutual_exclusion message names mutual exclusivity", () => {
    const issues = validatePersona(
      resolvePersona("spec", { ...basePersona(), excludeTools: ["bash"], tools: ["read"] }),
      { fileExists: fileExistsYes },
    );
    const i = issues.find((x) => x.code === "tools_mutual_exclusion")!;
    expect(i.message).toContain("BOTH excludeTools and tools");
    expect(i.message).toContain("mutually exclusive");
  });

  it("scope_all_sessions_unsupported message mentions v1 ignores it", () => {
    const issues = validatePersona(
      resolvePersona("spec", { ...basePersona(), scope: "all-sessions" }),
      { fileExists: fileExistsYes },
    );
    const i = issues.find((x) => x.code === "scope_all_sessions_unsupported")!;
    expect(i.message).toContain("all-sessions");
    expect(i.message).toContain("v1 ignores");
  });

  it("goal_file_missing message includes the goalFile path", () => {
    const issues = validatePersona(
      resolvePersona("spec", { goalFile: "/tmp/does-not-exist.md" }),
      { fileExists: fileExistsNo },
    );
    const i = issues.find((x) => x.code === "goal_file_missing")!;
    expect(i.message).toContain('"/tmp/does-not-exist.md"');
    expect(i.message).toContain("does not exist");
  });
});

describe("stripJsonc — exact comment-stripping output", () => {
  it("removes a line comment but preserves the trailing newline", () => {
    expect(stripJsonc("// hi\n42")).toBe("\n42");
  });

  it("removes a line comment running to EOF", () => {
    expect(stripJsonc("42 // trailing")).toBe("42 ");
  });

  it("removes a block comment spanning content", () => {
    expect(stripJsonc("a/* x */b")).toBe("ab");
  });

  it("removes a block comment at EOF without a closing pair", () => {
    expect(stripJsonc("a/* unclosed")).toBe("a");
  });

  it("does NOT strip comment-like text inside a string", () => {
    expect(stripJsonc('"// not a comment"')).toBe('"// not a comment"');
    expect(stripJsonc('"/* still string */"')).toBe('"/* still string */"');
  });

  it("preserves escape sequences inside strings", () => {
    expect(stripJsonc('"a\\"b"')).toBe('"a\\"b"');
  });

  it("removes trailing commas before } and ]", () => {
    expect(stripJsonc('{"a":1,}')).toBe('{"a":1}');
    expect(stripJsonc("[1,2,]")).toBe("[1,2]");
  });
});

describe("resolveMergedConfig — scope all-sessions rewrite", () => {
  it("rewrites scope all-sessions to main-only in the resolved persona", () => {
    const resolved = resolveMergedConfig(
      { curators: { spec: { alias: "spec", enabled: true, goalFile: "/tmp/g.md", scope: "all-sessions" } } },
      { fileExists: fileExistsYes },
    );
    const p = resolved.config.curators!.spec;
    expect(p.scope).toBe("main-only");
  });

  it("uses empty-string projectRoot when none is supplied", () => {
    // No projectRoot → defaults to "" (does not throw).
    const resolved = resolveMergedConfig(
      { curators: { spec: { alias: "spec", enabled: true, goalFile: "/tmp/g.md" } } },
      { fileExists: fileExistsYes },
    );
    expect(resolved.config.curators!.spec.alias).toBe("spec");
  });
});
