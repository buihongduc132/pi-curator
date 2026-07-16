/**
 * config.test.ts — co-located unit tests for curator config load/merge/validate
 * (REQ-CF-03/09, foundation T4).
 *
 * Test matrix (from task description + REQ-CF scenarios):
 *   - override (project persona deep-merges onto global)
 *   - disable (enabled:false disables; disabled in either layer = not spawned)
 *   - alias-missing reject
 *   - mutual-exclusion reject (excludeTools AND tools both set)
 *   - JSONC parsing (comments, trailing commas)
 *   - deepMerge (nested objects, arrays replaced)
 *   - resolvePersona defaults
 *   - validatePersona (filesystem-safe alias, scope warning, goalFile missing)
 *   - loadMergedConfig (global + project layers)
 *   - getCachedConfig (cwd-change invalidation)
 *   - enabledPersonas
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfigFile,
  stripJsonc,
  parseJsonc,
  deepMerge,
  mergeConfigFiles,
  resolveMergedConfig,
  resolvePersona,
  resolveAlias,
  validatePersona,
  hasBlockingIssue,
  loadMergedConfig,
  getCachedConfig,
  clearConfigCache,
  enabledPersonas,
  globalConfigPath,
  projectConfigPath,
  DEFAULT_JANITOR,
  DEFAULT_HEARTBEAT,
  ALIAS_PATTERN,
  type CuratorConfigFile,
  type CuratorPersona,
  type ResolvedPersona,
} from "./config";

// ─── Helpers ────────────────────────────────────────────────────────────────

function persona(over: Partial<CuratorPersona> = {}): CuratorPersona {
  return { goalFile: "/tmp/goal.md", ...over };
}

/** A fileExists stub that treats any path as existing. */
const fileExistsYes = () => true;
/** A fileExists stub that treats any path as missing. */
const fileExistsNo = () => false;

// ─── stripJsonc / parseJsonc ────────────────────────────────────────────────

describe("stripJsonc + parseJsonc", () => {
  it("strips line comments", () => {
    const input = `{
  // this is a comment
  "a": 1
}`;
    expect(parseJsonc(input)).toEqual({ a: 1 });
  });

  it("strips block comments", () => {
    const input = `{
  /* block
     comment */
  "a": 1
}`;
    expect(parseJsonc(input)).toEqual({ a: 1 });
  });

  it("strips trailing commas", () => {
    const input = `{
  "a": 1,
  "b": 2,
}`;
    expect(parseJsonc(input)).toEqual({ a: 1, b: 2 });
  });

  it("does NOT strip // inside strings", () => {
    const input = `{ "url": "https://example.com" }`;
    expect(parseJsonc(input)).toEqual({ url: "https://example.com" });
  });

  it("handles single-quoted strings (treats as string)", () => {
    const input = `{ 'a': 'b' }`;
    // single quotes are not valid JSON, but our stripper tracks them; JSON.parse
    // will still reject. We only assert stripJsonc doesn't corrupt the content.
    expect(stripJsonc(input)).toContain("'a'");
  });

  it("handles escape sequences in strings", () => {
    const input = `{ "a": "line\\nbreak", "b": "quote\\"inside" }`;
    expect(parseJsonc(input)).toEqual({ a: "line\nbreak", b: 'quote"inside' });
  });

  it("throws on invalid JSON", () => {
    expect(() => parseJsonc("{ invalid }")).toThrow();
  });

  it("full JSONC config with comments + trailing commas", () => {
    const input = `{
  // curator personas
  "curators": {
    "spec": { // spec-checker
      "goalFile": "/tmp/spec.md",
    }
  }
}`;
    const parsed = parseJsonc<CuratorConfigFile>(input);
    expect(parsed.curators?.spec?.goalFile).toBe("/tmp/spec.md");
  });
});

// ─── deepMerge ───────────────────────────────────────────────────────────────

