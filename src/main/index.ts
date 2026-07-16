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
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { filterSession, parseSession } from "../util/filter-session.js";
import { trimSessionEntries, computeBudget } from "../util/trim-session.js";
import { getCachedConfig, enabledPersonas, type ResolvedPersona } from "../util/config.js";
import { evaluateSpawnGate } from "./spawn-gate.js";
import { buildSpawnArgs, resolveStdio } from "./spawn-args.js";
import {
  defaultPidRoot,
  curatorClaimFile,
  acquireCuratorClaim,
  seedCuratorPid,
} from "../util/team-attach-claim.js";
import { readPidEntries, summarizeLiveness, formatLivenessStatus } from "../util/staleness.js";

const DEFAULT_PI_BIN = "pi";
const DEFAULT_FORK_ROOT = () => path.join(os.homedir(), ".pi-curator", "forks");

/**
 * Env flag set by the main-side pi-curator extension when it loads in this
 * process. The curator runtime reads it to detect the misconfiguration where
 * the main-side extension is also loaded in a curator child (REQ-CR-06
 * defensive check). It is stripped from the spawn env (see {@link
 * buildChildEnv}) so a correctly-spawned curator child never inherits it.
 */
export const MAIN_EXTENSION_LOADED_FLAG = "PI_CURATOR_MAIN_EXTENSION_LOADED";

const _moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the curator-runtime extension entry path (REQ-CR-06). The runtime
 * lives at `src/runtime/index.ts` relative to this `src/main` directory when
 * the package is consumed from source; falls back to the compiled `dist/`
 * layout when present.
 */
export function resolveRuntimeExtensionPath(here: string = _moduleDir): string {
  const srcCandidate = path.resolve(here, "..", "runtime", "index.ts");
  if (fs.existsSync(srcCandidate)) return srcCandidate;
  const distCandidate = path.resolve(here, "..", "runtime", "index.js");
  return distCandidate;
}

/**
 * Resolve the pi-intercom extension entry path (REQ-CR-06). Best-effort: env
 * override → package resolution → node_modules probe → git-sourced sibling
 * walk-up probe. Returns `undefined` when no install is discoverable so the
 * caller can surface a clear error.
 *
 * `here` defaults to this module's directory and is overridable for tests. It
 * seeds BOTH the node_modules probe (relative to `here`) and the git-sourced
 * sibling walk-up (pi installs git-sourced extensions as sibling package dirs
 * under a shared owner dir, e.g.
 * `~/.pi/agent/git/github.com/<owner>/{pi-curator,pi-intercom}`).
 */
export function resolveIntercomExtensionPath(here: string = _moduleDir): string | undefined {
  if (process.env.PI_INTERCOM_EXTENSION_PATH) return process.env.PI_INTERCOM_EXTENSION_PATH;
  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve("pi-intercom");
    if (typeof resolved === "string" && resolved.length > 0) return resolved;
  } catch {
    // not resolvable via Node resolution — fall through to the probes.
  }
  // npm-style install: <pkgRoot>/node_modules/pi-intercom/index.{ts,js}.
  const nmProbes = [
    path.resolve(here, "..", "..", "node_modules", "pi-intercom", "index.ts"),
    path.resolve(here, "..", "..", "node_modules", "pi-intercom", "index.js"),
  ];
  for (const p of nmProbes) {
    if (fs.existsSync(p)) return p;
  }
  // Git-sourced sibling layout: walk up from `here` looking for an ancestor
  // dir that contains a sibling `pi-intercom/index.{ts,js}`. Bounded walk
  // (stops at filesystem root or after MAX_WALK_UP levels) so a deeply nested
  // dev tree never scans the whole disk.
  const MAX_WALK_UP = 10;
  const siblingRel = ["pi-intercom", "index.ts"];
  const siblingRelJs = ["pi-intercom", "index.js"];
  let dir = here;
  for (let i = 0; i < MAX_WALK_UP; i++) {
    const tsCandidate = path.join(dir, ...siblingRel);
    if (fs.existsSync(tsCandidate)) return tsCandidate;
    const jsCandidate = path.join(dir, ...siblingRelJs);
    if (fs.existsSync(jsCandidate)) return jsCandidate;
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root.
    dir = parent;
  }
  return undefined;
}

