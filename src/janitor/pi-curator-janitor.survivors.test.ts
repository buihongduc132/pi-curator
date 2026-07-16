/**
 * pi-curator-janitor.survivors.test.ts — final-round mutation survivor kills
 * for src/janitor/pi-curator-janitor.ts.
 *
 * Targets the non-equivalent survivors:
 *  - L50 MethodExpression (readdirSync withFileTypes): enumerating per-session
 *    subdirs MUST use Dirents (`.isDirectory()`); dropping withFileTypes yields
 *    plain strings → the filter throws → sessionDirs=[] → subdirs never swept.
 *  - L55 ArrayDeclaration (catch `sessionDirs = []`): a missing pidsRoot must
 *    NOT leave a sentinel value in sessionDirs.
 *
 * Equivalent survivors (documented):
 *  - L48 ArrayDeclaration (initial `[]`): always reassigned by the try or catch.
 *  - L54 BlockStatement (catch body): with the L48 initial `[]`, emptying the
 *    catch body leaves sessionDirs at `[]` — same as the catch assigning `[]`.
 *  - L95 NoCoverage (tick `.catch` handler): tickOnce never rejects (it catches
 *    internally), so the fatal-error handler is unreachable defensive code.
 *  - L113/L114 (invokedDirectly + main().catch): module-load-time argv check;
 *    untestable without controlling process.argv[1] / import.meta.url at import.
 */
// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as child_process from "node:child_process";
import { main } from "./pi-curator-janitor.js";

let tmpRoot: string;
let savedHome: string | undefined;
let savedProfile: string | undefined;

function isoAgo(ms: number) {
  return new Date(Date.now() - ms).toISOString();
}
function writePid(dir: string, curator: string, fields: any) {
  const claim = {
    pid: fields.pid ?? 99999,
    mainSessionId: fields.mainSessionId ?? "sess-1",
    curator,
    spawnedAt: fields.spawnedAt ?? isoAgo(60_000),
    heartbeatAt: fields.heartbeatAt ?? isoAgo(5_000),
    phase: fields.phase ?? "running",
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${curator}.json`), JSON.stringify(claim));
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jan-surv-"));
  savedHome = process.env.HOME;
  savedProfile = process.env.USERPROFILE;
  process.env.HOME = tmpRoot;
  delete process.env.USERPROFILE;
});
afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.env.HOME = savedHome;
  if (savedProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedProfile;
});

describe("tickOnce — readdirSync withFileTypes (L50)", () => {
  it("sweeps a per-session subdir using Dirent.isDirectory (kills L50)", async () => {
    // L50 mutant drops `withFileTypes` → readdirSync returns strings →
    // `.isDirectory()` throws → catch → sessionDirs=[] → the sess-1 subdir is
    // never enumerated → swept=0. Original sweeps the dead curator (swept=1).
    const liveChild = child_process.spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const pidsDir = path.join(tmpRoot, "pids");
      const archiveDir = path.join(tmpRoot, "pids-archive");
      const forksDir = path.join(tmpRoot, "forks");
      const logsDir = path.join(tmpRoot, "logs");
      fs.mkdirSync(forksDir, { recursive: true });
      fs.mkdirSync(logsDir, { recursive: true });

      const sessDir = path.join(pidsDir, "sess-1");
      writePid(sessDir, "dead1", { pid: 99999, heartbeatAt: isoAgo(5 * 60_000) });
      writePid(sessDir, "live1", { pid: liveChild.pid, heartbeatAt: isoAgo(5_000) });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await main([
        "node", "src/janitor/pi-curator-janitor.ts", "--once",
        "--pids-dir", pidsDir, "--archive-dir", archiveDir,
        "--forks-dir", forksDir, "--logs-dir", logsDir,
      ]);

      const tickLine = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("pi-curator-janitor"));
      expect(tickLine).toMatch(/swept=1\b/);
      expect(tickLine).toMatch(/live=1\b/);
      // The dead curator was archived from the subdir (proves Dirent enumeration).
      const archived = fs.readdirSync(path.join(archiveDir, "sess-1"));
      expect(archived.some((f) => f.startsWith("dead1-"))).toBe(true);
      logSpy.mockRestore();
    } finally {
      try { liveChild.kill("SIGKILL"); } catch { /* gone */ }
    }
  });
});

describe("tickOnce — missing pidsRoot catch sentinel (L55)", () => {
  it("a missing pidsRoot yields swept=0 with no stray session dirs (kills L55)", async () => {
    // L55 ArrayDeclaration mutant sets sessionDirs = ["Stryker was here"] in the
    // catch. That sentinel would be pushed alongside pidsRoot and runTick'd,
    // surfacing extra errors. Original: sessionDirs=[] → only pidsRoot is tried.
    // Assert the tick summary stays clean (swept=0) and no sentinel leaks.
    const archiveDir = path.join(tmpRoot, "pids-archive");
    const forksDir = path.join(tmpRoot, "forks");
    const logsDir = path.join(tmpRoot, "logs");
    fs.mkdirSync(forksDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await main([
      "node", "src/janitor/pi-curator-janitor.ts", "--once",
      "--pids-dir", path.join(tmpRoot, "does-not-exist"),
      "--archive-dir", archiveDir, "--forks-dir", forksDir, "--logs-dir", logsDir,
    ]);

    const tickLine = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("pi-curator-janitor"));
    expect(tickLine).toMatch(/swept=0\b/);
    // No sentinel string leaks into any error output.
    const allErr = errSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(allErr).not.toContain("Stryker was here");
    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});
