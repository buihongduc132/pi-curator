/**
 * pi-curator-janitor.test.ts — INTEGRATION test for the production janitor
 * entry path (`pi-curator-janitor.ts`).
 *
 * This is deliberately NOT a unit test of `runTick` (that lives in
 * `run-tick.test.ts`). It drives the real `main(["--once", ...])` ops entry —
 * the exact code path pm2 invokes — and asserts that:
 *
 *   1. The `logsDir` is wired through to `runTick` so D11 Phase 3 (stderr log
 *      GC) actually runs in production (regression guard for the dead-code gap
 *      where `tickOnce` previously omitted `logsDir`).
 *   2. `logsDeleted` surfaces in the tick's console.log output.
 *
 * It uses a real tmp logsDir + real fork files so the fs side effects
 * (unlink) are exercised end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as child_process from "node:child_process";
import { main } from "./pi-curator-janitor.js";

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function writePid(
  dir: string,
  curator: string,
  fields: Partial<{
    pid: number;
    mainSessionId: string;
    spawnedAt: string;
    heartbeatAt: string;
    phase: string;
  }>,
): void {
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

let tmpRoot: string;
let savedHome: string | undefined;
let savedProfile: string | undefined;

function freshTmpRoot(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pi-curator-janitor-entry-"));
  return d;
}

function touchOld(file: string, ageMs: number, content = "x\n"): void {
  fs.writeFileSync(file, content);
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, t, t);
}

beforeEach(() => {
  tmpRoot = freshTmpRoot();
  // Sandbox HOME so ANY default-path fallback inside main() (e.g. when a
  // mutation silently drops a --flag) lands in tmpRoot, never the real
  // ~/.pi-curator. This keeps assertions deterministic and mutation-proof.
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

describe("pi-curator-janitor main() — production entry path", () => {
  it("wires logsDir so D11 stderr logs are actually GCed (--once)", async () => {
    const pidsDir = path.join(tmpRoot, "pids"); // empty — no pid claims to sweep
    const archiveDir = path.join(tmpRoot, "pids-archive");
    const forksDir = path.join(tmpRoot, "forks");
    const logsDir = path.join(tmpRoot, "logs");
    fs.mkdirSync(pidsDir, { recursive: true });
    fs.mkdirSync(forksDir, { recursive: true });

    // D11 log layout: <logsDir>/<mainSessionId>/<curator>-<ts>.stderr
    const sessionLogsDir = path.join(logsDir, "sess-entry-1");
    fs.mkdirSync(sessionLogsDir, { recursive: true });

    // OLD stderr log (2 days ago — past 24h forkTTL) → must be GCed
    const oldLog = path.join(sessionLogsDir, "spec-1700000000000.stderr");
    touchOld(oldLog, 2 * 24 * 60 * 60 * 1000, "stale diagnostic noise\n");
    // FRESH stderr log (1h ago) → must survive
    const freshLog = path.join(sessionLogsDir, "spec-1700080000000.stderr");
    touchOld(freshLog, 60 * 60 * 1000, "fresh diagnostic noise\n");

    // Also exercise fork GC (Phase 2) end-to-end.
    const oldFork = path.join(forksDir, "old.jsonl");
    touchOld(oldFork, 2 * 24 * 60 * 60 * 1000, "{}\n");
    const freshFork = path.join(forksDir, "fresh.jsonl");
    touchOld(freshFork, 60 * 60 * 1000, "{}\n");

    // Capture the production console.log so we can assert logsDeleted surfaces.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await main([
      "node",
      "src/janitor/pi-curator-janitor.ts",
      "--once",
      "--pids-dir",
      pidsDir,
      "--archive-dir",
      archiveDir,
      "--forks-dir",
      forksDir,
      "--logs-dir",
      logsDir,
    ]);

    // ── fs side-effect proof: the old log + old fork were actually unlinked ──
    expect(fs.existsSync(oldLog)).toBe(false);
    expect(fs.existsSync(freshLog)).toBe(true);
    expect(fs.existsSync(oldFork)).toBe(false);
    expect(fs.existsSync(freshFork)).toBe(true);

    // ── Fix 1 surface proof: logsDeleted appears in the tick summary ──
    const tickLine = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("pi-curator-janitor"));
    expect(tickLine).toBeDefined();
    expect(tickLine).toMatch(/logsDeleted=1/);
    expect(tickLine).toMatch(/forksDeleted=1/);
    expect(tickLine).toMatch(/swept=0/); // empty pids dir

    logSpy.mockRestore();
  });

  it("surfaces logsDeleted=0 when logsDir is empty/has-no-stale-files", async () => {
    const pidsDir = path.join(tmpRoot, "pids");
    const archiveDir = path.join(tmpRoot, "pids-archive");
    const forksDir = path.join(tmpRoot, "forks");
    const logsDir = path.join(tmpRoot, "logs");
    fs.mkdirSync(pidsDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true }); // exists but empty

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await main([
      "node",
      "src/janitor/pi-curator-janitor.ts",
      "--once",
      "--pids-dir",
      pidsDir,
      "--archive-dir",
      archiveDir,
      "--forks-dir",
      forksDir,
      "--logs-dir",
      logsDir,
    ]);

    const tickLine = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("pi-curator-janitor"));
    expect(tickLine).toMatch(/logsDeleted=0/);
    logSpy.mockRestore();
  });

  it("defaults logsDir to <root>/logs when --logs-dir is omitted", async () => {
    // When --logs-dir is NOT passed, main() derives logsDir from the root
    // (<home>/.pi-curator/logs). We cannot safely write into the real home,
    // but we CAN point --pids-dir / --forks-dir / --archive-dir at tmp and
    // assert the tick still runs (logsDeleted=0 because the default logs dir
    // is unreadable in CI). The point: confirm --logs-dir is OPTIONAL and the
    // production default path is computed (no crash, logsDeleted surfaced).
    const pidsDir = path.join(tmpRoot, "pids");
    const archiveDir = path.join(tmpRoot, "pids-archive");
    const forksDir = path.join(tmpRoot, "forks");
    fs.mkdirSync(pidsDir, { recursive: true });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await main([
      "node",
      "src/janitor/pi-curator-janitor.ts",
      "--once",
      "--pids-dir",
      pidsDir,
      "--archive-dir",
      archiveDir,
      "--forks-dir",
      forksDir,
      // NOTE: no --logs-dir → exercises the default-logsDir wiring path
    ]);

    const tickLine = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("pi-curator-janitor"));
    expect(tickLine).toMatch(/logsDeleted=\d+/); // surfaced regardless of value
    logSpy.mockRestore();
  });
});

describe("pi-curator-janitor main() — arg parsing & session sweep", () => {
  function touchOld(file: string, ageMs: number, content = "x\n"): void {
    fs.writeFileSync(file, content);
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(file, t, t);
  }

  it("respects --pids-dir and sweeps per-session subdirs + aggregates swept/live", async () => {
    // Session-subdir layout: pidsRoot/<mainSessionId>/<curator>.json.
    // tickOnce must enumerate subdirs (Dirent filter isDirectory → map to path)
    // AND aggregate swept/live across them with += (not -=).
    //
    // tickOnce uses the production checkPid default (true): a curator is only
    // `live` when BOTH its heartbeat is fresh AND its OS pid is alive. So we
    // spawn a real short-lived child to back the live curator.
    const liveChild = child_process.spawn("sleep", ["30"], { stdio: "ignore" });
    try {
    const pidsDir = path.join(tmpRoot, "pids");
    const archiveDir = path.join(tmpRoot, "pids-archive");
    const forksDir = path.join(tmpRoot, "forks");
    const logsDir = path.join(tmpRoot, "logs");
    fs.mkdirSync(forksDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const sessDir = path.join(pidsDir, "sess-1");
    writePid(sessDir, "dead1", {
      pid: 99999, // does not exist → isPidAlive false → no real SIGTERM
      heartbeatAt: isoAgo(5 * 60_000), // dead
    });
    writePid(sessDir, "live1", {
      pid: liveChild.pid as number, // alive OS process
      heartbeatAt: isoAgo(5_000), // fresh heartbeat
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await main([
      "node", "src/janitor/pi-curator-janitor.ts", "--once",
      "--pids-dir", pidsDir,
      "--archive-dir", archiveDir,
      "--forks-dir", forksDir,
      "--logs-dir", logsDir,
    ]);

    const tickLine = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("pi-curator-janitor"));
    expect(tickLine).toMatch(/swept=1\b/);
    expect(tickLine).toMatch(/live=1\b/);
    // archived into the EXPLICITLY passed --archive-dir (respects the flag)
    const archived = fs.readdirSync(path.join(archiveDir, "sess-1"));
    expect(archived.some((f) => f.startsWith("dead1-"))).toBe(true);
    // live file untouched
    expect(fs.existsSync(path.join(sessDir, "live1.json"))).toBe(true);
    logSpy.mockRestore();
    errSpy.mockRestore();
    } finally {
      try { liveChild.kill("SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("tolerates a missing pidsRoot (enumeration catch → empty sessionDirs)", async () => {
    // tickOnce wraps readdirSync(pidsRoot) in try/catch; a missing pidsRoot
    // must not crash main (catch → sessionDirs=[] then falls back to pidsRoot).
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
      "--archive-dir", archiveDir,
      "--forks-dir", forksDir,
      "--logs-dir", logsDir,
    ]);

    const tickLine = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("pi-curator-janitor"));
    expect(tickLine).toMatch(/swept=0\b/);
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("does NOT log tick errors on a clean tick (errors.length === 0)", async () => {
    const pidsDir = path.join(tmpRoot, "pids");
    const archiveDir = path.join(tmpRoot, "pids-archive");
    const forksDir = path.join(tmpRoot, "forks");
    const logsDir = path.join(tmpRoot, "logs");
    fs.mkdirSync(pidsDir, { recursive: true });
    fs.mkdirSync(forksDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await main([
      "node", "src/janitor/pi-curator-janitor.ts", "--once",
      "--pids-dir", pidsDir,
      "--archive-dir", archiveDir,
      "--forks-dir", forksDir,
      "--logs-dir", logsDir,
    ]);

    const tickErrors = errSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("tick errors"));
    expect(tickErrors).toHaveLength(0);
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("surfaces tick errors via console.error when archiving fails", async () => {
    const pidsDir = path.join(tmpRoot, "pids");
    const forksDir = path.join(tmpRoot, "forks");
    const logsDir = path.join(tmpRoot, "logs");
    fs.mkdirSync(forksDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    // A dead curator whose archive path is unreachable: archiveDir sits UNDER
    // a regular file, so mkdir(..., recursive) throws ENOTDIR → archiveErr.
    const blocker = path.join(tmpRoot, "blocker");
    fs.writeFileSync(blocker, "");
    const archiveDir = path.join(blocker, "sub");

    const sessDir = path.join(pidsDir, "sess-1");
    writePid(sessDir, "dead1", {
      pid: 99999,
      heartbeatAt: isoAgo(5 * 60_000),
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await main([
      "node", "src/janitor/pi-curator-janitor.ts", "--once",
      "--pids-dir", pidsDir,
      "--archive-dir", archiveDir,
      "--forks-dir", forksDir,
      "--logs-dir", logsDir,
    ]);

    const tickErrors = errSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("tick errors"));
    expect(tickErrors).toHaveLength(1);
    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});

describe("pi-curator-janitor main() — loop / interval wiring", () => {
  function mockLoop() {
    const setIntervalSpy = vi.spyOn(global, "setInterval").mockImplementation(
      (() => ({ unref() {} }) as unknown) as typeof setInterval,
    );
    const resumeSpy = vi
      .spyOn(process.stdin, "resume")
      .mockImplementation(() => process.stdin);
    return { setIntervalSpy, resumeSpy };
  }

  it("--once runs exactly one tick and registers NO interval / stdin resume", async () => {
    const pidsDir = path.join(tmpRoot, "pids");
    const archiveDir = path.join(tmpRoot, "pids-archive");
    const forksDir = path.join(tmpRoot, "forks");
    const logsDir = path.join(tmpRoot, "logs");
    fs.mkdirSync(pidsDir, { recursive: true });
    fs.mkdirSync(forksDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const { setIntervalSpy, resumeSpy } = mockLoop();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await main([
      "node", "src/janitor/pi-curator-janitor.ts", "--once",
      "--pids-dir", pidsDir,
      "--archive-dir", archiveDir,
      "--forks-dir", forksDir,
      "--logs-dir", logsDir,
    ]);

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(resumeSpy).not.toHaveBeenCalled();
    const tickLine = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("pi-curator-janitor"));
    expect(tickLine).toBeDefined();
    logSpy.mockRestore();
    setIntervalSpy.mockRestore();
    resumeSpy.mockRestore();
  });

  it("without --once, registers setInterval at the EXPLICIT --interval-ms", async () => {
    const pidsDir = path.join(tmpRoot, "pids");
    const archiveDir = path.join(tmpRoot, "pids-archive");
    const forksDir = path.join(tmpRoot, "forks");
    const logsDir = path.join(tmpRoot, "logs");
    fs.mkdirSync(pidsDir, { recursive: true });
    fs.mkdirSync(forksDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const { setIntervalSpy, resumeSpy } = mockLoop();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await main([
      "node", "src/janitor/pi-curator-janitor.ts",
      "--pids-dir", pidsDir,
      "--archive-dir", archiveDir,
      "--forks-dir", forksDir,
      "--logs-dir", logsDir,
      "--interval-ms", "5000",
    ]);

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    // arg[1] is the delay
    const delay = setIntervalSpy.mock.calls[0]?.[1];
    expect(delay).toBe(5000);
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
    setIntervalSpy.mockRestore();
    resumeSpy.mockRestore();
  });

  it("without --interval-ms, defaults the interval to 5*60*1000 (300000)", async () => {
    const pidsDir = path.join(tmpRoot, "pids");
    const archiveDir = path.join(tmpRoot, "pids-archive");
    const forksDir = path.join(tmpRoot, "forks");
    const logsDir = path.join(tmpRoot, "logs");
    fs.mkdirSync(pidsDir, { recursive: true });
    fs.mkdirSync(forksDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const { setIntervalSpy, resumeSpy } = mockLoop();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await main([
      "node", "src/janitor/pi-curator-janitor.ts",
      "--pids-dir", pidsDir,
      "--archive-dir", archiveDir,
      "--forks-dir", forksDir,
      "--logs-dir", logsDir,
      // no --once, no --interval-ms
    ]);

    const delay = setIntervalSpy.mock.calls[0]?.[1];
    expect(delay).toBe(5 * 60 * 1000);
    logSpy.mockRestore();
    setIntervalSpy.mockRestore();
    resumeSpy.mockRestore();
  });
});

describe("pi-curator-janitor main() — arg parsing edge cases", () => {
  function mockLoop() {
    const setIntervalSpy = vi.spyOn(global, "setInterval").mockImplementation(
      (() => ({ unref() {} }) as unknown) as typeof setInterval,
    );
    const resumeSpy = vi
      .spyOn(process.stdin, "resume")
      .mockImplementation(() => process.stdin);
    return { setIntervalSpy, resumeSpy };
  }

  it("ignores a bare positional arg and still recognizes --once (no interval)", async () => {
    // A non-'--' token must NOT be treated as a flag that consumes the next
    // arg. If it did, '--once' would be eaten and main would fall through to
    // the interval loop (setInterval called).
    const pidsDir = path.join(tmpRoot, "pids");
    const archiveDir = path.join(tmpRoot, "pids-archive");
    const forksDir = path.join(tmpRoot, "forks");
    const logsDir = path.join(tmpRoot, "logs");
    fs.mkdirSync(pidsDir, { recursive: true });
    fs.mkdirSync(forksDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const { setIntervalSpy, resumeSpy } = mockLoop();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await main([
      "node", "src/janitor/pi-curator-janitor.ts",
      "barepositional", // bare positional — must be ignored
      "--once",
      "--pids-dir", pidsDir,
      "--archive-dir", archiveDir,
      "--forks-dir", forksDir,
      "--logs-dir", logsDir,
    ]);

    expect(setIntervalSpy).not.toHaveBeenCalled(); // --once still honored
    expect(resumeSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    setIntervalSpy.mockRestore();
    resumeSpy.mockRestore();
  });
});

describe("pi-curator-janitor main() — home() default root", () => {
  it("derives pidsRoot from $HOME/.pi-curator/pids when --pids-dir is omitted", async () => {
    // HOME is already sandboxed to tmpRoot (see beforeEach). No --pids-dir →
    // exercises the home() || home() || "/tmp" chain + the default pidsRoot.
    const defaultPids = path.join(tmpRoot, ".pi-curator", "pids");
    const archiveDir = path.join(tmpRoot, "pids-archive");
    const forksDir = path.join(tmpRoot, "forks");
    const logsDir = path.join(tmpRoot, "logs");
    fs.mkdirSync(forksDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    // Dead curator in the DEFAULT per-session path.
    writePid(path.join(defaultPids, "sess-1"), "dead1", {
      pid: 99999,
      heartbeatAt: isoAgo(5 * 60_000),
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await main([
      "node", "src/janitor/pi-curator-janitor.ts", "--once",
      "--archive-dir", archiveDir,
      "--forks-dir", forksDir,
      "--logs-dir", logsDir,
      // NOTE: no --pids-dir → default root must be derived from HOME.
    ]);

    const tickLine = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("pi-curator-janitor"));
    expect(tickLine).toMatch(/swept=[1-9]/); // found the dead curator
    // And it archived into the EXPLICITLY passed --archive-dir (proves the
    // dead curator really came from the default pids path, not stray state).
    const archived = fs.readdirSync(path.join(archiveDir, "sess-1"));
    expect(archived.some((f) => f.startsWith("dead1-"))).toBe(true);
    logSpy.mockRestore();
  });
});

describe("pi-curator-janitor main() — SIGTERMs live dead pids (killPids:true)", () => {
  it("sends SIGTERM to a dead curator whose OS process is still alive", async () => {
    // tickOnce hardcodes killPids:true. Spawn a real short-lived child and put
    // its pid in a dead curator claim; the tick must SIGTERM it.
    const child = child_process.spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const pidsDir = path.join(tmpRoot, "pids");
      const archiveDir = path.join(tmpRoot, "pids-archive");
      const forksDir = path.join(tmpRoot, "forks");
      const logsDir = path.join(tmpRoot, "logs");
      fs.mkdirSync(forksDir, { recursive: true });
      fs.mkdirSync(logsDir, { recursive: true });

      const sessDir = path.join(pidsDir, "sess-1");
      writePid(sessDir, "dead1", {
        pid: child.pid as number,
        heartbeatAt: isoAgo(5 * 60_000), // dead by heartbeat
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      // Register the exit watcher BEFORE main() runs — the SIGTERM lands during
      // `await main(...)` and the 'exit' event would otherwise be missed.
      const exited = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      await main([
        "node", "src/janitor/pi-curator-janitor.ts", "--once",
        "--pids-dir", pidsDir,
        "--archive-dir", archiveDir,
        "--forks-dir", forksDir,
        "--logs-dir", logsDir,
      ]);
      logSpy.mockRestore();

      // The child must have been terminated by SIGTERM within a short window.
      // (External process.kill does NOT set child.killed; listen for exit.)
      expect(await exited).toBe(true);
    } finally {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  });
});
