/**
 * slash-commands.ts — `/curator` slash family (REQ-LC-09).
 *
 * Commands:
 *   - `/curator list`                — list configured personas (alias + enabled + spawn gate)
 *   - `/curator status`              — show liveness of all curators for this main session
 *   - `/curator kill <alias>`        — SIGTERM the curator + mark phase "killed"
 *   - `/curator restart <alias>`     — kill + re-evaluate spawn gate (force re-spawn)
 *   - `/curator reload`              — clear config cache + re-read global + project
 *
 * ## Design: pure parser + thin adapter
 *
 * `parseCommand(input)` is pure — it takes the raw slash input string (e.g.
 * "kill spec") and returns a structured `{cmd, args}` or a parse error. All
 * testable without pi.
 *
 * `registerSlashCommands(pi, deps)` is the thin adapter that wires the parser
 * into pi's slash command registration. It delegates to the behavioral helpers
 * (kill, restart, reload, list, status) which are also pure-ish (take injected
 * deps) so they are unit-testable.
 *
 * @ts-nocheck — pi ExtensionAPI types are optional and heavy.
 */

// @ts-nocheck

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { getCachedConfig, enabledPersonas, clearConfigCache, type MergedCuratorConfig, type ResolvedPersona } from "../util/config.js";
import { readPidEntries, summarizeLiveness, formatLivenessStatus, type StalePidEntry } from "../util/staleness.js";
import { defaultPidRoot, curatorClaimFile, readCuratorClaim, writeCuratorClaim } from "../util/team-attach-claim.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Valid slash sub-commands. */
export type SlashCmd = "list" | "status" | "kill" | "restart" | "reload" | "help";

/** Parsed slash command result. */
export type ParsedSlash =
  | { ok: true; cmd: SlashCmd; args: string[] }
  | { ok: false; error: string };

/** Valid sub-command names (for parseCommand validation). */
export const VALID_COMMANDS: ReadonlyArray<SlashCmd> = [
  "list",
  "status",
  "kill",
  "restart",
  "reload",
  "help",
];

/** Commands that require exactly one alias argument. */
export const REQUIRES_ALIAS: ReadonlyArray<SlashCmd> = ["kill", "restart"];

/** Commands that take no arguments. */
export const NO_ARGS: ReadonlyArray<SlashCmd> = ["list", "status", "reload", "help"];

// ─── Pure parser ────────────────────────────────────────────────────────────

/**
 * Parse a `/curator` slash command input (everything after the leading
 * `/curator `). Returns `{ok:true, cmd, args}` on success, or
 * `{ok:false, error}` on failure.
 *
 * Rules:
 * - Empty / whitespace-only → `help` (graceful default).
 * - First token must be a valid sub-command (case-insensitive).
 * - `kill` / `restart` require exactly one alias arg (the persona alias).
 * - `list` / `status` / `reload` / `help` take no args (extras are ignored).
 * - Alias must match the ALIAS_PATTERN from config.ts (alphanumeric + hyphens/underscores).
 */
export function parseCommand(input: string): ParsedSlash {
  const trimmed = (input ?? "").trim();
  if (!trimmed) {
    return { ok: true, cmd: "help", args: [] };
  }

  const tokens = trimmed.split(/\s+/);
  const rawCmd = tokens[0]!.toLowerCase();

  if (!VALID_COMMANDS.includes(rawCmd as SlashCmd)) {
    return {
      ok: false,
      error: `unknown command "${rawCmd}". Valid: ${VALID_COMMANDS.join(", ")}`,
    };
  }
  const cmd = rawCmd as SlashCmd;

  const rest = tokens.slice(1);

  if (REQUIRES_ALIAS.includes(cmd)) {
    if (rest.length === 0) {
      return {
        ok: false,
        error: `"${cmd}" requires a curator alias. Usage: /curator ${cmd} <alias>`,
      };
    }
    const alias = rest[0]!;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(alias)) {
      return {
        ok: false,
        error: `invalid alias "${alias}". Must match [a-zA-Z0-9][a-zA-Z0-9_-]*`,
      };
    }
    return { ok: true, cmd, args: [alias] };
  }

  // No-args commands: ignore extras.
  return { ok: true, cmd, args: [] };
}

// ─── Behavioral helpers (pure-ish, injected deps) ──────────────────────────

/** Result of a kill/restart operation. */
export type KillResult =
  | { ok: true; action: "killed"; alias: string; pid: number }
  | { ok: true; action: "already_dead"; alias: string }
  | { ok: true; action: "no_claim"; alias: string }
  | { ok: false; error: string };

/** Result of a restart operation. */
export type RestartResult =
  | { ok: true; action: "restarted"; alias: string; newPid: number }
  | { ok: true; action: "killed_only"; alias: string; reason: string }
  | { ok: false; error: string };

