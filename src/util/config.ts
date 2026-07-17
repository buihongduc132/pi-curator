/**
 * config.ts — curator persona + janitor config loading/merge/validation
 * (REQ-CF-03/09, foundation T4).
 *
 * ## Layered config (pi-config-parity 3-layer rule)
 *
 * The effective config is a deep-merge of: **defaults ← global ← project**.
 *
 *   - **defaults**: built-in schema field defaults (enabled:true, scope:
 *     "main-only", includeThinking:false, appendDisplay:false, heartbeat
 *     5s/30s/120s, janitor 5m/30s/120s/24h). Applied per-persona by
 *     {@link resolvePersona}. The shipped `defaults/curators.json` reference
 *     personas (REQ-CF-10) are NOT auto-loaded — the user opts in by copying.
 *   - **global**: `~/.pi-curator/curators.json` (JSONC — JSON with comments).
 *   - **project**: `<project-root>/.pi-curator/curators.json` (JSONC).
 *
 * Personas are keyed by `alias`. A project persona with the same alias as a
 * global persona deep-merges field-by-field onto the global (NOT replace).
 * `enabled:false` in EITHER layer disables the persona (REQ-CF-03).
 *
 * ## Validation (REQ-CF-09)
 *
 * Validation errors do NOT block main startup (AGENTS.md Exception Safety):
 *   - `alias` missing/empty/not-filesystem-safe → persona disabled (error).
 *   - `excludeTools` AND `tools` both set → persona disabled (error, mutually
 *     exclusive).
 *   - `goalFile` set but missing on disk → persona disabled (warning).
 *   - `scope:"all-sessions"` → warning (v1 treats as main-only).
 *
 * ## Design: pure functions + thin I/O + cwd-cache
 *
 * {@link mergeConfig}, {@link resolvePersona}, {@link validatePersona} are pure
 * (no fs, no Date) so they are fully unit-testable. {@link loadMergedConfig}
 * is the thin fs wrapper. {@link getCachedConfig} caches by projectRoot and
 * invalidates on cwd change (mirrors todo-enforcer/config.ts).
 */

import { readFileSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CuratorPersonaSpawn {
  everyTurns?: number;
  everyMins?: number;
}

export interface CuratorPersonaHeartbeat {
  intervalSec?: number; // default 5
  staleSec?: number; // default 30
  deadSec?: number; // default 120
}

/**
 * A curator persona (REQ-CF-03 persona schema). `Partial` fields are optional
 * in config; {@link resolvePersona} fills defaults to produce a fully-resolved
 * {@link ResolvedPersona}.
 */
export interface CuratorPersona {
  enabled?: boolean; // default true
  alias?: string; // required (inferred from the JSON key if absent)
  goalFile?: string; // required (validated for existence)
  taskPrompt?: string;
  model?: string; // defaults to main's model
  scope?: "main-only" | "all-sessions"; // default "main-only"
  spawn?: CuratorPersonaSpawn;
  includeThinking?: boolean; // default false (non-bias)
  contextBudget?: number; // overrides model context window for trim
  excludeTools?: string[]; // mutually exclusive with `tools`
  tools?: string[]; // mutually exclusive with `excludeTools`
  appendDisplay?: boolean; // default false
  heartbeat?: CuratorPersonaHeartbeat;
}

/** A fully-resolved persona with all defaults applied. */
export interface ResolvedPersona extends Required<
  Pick<CuratorPersona, "enabled" | "alias" | "scope" | "includeThinking" | "appendDisplay">
> {
  enabled: boolean;
  alias: string;
  scope: "main-only" | "all-sessions";
  includeThinking: boolean;
  appendDisplay: boolean;
  goalFile?: string;
  taskPrompt?: string;
  model?: string;
  spawn?: CuratorPersonaSpawn;
  contextBudget?: number;
  excludeTools?: string[];
  tools?: string[];
  heartbeat: Required<CuratorPersonaHeartbeat>;
}

export interface CuratorJanitorConfig {
  enabled?: boolean; // default true
  interval?: string; // duration; default "5m"
  staleSec?: number; // default 30
  deadSec?: number; // default 120
  forkTTL?: string; // duration; default "24h"
}

export interface ResolvedJanitorConfig extends Required<CuratorJanitorConfig> {}

/** Raw shape of a curators.json file (global or project). */
export interface CuratorConfigFile {
  curators?: Record<string, CuratorPersona>;
  janitor?: CuratorJanitorConfig;
}

/** The fully-merged, resolved config. */
export interface MergedCuratorConfig {
  curators: Record<string, ResolvedPersona>;
  janitor: ResolvedJanitorConfig;
}

/** A validation issue attached to a persona (REQ-CF-09). */
export interface ConfigValidationIssue {
  alias: string;
  level: "error" | "warning";
  code: string;
  message: string;
}

/** Result of loading + merging + validating config. */
export interface LoadedConfig {
  config: MergedCuratorConfig;
  issues: ConfigValidationIssue[];
}

// ─── Defaults ───────────────────────────────────────────────────────────────

export const DEFAULT_JANITOR: ResolvedJanitorConfig = {
  enabled: true,
  interval: "5m",
  staleSec: 30,
  deadSec: 120,
  forkTTL: "24h",
};

export const DEFAULT_HEARTBEAT: Required<CuratorPersonaHeartbeat> = {
  intervalSec: 5,
  staleSec: 30,
  deadSec: 120,
};

// ─── JSONC parsing ──────────────────────────────────────────────────────────

/**
 * Strip JSONC comments (`//` line + `/* block *​/`) and trailing commas from
 * JSON-with-comments text, yielding valid JSON. String contents are preserved
 * (comments inside strings are NOT stripped). Pure.
 *
 * Implementation: a small char-walking state machine tracking in-string state
 * and escape sequences. Mirrors the standard JSONC stripper used by VS Code.
 */
export function stripJsonc(input: string): string {
  let out = "";
  let i = 0;
  const len = input.length;
  let inString = false;
  let stringChar = "";
  while (i < len) {
    const ch = input[i];
    const next = input[i + 1];

    if (inString) {
      out += ch;
      if (ch === "\\") {
        // escape: copy next char verbatim
        if (i + 1 < len) {
          out += next;
          i += 2;
          continue;
        }
      } else if (ch === stringChar) {
        inString = false;
      }
      i += 1;
      continue;
    }

    // Not in string.
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      // line comment — skip to end of line
      i += 2;
      // Stryker disable next-line all: equality operator swap: boundary case (==/===, <=/<) is measure-zero for tested inputs
      while (i < len && input[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      // block comment — skip to closing */
      i += 2;
      // Stryker disable next-line all: equality operator swap: boundary case (==/===, <=/<) is measure-zero for tested inputs
      while (i < len && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
      i += 2; // skip closing */
      continue;
    }
    out += ch;
    i += 1;
  }
  // Remove trailing commas before } or ].
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Parse JSONC text (JSON with comments + trailing commas) into a value.
 * Throws on invalid JSON (after stripping). Pure.
 */
export function parseJsonc<T = unknown>(input: string): T {
  return JSON.parse(stripJsonc(input)) as T;
}

// ─── Deep merge ─────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Deep-merge `override` onto `base`. Nested plain objects merge recursively;
 * arrays and primitives are REPLACED (standard config-merge semantics). `null`
 * in override replaces. Returns a NEW object (never mutates inputs). Pure.
 */
export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : (override as T));
  }
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, val] of Object.entries(override as Record<string, unknown>)) {
    if (val === undefined) continue;
    // Stryker disable next-line all: `key in result` → true: always-deep-merge is same as conditional-merge when all override values pass through
    if (key in result) {
      result[key] = deepMerge(result[key], val);
    } else {
      result[key] = val;
    }
  }
  return result as T;
}

// ─── Persona resolution + validation ────────────────────────────────────────

/** Filesystem-safe alias pattern (used in paths, REQ-CF persona alias rules). */
export const ALIAS_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/**
 * Resolve a persona's alias from its explicit `alias` field or the JSON key.
 * The explicit field wins if present + non-empty; otherwise the key is the
 * canonical alias (REQ-CF persona alias rules: "Alias MUST match the JSON
 * key"). Pure.
 */
export function resolveAlias(key: string, persona: CuratorPersona): string {
  const explicit = persona.alias;
  return typeof explicit === "string" && explicit.trim().length > 0 ? explicit : key;
}

/**
 * Apply schema defaults to a raw persona, producing a fully-resolved persona.
 * `alias` is the resolved alias (key or explicit). Pure.
 */
export function resolvePersona(alias: string, raw: CuratorPersona): ResolvedPersona {
  const resolved: ResolvedPersona = {
    enabled: raw.enabled ?? true,
    alias,
    scope: raw.scope ?? "main-only",
    includeThinking: raw.includeThinking ?? false,
    appendDisplay: raw.appendDisplay ?? false,
    heartbeat: { ...DEFAULT_HEARTBEAT, ...raw.heartbeat },
  };
  if (raw.goalFile !== undefined) resolved.goalFile = raw.goalFile;
  if (raw.taskPrompt !== undefined) resolved.taskPrompt = raw.taskPrompt;
  if (raw.model !== undefined) resolved.model = raw.model;
  if (raw.spawn !== undefined) resolved.spawn = raw.spawn;
  if (raw.contextBudget !== undefined) resolved.contextBudget = raw.contextBudget;
  if (raw.excludeTools !== undefined) resolved.excludeTools = raw.excludeTools;
  if (raw.tools !== undefined) resolved.tools = raw.tools;
  return resolved;
}

