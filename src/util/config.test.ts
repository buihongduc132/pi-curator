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
import { describe, it, expect, beforeEach } from "vitest";
import {
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