describe("deepMerge", () => {
  it("merges nested objects recursively", () => {
    const base = { a: { x: 1, y: 2 }, b: 1 };
    const over = { a: { y: 3, z: 4 } };
    expect(deepMerge(base, over)).toEqual({ a: { x: 1, y: 3, z: 4 }, b: 1 });
  });

  it("replaces arrays (not concat)", () => {
    const base = { tools: ["a", "b"] };
    const over = { tools: ["c"] };
    expect(deepMerge(base, over)).toEqual({ tools: ["c"] });
  });

  it("replaces primitives", () => {
    expect(deepMerge({ x: 1 }, { x: 2 })).toEqual({ x: 2 });
  });

  it("undefined in override keeps base value", () => {
    expect(deepMerge({ x: 1 }, { x: undefined })).toEqual({ x: 1 });
  });

  it("does not mutate inputs", () => {
    const base = { a: { x: 1 } };
    const over = { a: { y: 2 } };
    deepMerge(base, over);
    expect(base).toEqual({ a: { x: 1 } });
    expect(over).toEqual({ a: { y: 2 } });
  });

  it("returns override when base is not an object", () => {
    expect(deepMerge(5 as never, { x: 1 })).toEqual({ x: 1 });
  });

  it("returns base when override is undefined", () => {
    expect(deepMerge({ x: 1 }, undefined)).toEqual({ x: 1 });
  });
});

// ─── resolveAlias ────────────────────────────────────────────────────────────

describe("resolveAlias", () => {
  it("uses the explicit alias field when present", () => {
    expect(resolveAlias("key", { alias: "explicit" })).toBe("explicit");
  });

  it("falls back to the JSON key when alias field is absent/empty", () => {
    expect(resolveAlias("spec", {})).toBe("spec");
    expect(resolveAlias("spec", { alias: "" })).toBe("spec");
    expect(resolveAlias("spec", { alias: "   " })).toBe("spec");
  });
});

// ─── resolvePersona (defaults) ───────────────────────────────────────────────

describe("resolvePersona (schema defaults)", () => {
  it("applies all field defaults", () => {
    const p = resolvePersona("spec", { goalFile: "/tmp/g.md" });
    expect(p.alias).toBe("spec");
    expect(p.enabled).toBe(true);
    expect(p.scope).toBe("main-only");
    expect(p.includeThinking).toBe(false);
    expect(p.appendDisplay).toBe(false);
    expect(p.heartbeat).toEqual(DEFAULT_HEARTBEAT);
  });

  it("preserves explicit values", () => {
    const p = resolvePersona("spec", {
      enabled: false,
      scope: "all-sessions",
      includeThinking: true,
      appendDisplay: true,
      heartbeat: { intervalSec: 7 },
      spawn: { everyTurns: 3 },
      excludeTools: ["bash"],
    });
    expect(p.enabled).toBe(false);
    expect(p.scope).toBe("all-sessions");
    expect(p.includeThinking).toBe(true);
    expect(p.appendDisplay).toBe(true);
    expect(p.heartbeat.intervalSec).toBe(7); // overridden
    expect(p.heartbeat.staleSec).toBe(DEFAULT_HEARTBEAT.staleSec); // default kept
    expect(p.spawn?.everyTurns).toBe(3);
    expect(p.excludeTools).toEqual(["bash"]);
  });
});

// ─── validatePersona ─────────────────────────────────────────────────────────

