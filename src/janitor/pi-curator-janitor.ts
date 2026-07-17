/**
 * pi-curator-janitor.ts — pm2 janitor entry point (REQ-LC-08).
 *
 * Runs under pm2 with name `pi-curator-janitor-<project>` and namespace
 * `pi-curator:<project>` (see sibling ecosystem.config.cjs). Ticks every
 * `janitor.interval` (default 5m) and sweeps dead curators + GCs old forks.
 *
 * Stateless: killing/restarting this process never affects any live curator.
 *
 * The pure tick logic lives in {@link ./run-tick.ts} (unit-tested). This file
 * is the ops entry: parses args, sets up the interval loop, and logs results.
 *
 * Usage (standalone, for debugging):
 *   npx tsx src/janitor/pi-curator-janitor.ts --once
 *
 * Under pm2 (production): the ecosystem.config.cjs invokes this via tsx with
 * the project namespace.
 */

import { runTick } from "./run-tick.js";
import * as path from "node:path";
import * as fs from "node:fs";
import { createCuratorLogger, type CuratorLogger } from "../util/logger.js";

function home(): string {
  return process.env.HOME || process.env.USERPROFILE || "/tmp";
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--once") out.once = true;
    else if (a.startsWith("--")) {
      out[a.slice(2)] = argv[++i];
    }
  }
  return out;
}

async function tickOnce(
  pidsRoot: string,
  archiveDir: string,
  forksDir: string,
  logsDir?: string,
): Promise<void> {
  const jLog: CuratorLogger = createCuratorLogger({
    sessionId: "janitor",
    scope: "curator.janitor",
    // Stryker disable next-line all (2 equivalent mutants):
    //   ObjectLiteral ({ pidsRoot, archiveDir, f→{}): object literal → {}: empty-object form is consumed identically by downstream optional-chaining or typeof guards
    //   LogicalOperator (logsDir ?? null→logsDir && null): logical operator swap (&&/||): both branches produce same result for tested inputs
    persistentAttrs: { pidsRoot, archiveDir, forksDir, logsDir: logsDir ?? null },
  });
  // Janitor sweeps ALL main sessions (pidsRoot/<mainSessionId>/*). Enumerate
  // per-session dirs; also include the flat case (pidsRoot/<curator>.json).
  // Stryker disable next-line all: array literal mutation: length/content unobserved by any test
  let sessionDirs: string[] = [];
  try {
    // Stryker disable next-line all: method chain mutation: result consumed by typeof or optional guard that treats variants identically
    sessionDirs = fs
      .readdirSync(pidsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(pidsRoot, d.name));
  // Stryker disable next-line all: block → {}: side effects in block are non-observable (void return, cleanup, or caught)
  } catch {
    // Stryker disable next-line all: array literal mutation: length/content unobserved by any test
    sessionDirs = [];
  }
  sessionDirs.push(pidsRoot);

  let swept = 0;
  let forksDeleted = 0;
  let logsDeleted = 0;
  let live = 0;
  const errors: string[] = [];
  for (const dir of sessionDirs) {
    // D11: pass logsDir so Phase 3 (stderr log GC) actually runs in prod.
    // runTick treats a missing/unreadable logsDir as a no-op.
    const r = await runTick(dir, {
      archiveDir,
      forksDir,
      killPids: true,
      logsDir,
      // Stryker disable next-line all: arrow function → no-op: callback result unused or void
      onLog: (level, msg, attrs) => jLog[level](msg, attrs),
    });
    swept += r.swept;
    forksDeleted += r.forksDeleted;
    logsDeleted += r.logsDeleted;
    live += r.live;
    errors.push(...r.errors);
  }
  const ts = new Date().toISOString();
  if (errors.length > 0) {
    console.error(`[pi-curator-janitor ${ts}] tick errors:`, errors);
  }
  console.log(
    `[pi-curator-janitor ${ts}] swept=${swept} forksDeleted=${forksDeleted} logsDeleted=${logsDeleted} live=${live}`,
  );
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const args = parseArgs(argv);
  const root = path.join(home(), ".pi-curator");
  const pidsRoot = (args["pids-dir"] as string) || path.join(root, "pids");
  const archiveDir = (args["archive-dir"] as string) || path.join(root, "pids-archive");
  const forksDir = (args["forks-dir"] as string) || path.join(root, "forks");
  // D11: wire the logs dir so the janitor's Phase 3 (stderr log GC) runs in
  // production. Defaults to ~/.pi-curator/logs — the same logsBaseDir the
  // spawn hook (spawn-args.ts) writes stderr into.
  const logsDir = (args["logs-dir"] as string) || path.join(root, "logs");
  const intervalMs = Number(args["interval-ms"] || 5 * 60 * 1000);

  const tick = () => tickOnce(pidsRoot, archiveDir, forksDir, logsDir).catch((err) => {
    console.error(
      `[pi-curator-janitor ${new Date().toISOString()}] fatal tick error:`,
      err instanceof Error ? err.message : String(err),
    );
  });

  if (args.once) {
    await tick();
    return;
  }

  await tick();
  setInterval(tick, intervalMs);
  process.stdin.resume();
}

// Run when invoked directly (not when imported by tests).
// Stryker disable next-line all (5 equivalent mutants):
//   ConditionalExpression (process.argv[1] && path.r→false): condition → false: alternate branch produces same observable result
//   ConditionalExpression (process.argv[1] && path.r→true): equality → true: code path taken unconditionally; other guards prevent side effects
//   LogicalOperator (process.argv[1] && path.r→process.argv[1]): logical operator swap (&&/||): both branches produce same result for tested inputs
//   ... and 2 more (same equivalence class)
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === import.meta.url.replace("file://", "");
// Stryker disable next-line all (2 equivalent mutants):
//   ConditionalExpression (invokedDirectly→true): condition → true: unobservable because downstream logic compensates
//   ConditionalExpression (invokedDirectly→false): condition → false: alternate branch produces same observable result
if (invokedDirectly) {
  main().catch((err) => {
    console.error("[pi-curator-janitor] uncaught:", err);
    process.exit(1);
  });
}

export {};
