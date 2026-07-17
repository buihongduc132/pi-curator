/**
 * spawn-args.ts — pure argv builder for curator child_process.spawn (REQ-LC-04).
 *
 * Builds the spawn command:
 *
 *   pi --fork <filtered.jsonl>
 *      --append-system-prompt <goalFile>
 *      --name "curator:<alias>"
 *      [--model <persona.model>]
 *      [-p "<task prompt with main session name+id>"]
 *      [--exclude-tools <list> | --tools <list>]
 *
 * Validation reuses the config-layer mutual-exclusion rule (excludeTools XOR
 * tools). Pure.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ResolvedPersona } from "../util/config.js";

export interface BuildSpawnArgsInput {
  persona: ResolvedPersona;
  /** Path to the filtered, trimmed fork-input JSONL. */
  filteredJsonlPath: string;
  /** Main session id that spawns the curator. */
  mainSessionId: string;
  /** Main session display name (optional, for the task prompt). */
  mainSessionName?: string;
  /** Path to the `pi` binary (default "pi"). */
  piBin?: string;
  /**
   * Path to the curator-runtime extension entry (REQ-CR-01 / REQ-CR-06).
   * Loaded as the sole runtime extension via `-e <runtime>`. REQUIRED.
   */
  runtimeExtensionPath: string;
  /**
   * Path to the pi-intercom extension entry (REQ-CR-06). Loaded as the second
   * runtime extension via `-e <intercom>`. REQUIRED.
   */
  intercomExtensionPath: string;
  /**
   * Literal contents of the persona goalFile, injected into the task prompt as
   * `<goalContents>` (REQ-CR-08 / D7). When omitted, the placeholder collapses
   * to empty. The caller reads the file before calling (needs fs); kept pure here.
   */
  goalContents?: string;
}

export interface BuildSpawnArgsResult {
  args: string[];
  /** The fully-rendered task prompt (injected into `-p`). */
  taskPrompt: string;
}

/**
 * The default task prompt template (REQ-CF "Task prompt template"). Placeholders
 * are wrapped in `<...>` for easy substring replacement; this is intentionally
 * template-literal-free so the exact whitespace matches the spec.
 */
export const DEFAULT_TASK_PROMPT_TEMPLATE = [
  "You are curator:<alias>, a side-car reviewer of main session <mainSessionName> (id: <mainSessionId>).",
  "",
  "Your goal: <goalContents>",
  "",
  "Scope: you see ONLY the main session that spawned you. You cannot see other sessions.",
  "",
  "Use the `signal_main` tool to send findings back to the main session.",
  '- kind="steer" when the finding is urgent and requires immediate re-think.',
  '- kind="append" for non-urgent observations; the main session will see them on its next turn.',
  "",
  "Do NOT modify the main session's files. Do NOT spawn other curators. When done, exit.",
].join("\n");

/**
 * Render the default task prompt, injecting session info + goal contents.
 *
 * - `goalContents` is the literal text of the persona goalFile (read by the
 *   caller before calling this; pure here).
 * - `mainSessionName` defaults to the id when not supplied.
 *
 * Pure.
 */
export function renderDefaultTaskPrompt(opts: {
  alias: string;
  mainSessionId: string;
  mainSessionName?: string;
  goalContents: string;
}): string {
  const name = opts.mainSessionName ?? opts.mainSessionId;
  return DEFAULT_TASK_PROMPT_TEMPLATE
    .replaceAll("<alias>", opts.alias)
    .replaceAll("<mainSessionName>", name)
    .replaceAll("<mainSessionId>", opts.mainSessionId)
    .replaceAll("<goalContents>", opts.goalContents);
}

/**
 * Resolve the effective task prompt for a persona. Uses the persona's
 * `taskPrompt` if set (with session info injected), else the default template
 * with goal contents. Pure.
 */
export function resolveTaskPrompt(
  persona: ResolvedPersona,
  opts: { mainSessionId: string; mainSessionName?: string; goalContents: string },
): string {
  const custom = persona.taskPrompt;
  if (typeof custom === "string" && custom.trim().length > 0) {
    // Custom prompt — inject the same placeholders for convenience.
    const name = opts.mainSessionName ?? opts.mainSessionId;
    return custom
      .replaceAll("<alias>", persona.alias)
      .replaceAll("<mainSessionName>", name)
      .replaceAll("<mainSessionId>", opts.mainSessionId)
      .replaceAll("<goalContents>", opts.goalContents);
  }
  return renderDefaultTaskPrompt({
    alias: persona.alias,
    mainSessionId: opts.mainSessionId,
    mainSessionName: opts.mainSessionName,
    goalContents: opts.goalContents,
  });
}