describe("validatePersona (REQ-CF-09)", () => {
  it("passes a valid persona with no issues", () => {
    const p = resolvePersona("spec", { goalFile: "/tmp/g.md" });
    expect(validatePersona(p, { fileExists: fileExistsYes })).toEqual([]);
  });

  it("rejects a persona with a missing/empty alias (alias_required)", () => {
    const p = resolvePersona("", { goalFile: "/tmp/g.md" });
    const issues = validatePersona(p, { fileExists: fileExistsYes });
    expect(issues.some((i) => i.code === "alias_required" && i.level === "error")).toBe(true);
  });

  it("rejects an alias that is not filesystem-safe", () => {
    const p = resolvePersona("bad alias!", { goalFile: "/tmp/g.md" });
    const issues = validatePersona(p, { fileExists: fileExistsYes });
    expect(issues.some((i) => i.code === "alias_not_filesystem_safe")).toBe(true);
  });

  it("rejects when BOTH excludeTools and tools are set (mutual exclusion)", () => {
    const p = resolvePersona("spec", {
      goalFile: "/tmp/g.md",
      excludeTools: ["bash"],
      tools: ["read"],
    });
    const issues = validatePersona(p, { fileExists: fileExistsYes });
    expect(issues.some((i) => i.code === "tools_mutual_exclusion" && i.level === "error")).toBe(true);
  });

  it("allows excludeTools OR tools alone (no error)", () => {
    const withExclude = resolvePersona("spec", { goalFile: "/tmp/g.md", excludeTools: ["bash"] });
    expect(validatePersona(withExclude, { fileExists: fileExistsYes })).toEqual([]);
    const withTools = resolvePersona("spec", { goalFile: "/tmp/g.md", tools: ["read"] });
    expect(validatePersona(withTools, { fileExists: fileExistsYes })).toEqual([]);
  });

  it("warns on scope all-sessions (v1 unsupported)", () => {
    const p = resolvePersona("spec", { goalFile: "/tmp/g.md", scope: "all-sessions" });
    const issues = validatePersona(p, { fileExists: fileExistsYes });
    expect(issues.some((i) => i.code === "scope_all_sessions_unsupported" && i.level === "warning")).toBe(true);
  });

  it("warns when goalFile does not exist on disk", () => {
    const p = resolvePersona("spec", { goalFile: "/tmp/missing.md" });
    const issues = validatePersona(p, { fileExists: fileExistsNo });
    expect(issues.some((i) => i.code === "goal_file_missing" && i.level === "warning")).toBe(true);
  });

  it("does not warn about goalFile when it exists", () => {
    const p = resolvePersona("spec", { goalFile: "/tmp/g.md" });
    const issues = validatePersona(p, { fileExists: fileExistsYes });
    expect(issues.some((i) => i.code === "goal_file_missing")).toBe(false);
  });

  it("ALIAS_PATTERN matches filesystem-safe aliases", () => {
    expect(ALIAS_PATTERN.test("spec")).toBe(true);
    expect(ALIAS_PATTERN.test("security-audit")).toBe(true);
    expect(ALIAS_PATTERN.test("scold_1")).toBe(true);
    expect(ALIAS_PATTERN.test("Spec123")).toBe(true);
    expect(ALIAS_PATTERN.test("")).toBe(false);
    expect(ALIAS_PATTERN.test("bad alias!")).toBe(false);
    expect(ALIAS_PATTERN.test("/path")).toBe(false);
    expect(ALIAS_PATTERN.test(".hidden")).toBe(false); // leading dot not safe
  });
});

describe("hasBlockingIssue", () => {
  it("returns true when any error-level issue exists", () => {
    expect(hasBlockingIssue([{ alias: "x", level: "error", code: "c", message: "m" }])).toBe(true);
  });

  it("returns false when only warnings exist", () => {
    expect(hasBlockingIssue([{ alias: "x", level: "warning", code: "c", message: "m" }])).toBe(false);
    expect(hasBlockingIssue([])).toBe(false);
  });
});

// ─── mergeConfigFiles (override) ─────────────────────────────────────────────