/**
 * Test seam for {@link resolveIntercomExtensionPath}. Production code uses the
 * real resolver; tests swap this to force the "unresolvable" branch
 * deterministically instead of relying on the dev environment happening to
 * lack a sibling pi-intercom install (which the walk-up probe would find).
 */
let _resolveIntercomExtensionPath: () => string | undefined = resolveIntercomExtensionPath;
export function __setIntercomResolverForTest(fn?: () => string | undefined): void {
  _resolveIntercomExtensionPath = fn ?? resolveIntercomExtensionPath;
}


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
 * Read the persona goalFile contents (D7). Returns "" on any failure
 * (missing/unreadable file) so the spawn never blocks on a goal read.
 */
function readGoalContents(goalFile: string | undefined): string {
  if (!goalFile) return "";
  try {
    return fs.readFileSync(goalFile, "utf8");
  } catch {
    return "";
  }
}

/**
 * Build the curator child process env (D4). Spreads the parent env, overlays
 * the curator identity so {@link readCuratorIdentity} in the runtime succeeds,
 * and STRIPS {@link MAIN_EXTENSION_LOADED_FLAG} so a correctly-spawned curator
 * child (loaded with `--no-extensions`) does NOT carry the parent's main-side
 * marker (REQ-CR-06 defensive check).
 */
export function buildChildEnv(
  personaAlias: string,
  mainSessionId: string,
  mainSessionName: string | undefined,
  nowMs: number = Date.now(),
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parentEnv };
  env.PI_CURATOR_ALIAS = personaAlias;
  env.PI_CURATOR_MAIN_ID = mainSessionId;
  env.PI_CURATOR_MAIN_NAME = mainSessionName && mainSessionName.length > 0 ? mainSessionName : mainSessionId;
  env.PI_CURATOR_SPAWNED_AT = new Date(nowMs).toISOString();
  // Strip the main-side marker so the child's runtime defensive check does
  // not false-positive on an inherited flag.
  delete env[MAIN_EXTENSION_LOADED_FLAG];
  return env;
}

/**
 * Process `/curator restart` markers (D6). Scans the restart-markers dir for
 * this main session; for every marker present, resets the per-persona spawn
 * counter (deletes the record) and removes the marker file so the curator
 * re-spawns on the NEXT turn_end (the gate then sees turnsSince=MAX_INT).
 */
