/**
 * curator-main — main-side spawn hook + lifecycle (REQ-LC-01..10).
 *
 * This is the thin pi extension adapter. All behavioral logic lives in the
 * pure, unit-tested helpers:
 *   - spawn gate:        ./spawn-gate.js (REQ-LC-01)
 *   - spawn argv:        ./spawn-args.js (REQ-LC-04)
 *   - context filter:    ../util/filter-session.js (REQ-LC-02)
 *   - context trim:      ../util/trim-session.js (REQ-LC-03)
 *   - pids/staleness:    ../util/staleness.js + team-attach-claim.js (REQ-LC-05/06/07)
 *   - config:            ../util/config.js (REQ-CF)
 *
 * The hook registers on `turn_end` and:
 *   1. Loads cached config (global + project merge).
 *   2. For each ENABLED persona: evaluates the gate; if satisfied, filters +
 *      trims the session JSONL, acquires the claim slot, spawns the child
 *      (detached:false), updates the pids file.
 *   3. Reads all pids files for this session and surfaces a liveness summary
 *      via `ctx.ui.setStatus` (UI-only — never in conversation context).
 *
 * Non-blocking + exception safety (REQ-LC-10): every operation is wrapped in
 * try/catch. A failure in filter/spawn is logged to UI and the turn continues
 * without blocking.
 *
 * @ts-nocheck — pi ExtensionAPI types are optional and heavy; the adapter uses
 * a loose `any` surface to stay decoupled from a specific pi version.
 */

// @ts-nocheck

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { filterSession, parseSession } from "../util/filter-session.js";
import { trimSessionEntries, computeBudget } from "../util/trim-session.js";
import { getCachedConfig, enabledPersonas, type ResolvedPersona } from "../util/config.js";
import { evaluateSpawnGate } from "./spawn-gate.js";
import { buildSpawnArgs } from "./spawn-args.js";
import { defaultPidRoot, curatorClaimFile, acquireCuratorClaim, heartbeatCuratorClaim } from "../util/team-attach-claim.js";
import { readPidEntries, summarizeLiveness, formatLivenessStatus } from "../util/staleness.js";

const DEFAULT_PI_BIN = "pi";
const DEFAULT_FORK_ROOT = () => path.join(os.homedir(), ".pi-curator", "forks");

type AnyPi = any;
type AnyCtx = any;

function safeNotify(ctx: AnyCtx, message: string, kind: string = "info"): void {
  try {
    ctx?.ui?.notify?.(message, kind);
  } catch {
    // swallow — best-effort UI
  }
}

function safeSetStatus(ctx: AnyCtx, status: string): void {
  try {
    ctx?.ui?.setStatus?.(status);
  } catch {
    // swallow
  }
}

/**
 * Write the filtered+trimmed fork JSONL to a temp file under forksDir.
 * Returns the file path, or null on failure (REQ-LC-10 non-blocking).
 */
function writeForkFile(
  sessionJsonl: string,
  persona: ResolvedPersona,
  forksDir: string,
): string | null {
  try {
    const { header, entries } = parseSession(sessionJsonl);
    const filtered = filterSession(sessionJsonl, { includeThinking: persona.includeThinking });
    // Re-parse filtered output to get entries for trim (filterSession returns text).
    const reparsed = parseSession(filtered);
    const contextWindow = persona.contextBudget ?? 128_000;
    const budget = persona.contextBudget
      ? persona.contextBudget
      : computeBudget(contextWindow);
    const trimmed = trimSessionEntries(reparsed.entries, { budget });

    const lines: string[] = [];
    if (header) lines.push(JSON.stringify(header));
    for (const e of trimmed.entries) lines.push(JSON.stringify(e));
    const out = lines.length === 0 ? "" : lines.join("\n") + "\n";

    fs.mkdirSync(forksDir, { recursive: true });
    const forkPath = path.join(
      forksDir,
      `${persona.alias}-${Date.now()}-${process.pid}.jsonl`,
    );
    fs.writeFileSync(forkPath, out, "utf8");
    return forkPath;
  } catch (err) {
    return null;
  }
}

/**
 * The turn_end handler. Pure-effect (async, no return value). Never throws —
 * REQ-LC-10. Wrapped in try/catch at the registration boundary.
 */