describe("mergeConfigFiles (REQ-CF-03 override semantics)", () => {
  it("project persona deep-merges onto global (field-by-field, not replace)", () => {
    const global: CuratorConfigFile = {
      curators: {
        spec: { goalFile: "/global/spec.md", model: "sonnet", heartbeat: { intervalSec: 10, staleSec: 40 } },
      },
    };
    const project: CuratorConfigFile = {
      curators: {
        spec: { heartbeat: { staleSec: 60 } }, // override one heartbeat field
      },
    };
    const merged = mergeConfigFiles(global, project);
    const spec = merged.curators!.spec;
    expect(spec.goalFile).toBe("/global/spec.md"); // global kept (not overridden)
    expect(spec.model).toBe("sonnet"); // global kept
    expect(spec.heartbeat?.intervalSec).toBe(10); // global kept
    expect(spec.heartbeat?.staleSec).toBe(60); // project overrode
  });

  it("project can ADD a new persona not in global", () => {
    const global: CuratorConfigFile = { curators: { spec: persona() } };
    const project: CuratorConfigFile = { curators: { scold: persona({ goalFile: "/p/scold.md" }) } };
    const merged = mergeConfigFiles(global, project);
    expect(Object.keys(merged.curators!).sort()).toEqual(["scold", "spec"]);
  });

  it("project can DISABLE a global persona (enabled:false)", () => {
    const global: CuratorConfigFile = { curators: { spec: persona() } };
    const project: CuratorConfigFile = { curators: { spec: { enabled: false } } };
    const merged = mergeConfigFiles(global, project);
    expect(merged.curators!.spec.enabled).toBe(false);
  });

  it("project can enable a persona that was disabled globally", () => {
    const global: CuratorConfigFile = { curators: { spec: { ...persona(), enabled: false } } };
    const project: CuratorConfigFile = { curators: { spec: { enabled: true } } };
    const merged = mergeConfigFiles(global, project);
    expect(merged.curators!.spec.enabled).toBe(true);
  });

  it("merges janitor config deep", () => {
    const global: CuratorConfigFile = { janitor: { interval: "10m", staleSec: 45 } };
    const project: CuratorConfigFile = { janitor: { staleSec: 60 } };
    const merged = mergeConfigFiles(global, project);
    expect(merged.janitor?.interval).toBe("10m"); // global kept
    expect(merged.janitor?.staleSec).toBe(60); // project overrode
  });

  it("handles null global (project only)", () => {
    const project: CuratorConfigFile = { curators: { spec: persona() } };
    const merged = mergeConfigFiles(null, project);
    expect(merged.curators!.spec).toBeDefined();
  });

  it("handles null project (global only)", () => {
    const global: CuratorConfigFile = { curators: { spec: persona() } };
    const merged = mergeConfigFiles(global, null);
    expect(merged.curators!.spec).toBeDefined();
  });

  it("handles both null", () => {
    expect(mergeConfigFiles(null, null)).toEqual({ curators: {}, janitor: {} });
  });
});

// ─── resolveMergedConfig (validation disables personas) ──────────────────────

describe("resolveMergedConfig (REQ-CF-09 non-blocking validation)", () => {
  it("applies janitor defaults", () => {
    const merged = resolveMergedConfig({ curators: {}, janitor: {} });
    expect(merged.config.janitor).toEqual(DEFAULT_JANITOR);
  });

  it("disables a persona with a blocking error (alias missing)", () => {
    // Empty alias key → alias_required error → persona disabled.
    const result = resolveMergedConfig(
      { curators: { "": persona() } },
      { fileExists: fileExistsYes },
    );
    expect(result.config.curators[""].enabled).toBe(false);
    expect(result.issues.some((i) => i.code === "alias_required")).toBe(true);
  });

  it("disables a persona with mutual-exclusion error", () => {
    const result = resolveMergedConfig(
      {
        curators: {
          spec: { ...persona(), excludeTools: ["bash"], tools: ["read"] },
        },
      },
      { fileExists: fileExistsYes },
    );
    expect(result.config.curators.spec.enabled).toBe(false);
    expect(result.issues.some((i) => i.code === "tools_mutual_exclusion")).toBe(true);
  });

  it("keeps a valid persona enabled", () => {
    const result = resolveMergedConfig(
      { curators: { spec: persona() } },
      { fileExists: fileExistsYes },
    );
    expect(result.config.curators.spec.enabled).toBe(true);
  });

  it("treats scope all-sessions as main-only (v1) with a warning", () => {
    const result = resolveMergedConfig(
      { curators: { spec: { ...persona(), scope: "all-sessions" } } },
      { fileExists: fileExistsYes },
    );
    expect(result.config.curators.spec.scope).toBe("main-only");
    expect(result.config.curators.spec.enabled).toBe(true); // warning, not error
    expect(result.issues.some((i) => i.code === "scope_all_sessions_unsupported")).toBe(true);
  });

  it("does not throw on any invalid config (non-blocking)", () => {
    expect(() =>
      resolveMergedConfig(
        {
          curators: {
            "bad name!": { ...persona(), excludeTools: ["a"], tools: ["b"] },
          },
        },
        { fileExists: fileExistsYes },
      ),
    ).not.toThrow();
  });

  it("resolves the alias from the key when the alias field is absent", () => {
    const result = resolveMergedConfig(
      { curators: { spec: { goalFile: "/tmp/g.md" } } }, // no alias field
      { fileExists: fileExistsYes },
    );
    expect(result.config.curators.spec.alias).toBe("spec");
  });
});

// ─── loadMergedConfig (layered loading) ──────────────────────────────────────