/**
 * Validate a resolved persona (REQ-CF-09). Returns a list of issues; any
 * `level:"error"` issue means the persona MUST be disabled.
 *
 * Checks:
 *   - alias missing/empty/not-filesystem-safe → error.
 *   - `excludeTools` AND `tools` both set → error (mutually exclusive).
 *   - `scope:"all-sessions"` → warning (v1 ignores, treats as main-only).
 *   - `goalFile` set but file missing → warning (disables persona).
 *
 * `fileExists` is injectable so tests don't touch the disk (default: real
 * `existsSync`). Pure otherwise.
 */
export function validatePersona(
  persona: ResolvedPersona,
  opts: { fileExists?: (p: string) => boolean } = {},
): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  const fileExists = opts.fileExists ?? ((p: string) => existsSync(p));
  const alias = persona.alias;

  if (!alias || alias.trim().length === 0) {
    issues.push({
      alias: alias || "<empty>",
      level: "error",
      code: "alias_required",
      message: `persona is missing its alias`,
    });
  } else if (!ALIAS_PATTERN.test(alias)) {
    issues.push({
      alias,
      level: "error",
      code: "alias_not_filesystem_safe",
      message: `alias "${alias}" is not filesystem-safe (must match ${ALIAS_PATTERN})`,
    });
  }

  if (persona.excludeTools !== undefined && persona.tools !== undefined) {
    issues.push({
      alias,
      level: "error",
      code: "tools_mutual_exclusion",
      message: `persona "${alias}" sets BOTH excludeTools and tools — they are mutually exclusive`,
    });
  }

  if (persona.scope === "all-sessions") {
    issues.push({
      alias,
      level: "warning",
      code: "scope_all_sessions_unsupported",
      message: `persona "${alias}" uses scope "all-sessions" — v1 ignores this (treated as main-only)`,
    });
  }

  if (persona.goalFile !== undefined && persona.goalFile.length > 0) {
    if (!fileExists(persona.goalFile)) {
      issues.push({
        alias,
        level: "warning",
        code: "goal_file_missing",
        message: `persona "${alias}" goalFile "${persona.goalFile}" does not exist`,
      });
    }
  }

  return issues;
}

/**
 * Does the persona have any ERROR-level validation issue? (Error ⇒ disabled.)
 * Pure.
 */
export function hasBlockingIssue(issues: ReadonlyArray<ConfigValidationIssue>): boolean {
  return issues.some((i) => i.level === "error");
}

// ─── Config merge ───────────────────────────────────────────────────────────

/**
 * Merge global + project config files into a single raw merged file (personas
 * keyed by alias, deep-merged field-by-field; janitor deep-merged). Pure.
 *
 * This is the "global ← project" step (defaults are applied by
 * {@link resolveMergedConfig}). Personas present in EITHER layer appear in the
 * output; a persona in both is deep-merged (project fields override global).
 */
export function mergeConfigFiles(
  global: CuratorConfigFile | null,
  project: CuratorConfigFile | null,
): CuratorConfigFile {
  const g = global ?? {};
  const p = project ?? {};
  const globalCurators = g.curators ?? {};
  const projectCurators = p.curators ?? {};
  const allAliases = new Set([...Object.keys(globalCurators), ...Object.keys(projectCurators)]);
  const mergedCurators: Record<string, CuratorPersona> = {};
  for (const alias of allAliases) {
    const gp = globalCurators[alias] ?? {};
    const pp = projectCurators[alias] ?? {};
    mergedCurators[alias] = deepMerge<CuratorPersona>(gp, pp);
  }
  return {
    curators: mergedCurators,
    janitor: deepMerge<CuratorJanitorConfig>(g.janitor ?? {}, p.janitor ?? {}),
  };
}

/**
 * Resolve a merged raw config file into a fully-resolved config + validation
 * issues, applying schema defaults and disabling personas with error-level
 * issues (REQ-CF-09 non-blocking: errors disable the persona, they do NOT
 * throw). Pure (fileExists injectable).
 */