export async function handleTurnEnd(
  pi: AnyPi,
  ctx: AnyCtx,
  deps: {
    projectRoot: string;
    mainSessionId: string;
    mainSessionName?: string;
    sessionJsonlPath: string;
    piBin?: string;
    pidRoot?: string;
    forksDir?: string;
    // Test seam: injected spawn (default real child_process.spawn).
    spawnFn?: typeof spawn;
    // Per-persona spawn counters (mutated in place).
    lastSpawn?: Record<string, { turn: number; atMs: number }>;
    turnNumber?: number;
  },
): Promise<void> {
  const projectRoot = deps.projectRoot;
  const mainSessionId = deps.mainSessionId;
  const mainSessionName = deps.mainSessionName;
  const piBin = deps.piBin ?? DEFAULT_PI_BIN;
  const pidRoot = deps.pidRoot ?? defaultPidRoot();
  const forksDir = deps.forksDir ?? DEFAULT_FORK_ROOT();
  const spawnFn = deps.spawnFn ?? spawn;
  const turnNumber = deps.turnNumber ?? 0;
  const lastSpawn = deps.lastSpawn ?? {};

  // 1. Load config (cached, never throws).
  let loaded;
  try {
    loaded = getCachedConfig({ projectRoot });
  } catch (err) {
    safeNotify(ctx, `curator: config load failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    return;
  }

  const personas = enabledPersonas(loaded.config);

  // 2. Per-persona spawn evaluation.
  for (const persona of Object.values(personas)) {
    const last = lastSpawn[persona.alias];
    const turnsSince = last ? turnNumber - last.turn : Number.MAX_SAFE_INTEGER;
    const minsSince = last ? (Date.now() - last.atMs) / 60_000 : Number.MAX_SAFE_INTEGER;

    const gate = evaluateSpawnGate({ persona, turnsSinceLastSpawn: turnsSince, minsSinceLastSpawn: minsSince });
    if (!gate.spawn) continue;

    // Exclusivity (REQ-LC-07): acquire the claim slot before spawning.
    const claimPath = curatorClaimFile(pidRoot, mainSessionId, persona.alias);

    // Filter + trim session to fork file (REQ-LC-02/03).
    let sessionJsonl = "";
    try {
      sessionJsonl = fs.readFileSync(deps.sessionJsonlPath, "utf8");
    } catch {
      safeNotify(ctx, `curator: could not read session JSONL at ${deps.sessionJsonlPath}`, "error");
      continue;
    }
    const forkPath = writeForkFile(sessionJsonl, persona, forksDir);
    if (!forkPath) {
      safeNotify(ctx, `curator: fork filter failed for ${persona.alias} (skipped)`, "error");
      continue;
    }

    // Acquire claim with parent pid as placeholder; updated after spawn.
    let acquireResult;
    try {
      acquireResult = await acquireCuratorClaim(claimPath, {
        pid: process.pid,
        mainSessionId,
        curator: persona.alias,
        mainSessionName,
        goalFile: persona.goalFile,
      });
    } catch (err) {
      safeNotify(ctx, `curator: claim acquire failed for ${persona.alias}: ${err instanceof Error ? err.message : String(err)}`, "error");
      continue;
    }
    if (!acquireResult.ok) {
      // Slot held by a live/stale curator — skip (REQ-LC-07).
      continue;
    }

    // Build argv + spawn (REQ-LC-04, detached:false).
    let args;
    try {
      args = buildSpawnArgs({ persona, filteredJsonlPath: forkPath, mainSessionId, mainSessionName, piBin });
    } catch (err) {
      safeNotify(ctx, `curator: argv build failed for ${persona.alias}: ${err instanceof Error ? err.message : String(err)}`, "error");
      continue;
    }

    let child;
    try {
      child = spawnFn(piBin, args, {
        detached: false,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch (err) {
      safeNotify(ctx, `curator: spawn failed for ${persona.alias}: ${err instanceof Error ? err.message : String(err)}`, "error");
      continue;
    }

    // Update the claim with the real child pid + phase "spawned" (REQ-LC-05).
    if (child?.pid) {
      try {
        await heartbeatCuratorClaim(claimPath, child.pid, { phase: "spawned" });
      } catch {
        // non-fatal — claim already written with placeholder pid
      }
    }

    lastSpawn[persona.alias] = { turn: turnNumber, atMs: Date.now() };
    safeNotify(ctx, `curator: spawned curator:${persona.alias} (pid ${child?.pid ?? "?"})`, "info");

    // Child dies with parent (detached:false). Best-effort error log.
    child?.on?.("error", (err: unknown) => {
      safeNotify(ctx, `curator: curator:${persona.alias} error: ${err instanceof Error ? err.message : String(err)}`, "error");
    });
  }

  // 3. Staleness summary via UI (REQ-LC-06, UI-only).
  try {
    const sessionPidsDir = path.join(pidRoot, mainSessionId);
    const entries = await readPidEntries(sessionPidsDir, { checkPid: true });
    const summary = summarizeLiveness(entries);
    safeSetStatus(ctx, formatLivenessStatus(summary));
  } catch {
    // non-fatal
  }
}

/**
 * pi extension entry point. Registers the `turn_end` hook (REQ-LC-01) and
 * delegates to {@link handleTurnEnd}. Wrapped in try/catch (REQ-LC-10).
 */
export default function curatorMainExtension(pi: AnyPi, _ctx?: AnyCtx): void {
  // Per-session spawn counters (turn → atMs). Held in module scope so the hook
  // closure mutates them across turns.
  const lastSpawn: Record<string, { turn: number; atMs: number }> = {};
  let turnCounter = 0;

  pi.on?.("turn_end", async (event: unknown, ctx: AnyCtx) => {
    try {
      turnCounter += 1;
      const projectRoot = ctx?.cwd ?? process.cwd();
      const mainSessionId =
        ctx?.sessionId ?? ctx?.session?.id ?? `pid-${process.pid}`;
      const mainSessionName = ctx?.sessionName ?? ctx?.session?.name;
      const sessionJsonlPath =
        ctx?.sessionFile ?? ctx?.session?.file ?? path.join(projectRoot, ".pi", "session.jsonl");

      await handleTurnEnd(pi, ctx, {
        projectRoot,
        mainSessionId,
        mainSessionName,
        sessionJsonlPath,
        lastSpawn,
        turnNumber: turnCounter,
      });
    } catch (err) {
      // REQ-LC-10: NEVER let the hook crash the main turn.
      try {
        _ctx?.ui?.notify?.(
          `curator: turn_end handler crashed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      } catch {
        // swallow
      }
    }
  });
}

export {};