describe("loadMergedConfig (global + project layers)", () => {
  it("merges global + project", () => {
    // Pure merge test via mergeConfigFiles + resolveMergedConfig (no fs).
    const global: CuratorConfigFile = { curators: { spec: persona({ model: "global-model" }) } };
    const project: CuratorConfigFile = { curators: { spec: { goalFile: "/p/spec.md" } } };
    const merged = mergeConfigFiles(global, project);
    const result = resolveMergedConfig(merged, { fileExists: fileExistsYes });
    expect(result.config.curators.spec.model).toBe("global-model");
    expect(result.config.curators.spec.goalFile).toBe("/p/spec.md");
  });
});

// ─── enabledPersonas ─────────────────────────────────────────────────────────

describe("enabledPersonas (REQ-CF-03 disable)", () => {
  it("returns only enabled personas", () => {
    const result = resolveMergedConfig(
      {
        curators: {
          on: persona(),
          off: { ...persona(), enabled: false },
          bad: { ...persona(), excludeTools: ["a"], tools: ["b"] }, // error → disabled
        },
      },
      { fileExists: fileExistsYes },
    );
    const enabled = enabledPersonas(result.config);
    expect(Object.keys(enabled)).toEqual(["on"]);
  });
});

// ─── getCachedConfig (cwd-change invalidation) ───────────────────────────────

describe("getCachedConfig (cwd-change invalidation)", () => {
  beforeEach(() => {
    clearConfigCache();
  });

  it("caches the config for the same projectRoot", () => {
    const opts = { projectRoot: "/tmp/proj-a", fileExists: fileExistsYes };
    const a = getCachedConfig(opts);
    const b = getCachedConfig(opts);
    // Same reference (cached).
    expect(b).toBe(a);
  });

  it("recomputes when projectRoot changes", () => {
    const a = getCachedConfig({ projectRoot: "/tmp/proj-a", fileExists: fileExistsYes });
    const b = getCachedConfig({ projectRoot: "/tmp/proj-b", fileExists: fileExistsYes });
    // Different reference (cache invalidated on cwd change).
    expect(b).not.toBe(a);
  });

  it("force:true bypasses the cache", () => {
    const opts = { projectRoot: "/tmp/proj-a", fileExists: fileExistsYes };
    const a = getCachedConfig(opts);
    const b = getCachedConfig({ ...opts, force: true });
    expect(b).not.toBe(a);
  });

  it("never throws (degrades to empty config on fs failure)", () => {
    expect(() =>
      getCachedConfig({ projectRoot: "/nonexistent/path/that/does/not/exist" }),
    ).not.toThrow();
  });
});

// ─── path helpers ────────────────────────────────────────────────────────────

describe("path helpers", () => {
  it("globalConfigPath → <home>/.pi-curator/curators.json", () => {
    expect(globalConfigPath("/home/u")).toBe("/home/u/.pi-curator/curators.json");
  });

  it("projectConfigPath → <root>/.pi-curator/curators.json", () => {
    expect(projectConfigPath("/proj")).toBe("/proj/.pi-curator/curators.json");
  });
});

// ─── DEFAULT constants ───────────────────────────────────────────────────────

describe("DEFAULT constants", () => {
  it("DEFAULT_JANITOR has the spec defaults", () => {
    expect(DEFAULT_JANITOR).toEqual({
      enabled: true,
      interval: "5m",
      staleSec: 30,
      deadSec: 120,
      forkTTL: "24h",
    });
  });

  it("DEFAULT_HEARTBEAT has the spec defaults", () => {
    expect(DEFAULT_HEARTBEAT).toEqual({ intervalSec: 5, staleSec: 30, deadSec: 120 });
  });
});

// ─── stripJsonc: escape + comment edge cases (mutation survivors) ────────────

