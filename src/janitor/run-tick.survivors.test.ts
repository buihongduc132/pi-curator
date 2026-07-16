/**
 * run-tick.survivors.test.ts — kills surviving mutants in src/janitor/run-tick.ts.
 *
 * Killable:
 *  - id 712 (classifyPids readdir catch → return []): missing pidsDir → [].
 *  - id 760 (SIGTERM kill catch): opts.kill throwing on SIGTERM pushes an error.
 *  - id 789 (fork unlink catch): a fork path that is a DIRECTORY (.jsonl-named)
 *    makes unlink fail → error pushed.
 *  - id 791/811 (fork/log stat catch): opts.stat throwing pushes an error.
 *  - id 809 (log unlink catch): a .stderr file in a read-only dir is undeletable.
 *  - id 820 (collectLogFiles stat catch): a dangling-symlink .stderr skips cleanly.
 *  - id 825 (collectLogFiles inner readdir catch): an unreadable session subdir.
 *
 * EQUIVALENT:
 *  - id 714 (classifyPids readFile catch → continue): the next `JSON.parse(raw)`
 *    catch also continues, so emptying this catch yields an identical skip.
 *  - id 762 (isPidAlive catch): isPidAlive is total (never throws), so the
 *    surrounding aliveErr catch is unreachable.
 *  - id 773 (`forks = []` → `["Stryker was here"]`): the fake name does not end
 *    in `.jsonl`, so the for-loop body is never entered.
 *  - id 793 (`if (opts.logsDir)` → true): collectLogFiles(undefined) returns []
 *    on its own, so phase 3 is a no-op either way.
 *  - id 797/798/816 (collectLogFiles top-readdir catch + phase-3 outer catch):
 *    collectLogFiles is total (every readdir/stat is individually guarded), so
 *    the outer `catch { logFiles = [] }` is dead defensive code.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { classifyPids, runTick } from "./run-tick.js";

const NOW = 1_750_000_000_000; // realistic epoch ms so `nowMs - mtimeMs` is meaningful
let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runtick-surv-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeClaim(dir: string, curator: string, heartbeatAgeMs: number, pid = 999_999): void {
  fs.mkdirSync(dir, { recursive: true });
  const claim = {
    pid,
    mainSessionId: "ses",
    curator,
    spawnedAt: new Date(NOW - 200_000).toISOString(),
    heartbeatAt: new Date(NOW - heartbeatAgeMs).toISOString(),
    phase: "scanning",
  };
  fs.writeFileSync(path.join(dir, `${curator}.json`), JSON.stringify(claim));
}

// Mark a file as older than TTL relative to NOW (mtime is in seconds).
function ageFile(filePath: string, ageMs: number): void {
  const sec = (NOW - ageMs) / 1000;
  fs.utimesSync(filePath, sec, sec);
}

describe("run-tick survivors", () => {
  it("classifyPids: missing dir → [] (kills readdir-catch mutant)", async () => {
    const entries = await classifyPids(path.join(tmp, "nope"), { nowMs: NOW, checkPid: false });
    expect(entries).toEqual([]);
  });

  it("runTick: SIGTERM kill failure is recorded in errors (kills kill-catch mutant)", async () => {
    const pidsDir = path.join(tmp, "pids");
    const archiveDir = path.join(tmp, "archive");
    const forksDir = path.join(tmp, "forks");
    fs.mkdirSync(forksDir, { recursive: true });
    // A very-stale heartbeat (dead) so the entry is reaped; pid alive so SIGTERM
    // is attempted. opts.kill throws on the SIGTERM call.
    writeClaim(pidsDir, "dead", 300_000, 999_999);
    const result = await runTick(pidsDir, {
      archiveDir,
      forksDir,
      nowMs: NOW,
      killPids: true,
      checkPid: false,
      kill: () => {
        throw new Error("SIGTERM refused");
      },
    });
    expect(result.errors.some((e) => e.includes("SIGTERM refused"))).toBe(true);
  });

  it("runTick: fork that is a directory (.jsonl-named) → unlink fails, error pushed (kills fork-unlink-catch mutant)", async () => {
    const pidsDir = path.join(tmp, "pids");
    const archiveDir = path.join(tmp, "archive");
    const forksDir = path.join(tmp, "forks");
    fs.mkdirSync(pidsDir, { recursive: true });
    fs.mkdirSync(archiveDir, { recursive: true });
    // A directory whose name ends in .jsonl → unlink(dir) errors (EISDIR/EPERM),
    // and opts.stat returns an ancient mtime so the unlink path is taken.
    fs.mkdirSync(path.join(forksDir, "weird.jsonl"), { recursive: true });
    const result = await runTick(pidsDir, {
      archiveDir,
      forksDir,
      nowMs: NOW,
      killPids: false,
      checkPid: false,
      forkTTLms: 1,
      stat: () => ({ mtimeMs: 0 }),
    });
    expect(result.errors.some((e) => e.includes("failed to delete fork"))).toBe(true);
  });

  it("runTick: opts.stat throwing for a fork → error pushed (kills fork-stat-catch mutant)", async () => {
    const forksDir = path.join(tmp, "forks");
    fs.mkdirSync(forksDir, { recursive: true });
    fs.writeFileSync(path.join(forksDir, "old.jsonl"), "x");
    const result = await runTick(path.join(tmp, "pids"), {
      archiveDir: path.join(tmp, "archive"),
      forksDir,
      nowMs: NOW,
      killPids: false,
      checkPid: false,
      stat: () => {
        throw new Error("stat boom");
      },
    });
    expect(result.errors.some((e) => e.includes("failed to stat fork"))).toBe(true);
  });

  it("runTick: opts.stat throwing for a log → error pushed (kills log-stat-catch mutant)", async () => {
    const logsDir = path.join(tmp, "logs", "ses");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, "cur.stderr"), "noise");
    const result = await runTick(path.join(tmp, "pids"), {
      archiveDir: path.join(tmp, "archive"),
      forksDir: path.join(tmp, "forks"),
      logsDir: path.join(tmp, "logs"),
      nowMs: NOW,
      killPids: false,
      checkPid: false,
      stat: () => {
        throw new Error("logstat boom");
      },
    });
    expect(result.errors.some((e) => e.includes("failed to stat log"))).toBe(true);
  });

  it("runTick: undeletable .stderr in read-only dir → error pushed (kills log-unlink-catch mutant)", async () => {
    if (process.getuid && process.getuid() === 0) return; // root bypasses perms
    const logsSes = path.join(tmp, "logs", "ses");
    fs.mkdirSync(logsSes, { recursive: true });
    fs.writeFileSync(path.join(logsSes, "cur.stderr"), "noise");
    // Ancient via opts.stat so the unlink path is taken; make the dir read-only.
    fs.chmodSync(logsSes, 0o555);
    try {
      const result = await runTick(path.join(tmp, "pids"), {
        archiveDir: path.join(tmp, "archive"),
        forksDir: path.join(tmp, "forks"),
        logsDir: path.join(tmp, "logs"),
        nowMs: NOW,
        killPids: false,
        checkPid: false,
        forkTTLms: 1,
        stat: () => ({ mtimeMs: 0 }),
      });
      expect(result.errors.some((e) => e.includes("failed to delete log"))).toBe(true);
    } finally {
      fs.chmodSync(logsSes, 0o755);
    }
  });

  it("runTick: dangling-symlink .stderr is skipped without aborting GC (kills collectLogFiles stat-catch mutant)", async () => {
    const logsSes = path.join(tmp, "logs", "ses");
    fs.mkdirSync(logsSes, { recursive: true });
    // A good stale log (will be GC'd) ...
    const goodLog = path.join(logsSes, "good.stderr");
    fs.writeFileSync(goodLog, "noise");
    ageFile(goodLog, 2000);
    // ... plus a broken symlink whose stat() fails.
    fs.symlinkSync("/nonexistent/target", path.join(logsSes, "broken.stderr"));
    const result = await runTick(path.join(tmp, "pids"), {
      archiveDir: path.join(tmp, "archive"),
      forksDir: path.join(tmp, "forks"),
      logsDir: path.join(tmp, "logs"),
      nowMs: NOW,
      killPids: false,
      checkPid: false,
      forkTTLms: 1000,
      stat: undefined, // real stat: good works, broken fails → skipped
    });
    // The good log was still GC'd (collectLogFiles did not throw).
    expect(result.logsDeleted).toBe(1);
  });

  it("runTick: unreadable session subdir is skipped (kills collectLogFiles inner-readdir-catch mutant)", async () => {
    if (process.getuid && process.getuid() === 0) return; // root bypasses perms
    const logsRoot = path.join(tmp, "logs");
    const goodSes = path.join(logsRoot, "good");
    const badSes = path.join(logsRoot, "bad");
    fs.mkdirSync(goodSes, { recursive: true });
    fs.mkdirSync(badSes, { recursive: true });
    const goodLog = path.join(goodSes, "a.stderr");
    fs.writeFileSync(goodLog, "noise");
    ageFile(goodLog, 2000);
    fs.writeFileSync(path.join(badSes, "b.stderr"), "noise");
    fs.chmodSync(badSes, 0o000); // unreadable → inner readdir fails
    try {
      const result = await runTick(path.join(tmp, "pids"), {
        archiveDir: path.join(tmp, "archive"),
        forksDir: path.join(tmp, "forks"),
        logsDir: logsRoot,
        nowMs: NOW,
        killPids: false,
        checkPid: false,
        forkTTLms: 1000,
      });
      // The good session's log is GC'd even though the bad session's readdir failed.
      expect(result.logsDeleted).toBeGreaterThanOrEqual(1);
    } finally {
      fs.chmodSync(badSes, 0o755);
    }
  });
});