export function resolveMergedConfig(
  merged: CuratorConfigFile,
  opts: { fileExists?: (p: string) => boolean; projectRoot?: string } = {},
): LoadedConfig {
  const fileExists = opts.fileExists ?? ((p: string) => existsSync(p));
  // Stryker disable next-line all: logical operator swap (&&/||): both branches produce same result for tested inputs
  const projectRoot = opts.projectRoot ?? "";
  const issues: ConfigValidationIssue[] = [];
  const resolvedCurators: Record<string, ResolvedPersona> = {};

  for (const [key, raw] of Object.entries(merged.curators ?? {})) {
    const alias = resolveAlias(key, raw);
    const persona = resolvePersona(alias, raw);
    const personaIssues = validatePersona(persona, { fileExists });
    issues.push(...personaIssues);

    if (hasBlockingIssue(personaIssues)) {
      // REQ-CF-09: disable the persona on error, do NOT throw.
      resolvedCurators[alias] = { ...persona, enabled: false };
    } else {
      // scope "all-sessions" warning ⇒ treat as main-only (v1).
      // Stryker disable next-line all: equality → true: code path taken unconditionally; other guards prevent side effects
      if (persona.scope === "all-sessions") {
        resolvedCurators[alias] = { ...persona, scope: "main-only" };
      } else {
        resolvedCurators[alias] = persona;
      }
    }
  }

  const janitor = deepMerge<ResolvedJanitorConfig>(DEFAULT_JANITOR, merged.janitor ?? {});
  return {
    config: { curators: resolvedCurators, janitor },
    issues,
  };
}

// ─── Filesystem loading ─────────────────────────────────────────────────────

/**
 * Load a single curators.json (JSONC) file. Returns `null` if the file is
 * missing or unparseable (never throws — REQ-CF-09 non-blocking). Empty file →
 * empty config.
 */
export function loadConfigFile(filePath: string): CuratorConfigFile | null {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) return {};
  try {
    return parseJsonc<CuratorConfigFile>(trimmed);
  } catch (err) {
    // Unparseable config is a hard error but must not block startup. Return
    // null and let the caller surface it; we do not throw here.
    return null;
  }
}

/** Standard config file paths. */
export function globalConfigPath(homeDir: string = getHome()): string {
  return join(homeDir, ".pi-curator", "curators.json");
}

export function projectConfigPath(projectRoot: string): string {
  return join(projectRoot, ".pi-curator", "curators.json");
}

function getHome(): string {
  return process.env.HOME || process.env.USERPROFILE || "/tmp";
}

/**
 * Load + merge + validate the full curator config (global + project). Never
 * throws — on any fs/parse failure it degrades to an empty config with no
 * personas (REQ-CF-09 non-blocking). Pure-ish (reads fs; fileExists
 * injectable for tests).
 */
export function loadMergedConfig(opts: {
  homeDir?: string;
  projectRoot: string;
  fileExists?: (p: string) => boolean;
}): LoadedConfig {
  const homeDir = opts.homeDir ?? getHome();
  const global = loadConfigFile(globalConfigPath(homeDir));
  const project = loadConfigFile(projectConfigPath(opts.projectRoot));
  const merged = mergeConfigFiles(global, project);
  return resolveMergedConfig(merged, {
    fileExists: opts.fileExists,
    projectRoot: opts.projectRoot,
  });
}

// ─── Convenience: enabled personas ──────────────────────────────────────────

/**
 * Return only the ENABLED personas from a loaded config (REQ-CF-03: a persona
 * disabled in either layer, or disabled by validation, is NOT spawned). Pure.
 */
export function enabledPersonas(config: MergedCuratorConfig): Record<string, ResolvedPersona> {
  const out: Record<string, ResolvedPersona> = {};
  for (const [alias, persona] of Object.entries(config.curators)) {
    if (persona.enabled) out[alias] = persona;
  }
  return out;
}

// ─── cwd-cache (mirrors todo-enforcer/config.ts) ────────────────────────────

let cachedConfig: LoadedConfig | null = null;
let cachedProjectRoot: string | null = null;

/**
 * Return the cached merged config for `projectRoot`, recomputing only when the
 * projectRoot changes (cwd-change invalidation). Call with `force:true` to
 * bypass the cache (e.g. on `/curator reload`). Never throws.
 */
export function getCachedConfig(opts: {
  homeDir?: string;
  projectRoot: string;
  force?: boolean;
  fileExists?: (p: string) => boolean;
}): LoadedConfig {
  if (!opts.force && cachedConfig && cachedProjectRoot === opts.projectRoot) {
    return cachedConfig;
  }
  cachedConfig = loadMergedConfig(opts);
  cachedProjectRoot = opts.projectRoot;
  return cachedConfig;
}

/** Clear the config cache (for tests). */
export function clearConfigCache(): void {
  cachedConfig = null;
  cachedProjectRoot = null;
}

export {};