describe("stripJsonc escape + comment edge cases", () => {
  // Mutants on the in-string backslash escape handling.
  it("preserves // inside a string after an escaped quote (escape path taken)", () => {
    // Real stripper treats `\"` as an escaped quote (stays in string) so the
    // trailing `// kept` is string content, NOT a line comment.
    const input = '{ "a": "x\\" // kept" }'; // chars: { "a": "x\" // kept" }
    expect(stripJsonc(input)).toBe(input);
  });

  it("preserves a trailing backslash at EOF inside a string (no next char)", () => {
    // Last char is `\` inside an open string; escape must NOT read past EOF.
    const input = '{ "a": "x\\'; // chars: { "a": "x\
    expect(stripJsonc(input)).toBe(input);
  });

  it("does not treat a lone division slash as a comment start", () => {
    // `ch === "/" && next === "*"` must require `*`; a lone `/` is literal.
    const input = "{ \"a\": 1 / 2 }";
    expect(stripJsonc(input)).toBe(input);
  });

  it("does not start a block comment on a non-slash char followed by *", () => {
    // `ch === "/"` guard: a bare `*` outside a comment is preserved.
    expect(stripJsonc("a*b")).toBe("a*b");
  });

  it("stops a block comment only at the real `*/` (not at a lone `/` inside)", () => {
    // A `/` inside the block must NOT terminate it early.
    expect(stripJsonc("/* a / b */x")).toBe("x");
  });

  it("stops a block comment only at the real `*/` (not at a lone `*` inside)", () => {
    // A `*` inside the block must NOT terminate it early.
    expect(stripJsonc("/* a * b */x")).toBe("x");
  });

  it("tracks single-quoted strings so // inside them is not a comment", () => {
    // Single quotes open a string; `//x` is content, not a line comment.
    expect(stripJsonc("{ 'a': '//x' }")).toBe("{ 'a': '//x' }");
  });

  it("handles a line comment running to EOF with no trailing newline", () => {
    // Loop bound `i < len` must terminate at EOF.
    expect(stripJsonc("// eof comment")).toBe("");
  });

  it("handles an unterminated block comment (runs to EOF)", () => {
    expect(stripJsonc("/* unterminated")).toBe("");
  });
});

// ─── deepMerge: null / undefined edge cases (mutation survivors) ─────────────

describe("deepMerge null/undefined edges", () => {
  it("treats a null override as a replacement (returns null), not a plain object", () => {
    // isPlainObject(null) must be false; otherwise Object.entries(null) throws.
    expect(deepMerge({ a: 1 }, null)).toBeNull();
  });

  it("does not introduce undefined-valued keys from an override", () => {
    // `if (val === undefined) continue;` must skip undefined override values.
    const merged = deepMerge({ a: 1 }, { b: undefined, c: 2 });
    expect(Object.keys(merged).sort()).toEqual(["a", "c"]);
  });
});

// ─── resolvePersona: optional field round-trip (mutation survivors) ──────────

describe("resolvePersona optional fields", () => {
  it("preserves every optional field when set", () => {
    const p = resolvePersona("spec", {
      goalFile: "/g.md",
      taskPrompt: "do X",
      model: "sonnet",
      spawn: { everyTurns: 3 },
      contextBudget: 12345,
      excludeTools: ["bash"],
      tools: ["read"],
    });
    expect(p.goalFile).toBe("/g.md");
    expect(p.taskPrompt).toBe("do X");
    expect(p.model).toBe("sonnet");
    expect(p.spawn?.everyTurns).toBe(3);
    expect(p.contextBudget).toBe(12345);
    expect(p.excludeTools).toEqual(["bash"]);
    expect(p.tools).toEqual(["read"]);
  });

  it("does NOT define optional keys when absent", () => {
    // `if (raw.X !== undefined)` guards must not assign undefined-valued keys.
    const p = resolvePersona("spec", {});
    expect(Object.keys(p).sort()).toEqual(
      ["alias", "appendDisplay", "enabled", "heartbeat", "includeThinking", "scope"].sort(),
    );
  });
});

// ─── validatePersona: alias + goalFile edges (mutation survivors) ────────────