export function processRestartMarkers(
  mainSessionId: string,
  lastSpawn: Record<string, { turn: number; atMs: number }>,
  opts: { homeDir?: string; nowMs?: number } = {},
): string[] {
  const homeDir = opts.homeDir ?? os.homedir();
  const markerDir = path.join(homeDir, ".pi-curator", "restart-markers", mainSessionId);
  let files: string[];
  try {
    files = fs.readdirSync(markerDir);
  } catch {
    return []; // dir missing — no markers.
  }
  const reset: string[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const alias = file.slice(0, -".json".length);
    try {
      fs.unlinkSync(path.join(markerDir, file));
    } catch {
      // non-fatal — best-effort delete.
    }
    // Reset the spawn counter for this alias (gate re-evaluates next turn).
    delete lastSpawn[alias];
    reset.push(alias);
  }
  return reset;
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
    // Path to the curator-runtime extension entry (REQ-CR-06). Defaults to the
    // sibling `src/runtime/index.ts` (or `dist/runtime/index.js` if compiled).
    runtimeExtensionPath?: string;
    // Path to the pi-intercom extension entry (REQ-CR-06). Defaults to env or
    // package resolution. If unresolvable, buildSpawnArgs will throw.
    intercomExtensionPath?: string;
    // Test seam: injected spawn (default real child_process.spawn).
    spawnFn?: typeof spawn;
    // Per-persona spawn counters (mutated in place).
    lastSpawn?: Record<string, { turn: number; atMs: number }>;
    turnNumber?: number;
    // Test seam: explicit parent env (default process.env).
    parentEnv?: NodeJS.ProcessEnv;
    // Test seam: explicit home dir for restart-marker processing.
    homeDir?: string;
    // Test seam: explicit now for deterministic timestamps.
    nowMs?: number;
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
  const parentEnv = deps.parentEnv ?? process.env;
  const homeDir = deps.homeDir ?? os.homedir();
  const nowMs = deps.nowMs ?? Date.now();
  const runtimeExtensionPath = deps.runtimeExtensionPath ?? resolveRuntimeExtensionPath();
  const intercomExtensionPath = deps.intercomExtensionPath ?? resolveIntercomExtensionPath();

  // D6: Process any `/curator restart` markers BEFORE evaluating the spawn gate.
  // Resetting lastSpawn[alias] makes the gate see turnsSince=MAX_INT, so the
  // curator re-spawns on this turn_end.
  try {
    const resetAliases = processRestartMarkers(mainSessionId, lastSpawn, { homeDir, nowMs });
    if (resetAliases.length > 0) {
      safeNotify(ctx, `curator: restart markers cleared for ${resetAliases.join(", ")}`, "info");
    }
  } catch {
    // non-fatal — gate evaluation proceeds.
  }

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

    // D7: read the persona's goalFile contents so the task prompt is real text.
    const goalContents = readGoalContents(persona.goalFile);

    // Build argv + spawn (REQ-LC-04, REQ-CR-06, detached:false).
    let args;
    try {
      args = buildSpawnArgs({
        persona,
        filteredJsonlPath: forkPath,
        mainSessionId,
        mainSessionName,
        piBin,
        runtimeExtensionPath,
        intercomExtensionPath,
        goalContents,
      }).args;
    } catch (err) {
      safeNotify(ctx, `curator: argv build failed for ${persona.alias}: ${err instanceof Error ? err.message : String(err)}`, "error");
      continue;
    }

    let child;
    try {
      child = spawnFn(piBin, args, {
        detached: false,
        // D11: stderr → logs for post-mortem, stdout → /dev/null (curators
        // signal findings via signal_main, not stdout capture).
        stdio: resolveStdio({
          mainSessionId,
          curatorAlias: persona.alias,
          nowMs: Date.now(),
        }),
        // D4: inject curator identity into the child env so the runtime can
        // readCuratorIdentity() and signal back to the right main session.
        env: buildChildEnv(persona.alias, mainSessionId, mainSessionName, nowMs, parentEnv),
      });
    } catch (err) {
      safeNotify(ctx, `curator: spawn failed for ${persona.alias}: ${err instanceof Error ? err.message : String(err)}`, "error");
      continue;
    }

    // D2: hand off the claim pid from the placeholder (main pid) to the REAL
    // child pid. This MUST NOT perform an ownership check — main just acquired
    // the slot, so it is the legitimate owner. Without this, the runtime's own
    // heartbeat(child.pid) would return `not_owner` and HALT.
    if (child?.pid) {
      try {
        await seedCuratorPid(claimPath, child.pid, { phase: "spawned", nowMs });
      } catch {
        // non-fatal — claim already written with placeholder pid; next
        // heartbeat may fail if this seed is missing, but the hook stays
        // non-blocking.
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
  // D8: mark this process as running the main-side pi-curator extension. The
  // curator runtime strips this from the child env; it only stays true in a
  // misconfigured process where the main-side extension is also loaded.
  process.env[MAIN_EXTENSION_LOADED_FLAG] = "1";

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

      // Pre-resolve extension paths once per hook invocation (REQ-CR-06).
      const runtimeExtensionPath = resolveRuntimeExtensionPath();
      const intercomExtensionPath = _resolveIntercomExtensionPath();
      if (!intercomExtensionPath) {
        safeNotify(
          ctx,
          "curator: pi-intercom extension path not found; curator spawn skipped",
          "error",
        );
        return;
      }

      await handleTurnEnd(pi, ctx, {
        projectRoot,
        mainSessionId,
        mainSessionName,
        sessionJsonlPath,
        lastSpawn,
        turnNumber: turnCounter,
        runtimeExtensionPath,
        intercomExtensionPath,
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