/**
 * Kill a curator by alias: SIGTERM the process + mark the claim phase "killed"
 * (REQ-LC-09). Pure-ish: takes the pid dir + main session id + a kill
 * function (default `process.kill`) so it's testable without real processes.
 */
export async function killCurator(
  alias: string,
  deps: {
    pidRoot?: string;
    mainSessionId: string;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
  },
): Promise<KillResult> {
  const pidRoot = deps.pidRoot ?? defaultPidRoot();
  const claimPath = curatorClaimFile(pidRoot, deps.mainSessionId, alias);
  const kill = deps.kill ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig));

  const claim = await readCuratorClaim(claimPath);
  if (!claim) {
    return { ok: true, action: "no_claim", alias };
  }

  // Mark phase "killed" before sending SIGTERM (so the janitor sees it).
  try {
    await writeCuratorClaim(claimPath, { ...claim, phase: "killed" });
  } catch {
    // best-effort; the SIGTERM is the primary action
  }

  try {
    kill(claim.pid, "SIGTERM");
  } catch (err) {
    // ESRCH = process already gone → that's fine.
    if (err instanceof Error && "code" in err && (err as any).code === "ESRCH") {
      return { ok: true, action: "already_dead", alias };
    }
    return {
      ok: false,
      error: `SIGTERM failed for ${alias} (pid ${claim.pid}): ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { ok: true, action: "killed", alias, pid: claim.pid };
}

/**
 * Restart a curator: kill the existing one, then re-evaluate the spawn gate
 * (force it open by resetting the last-spawn counter). Returns the result of
 * the kill + a note about whether a re-spawn was triggered.
 *
 * The actual re-spawn is delegated to the caller (the main hook's turn_end
 * handler) — this function just resets the gate so the next turn_end will
 * spawn a fresh curator. REQ-LC-09.
 */
export async function restartCurator(
  alias: string,
  deps: {
    pidRoot?: string;
    mainSessionId: string;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    /** Callback to reset the last-spawn counter for this alias (so gate re-evaluates). */
    resetSpawnCounter?: (alias: string) => void;
  },
): Promise<RestartResult> {
  const killResult = await killCurator(alias, deps);
  if (!killResult.ok) {
    return { ok: false, error: killResult.error };
  }

  // Reset the spawn counter so the next turn_end hook re-evaluates the gate.
  if (deps.resetSpawnCounter) {
    deps.resetSpawnCounter(alias);
  }

  if (killResult.action === "killed") {
    return {
      ok: true,
      action: "killed_only",
      alias,
      reason: `curator ${alias} killed (pid ${killResult.pid}); will re-spawn on next turn_end`,
    };
  }
  if (killResult.action === "already_dead" || killResult.action === "no_claim") {
    return {
      ok: true,
      action: "killed_only",
      alias,
      reason: `curator ${alias} was not running; gate reset — will spawn on next turn_end`,
    };
  }
  return { ok: false, error: `unexpected kill result for ${alias}` };
}

/**
 * Format the `/curator list` output: one line per enabled persona with alias,
 * spawn gate config, and model. Pure.
 */
export function formatListOutput(config: MergedCuratorConfig): string {
  const personas = enabledPersonas(config);
  const entries = Object.values(personas);
  if (entries.length === 0) {
    return "No enabled curator personas configured.";
  }
  const lines = entries.map((p) => {
    const gate = formatGateSummary(p);
    const model = p.model ?? "(main's model)";
    return `  ${p.alias}  [${gate}]  model=${model}  goal=${p.goalFile ?? "(none)"}`;
  });
  return `Curator personas (${entries.length} enabled):\n${lines.join("\n")}`;
}

function formatGateSummary(p: ResolvedPersona): string {
  const turns = p.spawn?.everyTurns;
  const mins = p.spawn?.everyMins;
  const parts: string[] = [];
  if (typeof turns === "number") parts.push(`every ${turns} turns`);
  if (typeof mins === "number") parts.push(`every ${mins}m`);
  return parts.length > 0 ? parts.join(", ") : "no gate";
}

/**
 * Format the `/curator status` output from liveness entries. Pure.
 */
export function formatStatusOutput(entries: StalePidEntry[]): string {
  if (entries.length === 0) {
    return "No curator registrations found.";
  }
  const summary = summarizeLiveness(entries);
  const lines = entries.map((e) => {
    const base = `  ${e.curator}  pid=${e.pid}  ${e.liveness}  age=${(e.ageMs / 1000).toFixed(1)}s  phase=${e.phase}`;
    // LD1: render the curatorSessionId pointer link when present (one-click
    // jump to the curator's session). Legacy entries (no pointer) omit it so
    // no stray arrow appears.
    return e.curatorSessionId ? `${base}  curator:${e.curator} → ${e.curatorSessionId}` : base;
  });
  return `Curator status (${summary.live} live, ${summary.stale} stale, ${summary.dead} dead):\n${lines.join("\n")}`;
}

/**
 * Format the `/curator help` output. Pure.
 */
export function formatHelp(): string {
  return [
    "Usage: /curator <command> [args]",
    "",
    "Commands:",
    "  list              List configured curator personas",
    "  status            Show liveness of all curators for this session",
    "  kill <alias>      SIGTERM a curator + mark phase 'killed'",
    "  restart <alias>   Kill + re-evaluate spawn gate (force re-spawn)",
    "  reload            Clear config cache + re-read global + project",
    "  help              Show this help",
  ].join("\n");
}

// ─── pi extension adapter ───────────────────────────────────────────────────

type AnyPi = any;
type AnyCtx = any;

/**
 * Register the `/curator` slash family with the pi ExtensionAPI.
 *
 * The adapter is a thin glue layer — it reads the slash input, parses it, and
 * dispatches to the behavioral helpers. All exceptions are caught and logged
 * to the UI (REQ-LC-10 non-blocking).
 */
export function registerSlashCommands(pi: AnyPi, ctx?: AnyCtx): void {
  // pi.registerSlashCommand(name, handler) — the handler receives the raw
  // input string (everything after `/curator `).
  pi.registerSlashCommand?.("curator", async (input: string, slashCtx: AnyCtx) => {
    const effectiveCtx = slashCtx ?? ctx;
    try {
      const parsed = parseCommand(input);
      if (!parsed.ok) {
        effectiveCtx?.ui?.notify?.(parsed.error, "error");
        return;
      }

      const projectRoot = effectiveCtx?.cwd ?? process.cwd();
      const mainSessionId =
        effectiveCtx?.sessionId ?? effectiveCtx?.session?.id ?? `pid-${process.pid}`;

      switch (parsed.cmd) {
        case "help":
          effectiveCtx?.ui?.notify?.(formatHelp(), "info");
          return;

        case "list": {
          const loaded = getCachedConfig({ projectRoot });
          effectiveCtx?.ui?.notify?.(formatListOutput(loaded.config), "info");
          return;
        }

        case "status": {
          const pidRoot = defaultPidRoot();
          const sessionDir = path.join(pidRoot, mainSessionId);
          const entries = await readPidEntries(sessionDir, { checkPid: true });
          effectiveCtx?.ui?.notify?.(formatStatusOutput(entries), "info");
          return;
        }

        case "kill": {
          const alias = parsed.args[0]!;
          const result = await killCurator(alias, { mainSessionId });
          if (!result.ok) {
            effectiveCtx?.ui?.notify?.(result.error, "error");
            return;
          }
          const msg =
            result.action === "killed"
              ? `curator ${alias} killed (pid ${result.pid})`
              : result.action === "already_dead"
              ? `curator ${alias} was already dead`
              : `no claim found for ${alias}`;
          effectiveCtx?.ui?.notify?.(msg, "info");
          return;
        }

        case "restart": {
          const alias = parsed.args[0]!;
          // Reset the spawn counter in the main hook's closure. We can't reach
          // into the main hook's `lastSpawn` map from here, so we use a
          // file-based signal: write a "restart-requested" marker that the
          // main hook checks on the next turn_end.
          const result = await restartCurator(alias, {
            mainSessionId,
            resetSpawnCounter: (a) => {
              // Write a marker file that the main hook reads on next turn_end.
              const markerDir = path.join(
                os.homedir(),
                ".pi-curator",
                "restart-markers",
                mainSessionId,
              );
              try {
                fs.mkdirSync(markerDir, { recursive: true });
                fs.writeFileSync(
                  path.join(markerDir, `${a}.json`),
                  JSON.stringify({ alias: a, at: Date.now() }),
                  "utf8",
                );
              } catch {
                // non-fatal — the restart will happen on the next gate cycle
              }
            },
          });
          if (!result.ok) {
            effectiveCtx?.ui?.notify?.(result.error, "error");
            return;
          }
          effectiveCtx?.ui?.notify?.(result.reason, "info");
          return;
        }

        case "reload": {
          clearConfigCache();
          effectiveCtx?.ui?.notify?.("curator config cache cleared — re-read on next turn", "info");
          return;
        }
      }
    } catch (err) {
      // REQ-LC-10: NEVER let the slash command crash the main session.
      try {
        effectiveCtx?.ui?.notify?.(
          `/curator handler crashed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      } catch {
        // swallow
      }
    }
  });
}

/**
 * pi extension entry point. Registers the `/curator` slash family.
 */
export default function curatorSlashExtension(pi: AnyPi, ctx?: AnyCtx): void {
  registerSlashCommands(pi, ctx);
}

export {};