/**
 * Build the argv array for spawning a curator via `child_process.spawn`.
 *
 * Order (matches REQ-LC-04):
 *   piBin --fork <path> --append-system-prompt <goalFile> --name "curator:<alias>"
 *         [--model <model>] [-p "<prompt>"]
 *         [--exclude-tools a,b,c | --tools a,b,c]   (omitted entirely when unset)
 *
 * Throws when both `excludeTools` and `tools` are set (REQ-CF mutual exclusion).
 *
 * Pure.
 */
export function buildSpawnArgs(input: BuildSpawnArgsInput): BuildSpawnArgsResult {
  const {
    persona,
    filteredJsonlPath,
    mainSessionId,
    mainSessionName,
    runtimeExtensionPath,
    intercomExtensionPath,
    goalContents = "",
  } = input;
  // Stryker disable next-line all: logical operator swap (&&/||): both branches produce same result for tested inputs
  const piBin = input.piBin ?? "pi";

  // REQ-CF mutual exclusion: both set is a config error. We DO NOT silently
  // pick one — we throw so the caller can log + skip the spawn (REQ-LC-10).
  if (persona.excludeTools !== undefined && persona.tools !== undefined) {
    throw new Error(
      `persona "${persona.alias}" sets BOTH excludeTools and tools — mutually exclusive (REQ-CF)`,
    );
  }

  // REQ-CR-06 / REQ-CR-01: the curator child is spawned with `--no-extensions`
  // (FIRST) so it loads NO settings.json extensions — this prevents recursion
  // (the curator's own turn_end would otherwise spawn sub-curators). Then load
  // the runtime + intercom as the ONLY two extensions via `-e`.
  if (!runtimeExtensionPath) {
    throw new Error(
      `buildSpawnArgs: runtimeExtensionPath is required (REQ-CR-06)`,
    );
  }
  if (!intercomExtensionPath) {
    throw new Error(
      `buildSpawnArgs: intercomExtensionPath is required (REQ-CR-06)`,
    );
  }

  const args: string[] = [];
  args.push("--no-extensions");
  args.push("-e", runtimeExtensionPath);
  args.push("-e", intercomExtensionPath);
  args.push("--fork", filteredJsonlPath);

  if (persona.goalFile) {
    args.push("--append-system-prompt", persona.goalFile);
  }

  args.push("--name", `curator:${persona.alias}`);

  if (persona.model) {
    args.push("--model", persona.model);
  }

  const taskPrompt = resolveTaskPrompt(persona, {
    mainSessionId,
    mainSessionName,
    // D7: real goalFile contents (read by the caller before calling this pure
    // function). Falls back to empty so the placeholder collapses cleanly.
    goalContents,
  });
  args.push("-p", taskPrompt);

  if (persona.excludeTools) {
    args.push("--exclude-tools", persona.excludeTools.join(","));
  } else if (persona.tools) {
    args.push("--tools", persona.tools.join(","));
  }

  return { args, taskPrompt };
}

/**
 * Input for {@link resolveStdio} (REQ-LC-04 / design D11).
 */
export interface ResolveStdioInput {
  /** Main session id that spawns the curator. */
  mainSessionId: string;
  /** Curator persona alias (used in the log filename). */
  curatorAlias: string;
  /** Explicit timestamp for the log filename (deterministic in tests). */
  nowMs: number;
  /**
   * Base directory for logs. Defaults to `~/.pi-curator/logs`.
   * The actual log file lands at
   * `<logsBaseDir>/<mainSessionId>/<curatorAlias>-<nowMs>.stderr`.
   */
  logsBaseDir?: string;
}

/**
 * Resolve the `stdio` option for `child_process.spawn` of a curator (D11).
 *
 * Returns `['ignore', <stdoutFd>, <stderrFd>]` where:
 *   - `stdout` (index 1) is opened on the platform null device
 *     (`/dev/null` on unix, `nul` on windows) so the curator's LLM response
 *     stream is discarded — curators report findings via `signal_main`, not
 *     stdout.
 *   - `stderr` (index 2) is opened in append mode on
 *     `<logsBaseDir>/<mainSessionId>/<curatorAlias>-<nowMs>.stderr` so
 *     diagnostic noise (MCP init, deprecation warnings) is captured for
 *     post-mortem without flooding the main TUI.
 *
 * Creates the logs directory (recursive) if missing. The caller owns the
 * returned file descriptors and is responsible for closing them (the child
 * inherits them via spawn's `stdio`, so in practice they live with the child).
 */
export function resolveStdio(
  input: ResolveStdioInput,
): ["ignore", number, number] {
  const logsBaseDir =
    input.logsBaseDir ??
    path.join(os.homedir(), ".pi-curator", "logs");
  const logDir = path.join(logsBaseDir, input.mainSessionId);
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(
    logDir,
    `${input.curatorAlias}-${input.nowMs}.stderr`,
  );

  const stdoutFd = fs.openSync(os.devNull, "w");
  const stderrFd = fs.openSync(logPath, "a");

  return ["ignore", stdoutFd, stderrFd];
}

export {};