describe("validatePersona alias/goalFile edges", () => {
  it("rejects a whitespace-only alias as alias_required (not alias_not_filesystem_safe)", () => {
    // `!alias || alias.trim().length === 0` must catch " " via the trim check.
    const p = resolvePersona(" ", { goalFile: "/g.md" });
    const issues = validatePersona(p, { fileExists: fileExistsYes });
    expect(issues.some((i) => i.code === "alias_required")).toBe(true);
  });

  it("reports the raw alias on the issue for a whitespace alias", () => {
    // `alias || "<empty>"` must keep a truthy (whitespace) alias verbatim.
    const p = resolvePersona(" ", { goalFile: "/g.md" });
    const issues = validatePersona(p, { fileExists: fileExistsYes });
    const req = issues.find((i) => i.code === "alias_required");
    expect(req?.alias).toBe(" ");
  });

  it("reports '<empty>' as the alias on the issue for an empty alias", () => {
    const p = resolvePersona("", { goalFile: "/g.md" });
    const issues = validatePersona(p, { fileExists: fileExistsYes });
    const req = issues.find((i) => i.code === "alias_required");
    expect(req?.alias).toBe("<empty>");
  });

  it("does not crash or warn when goalFile is undefined", () => {
    // `persona.goalFile !== undefined` guard must short-circuit before .length.
    const p = resolvePersona("spec", {});
    expect(() => validatePersona(p, { fileExists: fileExistsYes })).not.toThrow();
    expect(validatePersona(p, { fileExists: fileExistsYes })).toEqual([]);
  });

  it("does not warn about an empty-string goalFile", () => {
    // `persona.goalFile.length > 0` must skip the existence check for "".
    const p = resolvePersona("spec", { goalFile: "" });
    const issues = validatePersona(p, { fileExists: fileExistsNo });
    expect(issues.some((i) => i.code === "goal_file_missing")).toBe(false);
  });
});

// ─── validatePersona: default fileExists (real fs, tmpdir) ───────────────────

describe("validatePersona default fileExists (real existsSync)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "curator-cfg-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses real existsSync when fileExists is omitted (file present → no warning)", () => {
    const goal = join(dir, "goal.md");
    writeFileSync(goal, "x");
    const p = resolvePersona("spec", { goalFile: goal });
    const issues = validatePersona(p); // no fileExists → default arrow
    expect(issues.some((i) => i.code === "goal_file_missing")).toBe(false);
  });

  it("uses real existsSync when fileExists is omitted (file absent → warning)", () => {
    const p = resolvePersona("spec", { goalFile: join(dir, "nope.md") });
    const issues = validatePersona(p);
    expect(issues.some((i) => i.code === "goal_file_missing")).toBe(true);
  });
});

// ─── resolveMergedConfig: fileExists + janitor + issues edges ────────────────

describe("resolveMergedConfig fileExists/janitor/issues edges", () => {
  it("honors an injected fileExists (Yes) even when the goalFile is absent on disk", () => {
    // `opts.fileExists ?? fallback` must keep the injected stub.
    const result = resolveMergedConfig(
      { curators: { spec: { goalFile: "/definitely/not/here-zzz" } } },
      { fileExists: fileExistsYes },
    );
    expect(result.issues.some((i) => i.code === "goal_file_missing")).toBe(false);
  });

  it("forwards fileExists into validatePersona (ObjectLiteral `{}` mutant must not strip it)", () => {
    const result = resolveMergedConfig(
      { curators: { spec: { goalFile: "/definitely/not/here-zzz" } } },
      { fileExists: fileExistsYes },
    );
    expect(result.issues).toEqual([]);
  });

  it("uses default existsSync when fileExists is omitted (real fs, tmpdir)", () => {
    const dir = mkdtempSync(join(tmpdir(), "curator-cfg2-"));
    try {
      const goal = join(dir, "g.md");
      writeFileSync(goal, "x");
      const r = resolveMergedConfig({ curators: { spec: { goalFile: goal } } });
      expect(r.issues.some((i) => i.code === "goal_file_missing")).toBe(false);
      const missing = resolveMergedConfig({ curators: { spec: { goalFile: join(dir, "no.md") } } });
      expect(missing.issues.some((i) => i.code === "goal_file_missing")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deep-merges a null janitor onto defaults (does not collapse to null)", () => {
    // `merged.janitor ?? {}` must yield {} for null, not pass null through.
    const result = resolveMergedConfig({ curators: {}, janitor: null as never });
    expect(result.config.janitor).toEqual(DEFAULT_JANITOR);
  });

  it("returns an empty issues array for a fully-valid config", () => {
    const result = resolveMergedConfig(
      { curators: { spec: { goalFile: "/g.md" } } },
      { fileExists: fileExistsYes },
    );
    expect(result.issues).toEqual([]);
  });
});

// ─── loadConfigFile: whitespace + unparseable (mutation survivors) ───────────

describe("loadConfigFile (fs wrapper)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "curator-load-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns {} for a whitespace-only file (trimmed empty)", () => {
    const f = join(dir, "ws.json");
    writeFileSync(f, "   \n  \t  ");
    expect(loadConfigFile(f)).toEqual({});
  });

  it("returns null for an unparseable file (never throws)", () => {
    const f = join(dir, "bad.json");
    writeFileSync(f, "{ not valid json ");
    expect(loadConfigFile(f)).toBeNull();
  });

  it("returns null for a missing file", () => {
    expect(loadConfigFile(join(dir, "missing.json"))).toBeNull();
  });

  it("parses a valid JSONC config file", () => {
    const f = join(dir, "ok.jsonc");
    writeFileSync(f, "{ \"curators\": { \"spec\": { \"goalFile\": \"/g.md\" } } }\n");
    expect(loadConfigFile(f)?.curators?.spec?.goalFile).toBe("/g.md");
  });
});

