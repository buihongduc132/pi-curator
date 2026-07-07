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
  const { persona, filteredJsonlPath, mainSessionId, mainSessionName } = input;
  const piBin = input.piBin ?? "pi";

  // REQ-CF mutual exclusion: both set is a config error. We DO NOT silently
  // pick one — we throw so the caller can log + skip the spawn (REQ-LC-10).
  if (persona.excludeTools !== undefined && persona.tools !== undefined) {
    throw new Error(
      `persona "${persona.alias}" sets BOTH excludeTools and tools — mutually exclusive (REQ-CF)`,
    );
  }

  const args: string[] = [];
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
    // Goal contents are read by the caller (needs fs); here we pass empty so
    // the placeholder collapses cleanly. Callers that want real goal contents
    // in the prompt should call resolveTaskPrompt themselves and pass via a
    // pre-resolved `taskPrompt`. For the default template we still inject it.
    goalContents: "",
  });
  args.push("-p", taskPrompt);

  if (persona.excludeTools) {
    args.push("--exclude-tools", persona.excludeTools.join(","));
  } else if (persona.tools) {
    args.push("--tools", persona.tools.join(","));
  }

  return { args, taskPrompt };
}

export {};