// ─── getHome / globalConfigPath / loadMergedConfig (mutation survivors) ───────

describe("getHome via globalConfigPath (env-driven)", () => {
  const save = { ...process.env };
  afterEach(() => {
    // Restore env precisely.
    for (const k of Object.keys(process.env)) if (!(k in save)) delete process.env[k];
    for (const [k, v] of Object.entries(save)) process.env[k] = v as string;
  });

  it("prefers HOME over USERPROFILE and /tmp", () => {
    process.env.HOME = "/home/mutation-test-x";
    delete process.env.USERPROFILE;
    expect(globalConfigPath()).toContain("/home/mutation-test-x/.pi-curator");
    expect(globalConfigPath()).not.toContain("/tmp/");
  });

  it("falls back to USERPROFILE when HOME is unset", () => {
    delete process.env.HOME;
    process.env.USERPROFILE = "C:\\Users\\mut";
    expect(globalConfigPath()).toContain("Users");
  });

  it("falls back to /tmp when neither HOME nor USERPROFILE is set", () => {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    expect(globalConfigPath()).toContain("/tmp/.pi-curator");
  });
});

describe("loadMergedConfig homeDir / fileExists injection", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "curator-merged-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads the global config from the injected homeDir", () => {
    // `opts.homeDir ?? getHome()` must use the injected homeDir. Use DISTINCT
    // home vs project dirs so the global config is only reachable via homeDir.
    const home = dir;
    const proj = mkdtempSync(join(tmpdir(), "curator-proj-"));
    mkdirSync(join(home, ".pi-curator"), { recursive: true });
    writeFileSync(
      join(home, ".pi-curator", "curators.json"),
      '{ "curators": { "spec": { "goalFile": "/g.md" } } }',
    );
    const result = loadMergedConfig({ homeDir: home, projectRoot: proj, fileExists: fileExistsYes });
    expect(result.config.curators.spec?.alias).toBe("spec");
    rmSync(proj, { recursive: true, force: true });
  });

  it("forwards injected fileExists into the validation pipeline", () => {
    // Even with a bogus goalFile, an injected fileExists:Yes suppresses warnings.
    const home = dir;
    const proj = mkdtempSync(join(tmpdir(), "curator-proj2-"));
    mkdirSync(join(home, ".pi-curator"), { recursive: true });
    writeFileSync(
      join(home, ".pi-curator", "curators.json"),
      '{ "curators": { "spec": { "goalFile": "/no/such/file-zzz" } } }',
    );
    const result = loadMergedConfig({ homeDir: home, projectRoot: proj, fileExists: fileExistsYes });
    expect(result.issues.some((i) => i.code === "goal_file_missing")).toBe(false);
    rmSync(proj, { recursive: true, force: true });
  });
});

// ─── getCachedConfig: clearConfigCache effectiveness ─────────────────────────

describe("clearConfigCache effectiveness", () => {
  beforeEach(() => clearConfigCache());

  it("clearConfigCache forces a recompute on the next read (new reference)", () => {
    const opts = { projectRoot: "/tmp/proj-clear", fileExists: fileExistsYes };
    const a = getCachedConfig(opts);
    const cached = getCachedConfig(opts);
    expect(cached).toBe(a); // cached before clear
    clearConfigCache();
    const recomputed = getCachedConfig(opts);
    expect(recomputed).not.toBe(a); // new reference after clear
  });
});
