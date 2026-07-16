/**
 * run-tick.test.ts — unit tests for the janitor tick (stateless sweep + GC).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runTick, classifyPids } from "./run-tick.js";

let tmpDir: string;

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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-curator-janitor-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("runTick", () => {
  it("sweeps dead curators and archives their pids file", async () => {
    const pidsDir = path.join(tmpDir, "pids");
    const archiveDir = path.join(tmpDir, "pids-archive");
    const forksDir = path.join(tmpDir, "forks");

    // live (5s ago heartbeat)
    writePid(pidsDir, "live1", { heartbeatAt: isoAgo(5_000) });
    // dead (5 min ago heartbeat → >120s)
    writePid(pidsDir, "dead1", { heartbeatAt: isoAgo(5 * 60_000) });

    const result = await runTick(pidsDir, {
      archiveDir,
      forksDir,
      killPids: false, // don't touch real processes
      checkPid: false,
    });

    expect(result.swept).toBe(1);
    expect(result.live).toBe(1);
    // archived file exists
    const archived = fs.readdirSync(path.join(archiveDir, "sess-1"));
    expect(archived.some((f) => f.startsWith("dead1-"))).toBe(true);
    // live file still present
    expect(fs.existsSync(path.join(pidsDir, "live1.json"))).toBe(true);
  });

  it("leaves stale curators alone (only reaps dead)", async () => {
    const pidsDir = path.join(tmpDir, "pids");
    const archiveDir = path.join(tmpDir, "pids-archive");
    const forksDir = path.join(tmpDir, "forks");

    // stale (60s ago — between 30s and 120s)
    writePid(pidsDir, "stale1", { heartbeatAt: isoAgo(60_000) });

    const result = await runTick(pidsDir, {
      archiveDir,
      forksDir,
      killPids: false,
      checkPid: false,
    });

    expect(result.swept).toBe(0);
    expect(result.live).toBe(0);
    expect(fs.existsSync(path.join(pidsDir, "stale1.json"))).toBe(true);
  });

  it("GCs forks older than forkTTL", async () => {
    const pidsDir = path.join(tmpDir, "pids");
    const archiveDir = path.join(tmpDir, "pids-archive");
    const forksDir = path.join(tmpDir, "forks");
    fs.mkdirSync(forksDir, { recursive: true });

    // old fork (2 days ago)
    const oldFork = path.join(forksDir, "old.jsonl");
    fs.writeFileSync(oldFork, "{}\n");
    const oldTime = Date.now() - 2 * 24 * 60 * 60 * 1000;
    fs.utimesSync(oldFork, oldTime / 1000, oldTime / 1000);

    // fresh fork (1 hour ago)
    const freshFork = path.join(forksDir, "fresh.jsonl");
    fs.writeFileSync(freshFork, "{}\n");
    const freshTime = Date.now() - 60 * 60 * 1000;
    fs.utimesSync(freshFork, freshTime / 1000, freshTime / 1000);

    const result = await runTick(pidsDir, {
      archiveDir,
      forksDir,
      killPids: false,
      checkPid: false,
    });

    expect(result.forksDeleted).toBe(1);
    expect(fs.existsSync(oldFork)).toBe(false);
    expect(fs.existsSync(freshFork)).toBe(true);
  });

  it("never throws on missing pids dir (stateless + non-fatal)", async () => {
    const result = await runTick(path.join(tmpDir, "nonexistent"), {
      archiveDir: path.join(tmpDir, "archive"),
      forksDir: path.join(tmpDir, "forks-nonexistent"),
      killPids: false,
      checkPid: false,
    });
    expect(result.swept).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("collects errors but continues when a pids file is corrupt", async () => {
    const pidsDir = path.join(tmpDir, "pids");
    const archiveDir = path.join(tmpDir, "pids-archive");
    const forksDir = path.join(tmpDir, "forks");
    fs.mkdirSync(pidsDir, { recursive: true });
    fs.writeFileSync(path.join(pidsDir, "bad.json"), "{not json");
    fs.writeFileSync(path.join(pidsDir, "live1.json"), JSON.stringify({
      pid: 99999, mainSessionId: "s1", curator: "live1",
      spawnedAt: isoAgo(60_000), heartbeatAt: isoAgo(5_000), phase: "running",
    }));

    const result = await runTick(pidsDir, {
      archiveDir,
      forksDir,
      killPids: false,
      checkPid: false,
    });

    // corrupt file skipped, live still counted
    expect(result.live).toBe(1);
    expect(result.swept).toBe(0);
  });
});

describe("runTick — D11 stderr log GC", () => {
  it("GCs stderr log files older than forkTTL (24h) alongside fork artifacts", async () => {
    const pidsDir = path.join(tmpDir, "pids");
    const archiveDir = path.join(tmpDir, "pids-archive");
    const forksDir = path.join(tmpDir, "forks");
    const logsDir = path.join(tmpDir, "logs");
    fs.mkdirSync(forksDir, { recursive: true });

    // Create stderr log structure: logs/<sessionId>/<curator>-<ts>.stderr
    const sessionLogsDir = path.join(logsDir, "sess-1");
    fs.mkdirSync(sessionLogsDir, { recursive: true });

    // old stderr log (2 days ago)
    const oldLog = path.join(sessionLogsDir, "spec-1700000000000.stderr");
    fs.writeFileSync(oldLog, "old diagnostic noise\n");
    const oldTime = Date.now() - 2 * 24 * 60 * 60 * 1000;
    fs.utimesSync(oldLog, oldTime / 1000, oldTime / 1000);

    // fresh stderr log (1 hour ago)
    const freshLog = path.join(sessionLogsDir, "spec-1700080000000.stderr");
    fs.writeFileSync(freshLog, "fresh diagnostic noise\n");
    const freshTime = Date.now() - 60 * 60 * 1000;
    fs.utimesSync(freshLog, freshTime / 1000, freshTime / 1000);

    const result = await runTick(pidsDir, {
      archiveDir,
      forksDir,
      logsDir,
      killPids: false,
      checkPid: false,
    });

    // old log should be deleted
    expect(fs.existsSync(oldLog)).toBe(false);
    // fresh log should remain
    expect(fs.existsSync(freshLog)).toBe(true);
    // result should report the deleted log
    expect(result.logsDeleted).toBe(1);
  });

  it("handles missing logsDir gracefully (no errors)", async () => {
    const pidsDir = path.join(tmpDir, "pids");
    const archiveDir = path.join(tmpDir, "pids-archive");
    const forksDir = path.join(tmpDir, "forks");

    const result = await runTick(pidsDir, {
      archiveDir,
      forksDir,
      logsDir: path.join(tmpDir, "nonexistent-logs"),
      killPids: false,
      checkPid: false,
    });

    expect(result.logsDeleted).toBe(0);
    expect(result.errors).toEqual([]);
  });
});

describe("classifyPids", () => {
  it("classifies live vs dead entries", async () => {
    const pidsDir = path.join(tmpDir, "pids");
    writePid(pidsDir, "live1", { heartbeatAt: isoAgo(5_000) });
    writePid(pidsDir, "dead1", { heartbeatAt: isoAgo(5 * 60_000) });

    const entries = await classifyPids(pidsDir, { checkPid: false });
    const live = entries.find((e) => e.curator === "live1");
    const dead = entries.find((e) => e.curator === "dead1");
    expect(live?.liveness).toBe("live");
    expect(dead?.liveness).toBe("dead");
  });

  it("honors an explicit nowMs (not Date.now()) for freshness math", async () => {
    // Fixed now far from wall-clock: heartbeat is 10s old relative to fixedNow
    // (→ live) but hours old relative to real Date.now() (→ dead). Asserting
    // `live` proves classifyPids used the injected nowMs.
    const fixedNow = 1700000000000;
    const pidsDir = path.join(tmpDir, "pids");
    writePid(pidsDir, "c1", {
      heartbeatAt: new Date(fixedNow - 10_000).toISOString(),
    });
    const entries = await classifyPids(pidsDir, {
      nowMs: fixedNow,
      checkPid: false,
    });
    expect(entries[0].liveness).toBe("live");
  });

  it("returns [] for a missing pids dir (never throws)", async () => {
    const entries = await classifyPids(path.join(tmpDir, "nope"), {
      checkPid: false,
    });
    expect(entries).toEqual([]);
  });

  it("returns [] (not a sentinel) for an empty / non-json dir", async () => {
    const pidsDir = path.join(tmpDir, "pids");
    fs.mkdirSync(pidsDir, { recursive: true });
    // non-json file whose content is a VALID curator claim — must be ignored
    fs.writeFileSync(
      path.join(pidsDir, "notes.txt"),
      JSON.stringify({
        pid: 1, mainSessionId: "s", curator: "x",
        spawnedAt: isoAgo(1_000), heartbeatAt: isoAgo(1_000), phase: "running",
      }),
    );
    const entries = await classifyPids(pidsDir, { checkPid: false });
    expect(entries).toEqual([]);
    expect(entries.length).toBe(0);
  });

  it("skips valid JSON with an invalid curator claim shape without throwing", async () => {
    const pidsDir = path.join(tmpDir, "pids");
    fs.mkdirSync(pidsDir, { recursive: true });
    // {} parses but parseCuratorClaim → null; must be skipped, not crash.
    fs.writeFileSync(path.join(pidsDir, "bad.json"), "{}");
    const entries = await classifyPids(pidsDir, { checkPid: false });
    expect(entries).toEqual([]);
  });

  it("treats a pid whose process.kill(0) throws ESRCH as dead even with a fresh heartbeat", async () => {
    // Fresh heartbeat (→ live by time) but injected kill reports ESRCH on
    // signal 0 → checkPid fast-path must classify as dead.
    const fixedNow = 1700000000000;
    const pidsDir = path.join(tmpDir, "pids");
    writePid(pidsDir, "gone", {
      pid: 4242,
      heartbeatAt: new Date(fixedNow - 5_000).toISOString(),
    });
    const kill = (pid: number, signal: NodeJS.Signals | 0) => {
      const err = new Error("no such process") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    };
    const entries = await classifyPids(pidsDir, {
      nowMs: fixedNow,
      checkPid: true,
      kill: kill as unknown as (pid: number, signal: NodeJS.Signals) => void,
    });
    expect(entries[0].liveness).toBe("dead");
  });
});

describe("runTick — SIGTERM gating via killPids", () => {
  it("killPids:false never touches the pid even when the curator is dead", async () => {
    const pidsDir = path.join(tmpDir, "pids");
    const archiveDir = path.join(tmpDir, "archive");
    const forksDir = path.join(tmpDir, "forks");
    writePid(pidsDir, "dead1", {
      pid: 4242,
      heartbeatAt: isoAgo(5 * 60_000),
    });

    const killCalls: Array<{ pid: number; signal: number | string }> = [];
    const kill = (pid: number, signal: NodeJS.Signals) => {
      killCalls.push({ pid, signal });
    };

    const result = await runTick(pidsDir, {
      archiveDir,
      forksDir,
      killPids: false,
      checkPid: false, // avoid classifyPids invoking kill; we only gate the SIGTERM block
      kill: kill as unknown as (pid: number, signal: NodeJS.Signals) => void,
    });

    expect(killCalls).toHaveLength(0); // neither signal 0 nor SIGTERM
    // still archived (reaping is independent of the SIGTERM gate)
    expect(result.swept).toBe(1);
  });

  it("killPids omitted (default true) SIGTERMs an alive dead curator", async () => {
    const pidsDir = path.join(tmpDir, "pids");
    const archiveDir = path.join(tmpDir, "archive");
    const forksDir = path.join(tmpDir, "forks");
    writePid(pidsDir, "dead1", {
      pid: 4242,
      heartbeatAt: isoAgo(5 * 60_000),
    });

    const killCalls: Array<{ pid: number; signal: number | string }> = [];
    const kill = (pid: number, signal: NodeJS.Signals) => {
      // signal 0 (alive check) must NOT throw so the pid looks alive
      killCalls.push({ pid, signal });
    };

    await runTick(pidsDir, {
      archiveDir,
      forksDir,
      checkPid: true,
      kill: kill as unknown as (pid: number, signal: NodeJS.Signals) => void,
    });

    const sigterm = killCalls.find((c) => c.signal === "SIGTERM");
    expect(sigterm).toBeDefined();
    expect(sigterm?.pid).toBe(4242);
  });

  it("does NOT attempt SIGTERM for a dead curator whose pid is already gone (no error)", async () => {
    // killPids defaults to true, but isPidAlive(99999) is false → the SIGTERM
    // branch must be skipped entirely (no error collected). Uses the real
    // process.kill so the isPidAlive fast-path actually runs.
    const pidsDir = path.join(tmpDir, "pids");
    const archiveDir = path.join(tmpDir, "archive");
    const forksDir = path.join(tmpDir, "forks");
    writePid(pidsDir, "dead1", {
      pid: 99999, // no such process → isPidAlive false
      heartbeatAt: isoAgo(5 * 60_000),
    });

    const result = await runTick(pidsDir, {
      archiveDir,
      forksDir,
      // killPids omitted → defaults true; checkPid default true
    });

    expect(result.swept).toBe(1); // still archived
    expect(result.errors).toEqual([]); // no SIGTERM failure for an already-dead pid
  });
});

describe("runTick — fork / log TTL boundaries", () => {
  it("does NOT delete a fork exactly at the TTL boundary (> not >=)", async () => {
    const pidsDir = path.join(tmpDir, "pids");
    const archiveDir = path.join(tmpDir, "archive");
    const forksDir = path.join(tmpDir, "forks");
    fs.mkdirSync(forksDir, { recursive: true });
    const forkFile = path.join(forksDir, "boundary.jsonl");
    fs.writeFileSync(forkFile, "{}\n");

    const nowMs = 1700000000000;
    const forkTTLms = 24 * 60 * 60 * 1000;
    // mtime exactly forkTTLms ago → (nowMs - mtime) === forkTTLms → NOT > → keep
    const stat = () => ({ mtimeMs: nowMs - forkTTLms });

    const result = await runTick(pidsDir, {
      archiveDir,
      forksDir,
      killPids: false,
      checkPid: false,
      nowMs,
      forkTTLms,
      stat,
    });
    expect(result.forksDeleted).toBe(0);
    expect(fs.existsSync(forkFile)).toBe(true);
  });

  it("does NOT delete a stderr log exactly at the TTL boundary", async () => {
    const pidsDir = path.join(tmpDir, "pids");
    const archiveDir = path.join(tmpDir, "archive");
    const forksDir = path.join(tmpDir, "forks");
    const logsDir = path.join(tmpDir, "logs");
    fs.mkdirSync(forksDir, { recursive: true });
    const sessLogs = path.join(logsDir, "sess-1");
    fs.mkdirSync(sessLogs, { recursive: true });
    const logFile = path.join(sessLogs, "c-1.stderr");
    fs.writeFileSync(logFile, "x\n");

    const nowMs = 1700000000000;
    const forkTTLms = 60_000;
    const stat = () => ({ mtimeMs: nowMs - forkTTLms });

    const result = await runTick(pidsDir, {
      archiveDir,
      forksDir,
      logsDir,
      killPids: false,
      checkPid: false,
      nowMs,
      forkTTLms,
      stat,
    });
    expect(result.logsDeleted).toBe(0);
    expect(fs.existsSync(logFile)).toBe(true);
  });

  it("ignores non-.jsonl files in the forks dir", async () => {
    const pidsDir = path.join(tmpDir, "pids");
    const archiveDir = path.join(tmpDir, "archive");
    const forksDir = path.join(tmpDir, "forks");
    fs.mkdirSync(forksDir, { recursive: true });

    const staleFile = path.join(forksDir, "old.log"); // not .jsonl
    fs.writeFileSync(staleFile, "{}\n");
    const oldTime = Date.now() - 2 * 24 * 60 * 60 * 1000;
    fs.utimesSync(staleFile, oldTime / 1000, oldTime / 1000);

    const result = await runTick(pidsDir, {
      archiveDir,
      forksDir,
      killPids: false,
      checkPid: false,
    });
    expect(result.forksDeleted).toBe(0);
    expect(fs.existsSync(staleFile)).toBe(true);
  });
});

describe("runTick — D11 stderr log collection shape", () => {
  it("GCs a flat .stderr file directly under logsDir root", async () => {
    const pidsDir = path.join(tmpDir, "pids");
    const archiveDir = path.join(tmpDir, "archive");
    const forksDir = path.join(tmpDir, "forks");
    const logsDir = path.join(tmpDir, "logs");
    fs.mkdirSync(forksDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const flatLog = path.join(logsDir, "spec-flat.stderr");
    fs.writeFileSync(flatLog, "old\n");
    const oldTime = Date.now() - 2 * 24 * 60 * 60 * 1000;
    fs.utimesSync(flatLog, oldTime / 1000, oldTime / 1000);
    // A flat NON-.stderr file at the root must be ignored (only *.stderr GC'd).
    const flatNoise = path.join(logsDir, "notes.txt");
    fs.writeFileSync(flatNoise, "old\n");
    fs.utimesSync(flatNoise, oldTime / 1000, oldTime / 1000);

    const result = await runTick(pidsDir, {
      archiveDir,
      forksDir,
      logsDir,
      killPids: false,
      checkPid: false,
    });
    expect(result.logsDeleted).toBe(1);
    expect(fs.existsSync(flatLog)).toBe(false);
    expect(fs.existsSync(flatNoise)).toBe(true);
  });

  it("in a session subdir, GCs only *.stderr and leaves non-stderr files; no errors", async () => {
    const pidsDir = path.join(tmpDir, "pids");
    const archiveDir = path.join(tmpDir, "archive");
    const forksDir = path.join(tmpDir, "forks");
    const logsDir = path.join(tmpDir, "logs");
    fs.mkdirSync(forksDir, { recursive: true });
    const sessLogs = path.join(logsDir, "sess-1");
    fs.mkdirSync(sessLogs, { recursive: true });

    const stderrFile = path.join(sessLogs, "c-1.stderr");
    fs.writeFileSync(stderrFile, "old\n");
    const noiseFile = path.join(sessLogs, "notes.txt"); // old, but NOT .stderr
    fs.writeFileSync(noiseFile, "old\n");
    const oldTime = Date.now() - 2 * 24 * 60 * 60 * 1000;
    fs.utimesSync(stderrFile, oldTime / 1000, oldTime / 1000);
    fs.utimesSync(noiseFile, oldTime / 1000, oldTime / 1000);

    const result = await runTick(pidsDir, {
      archiveDir,
      forksDir,
      logsDir,
      killPids: false,
      checkPid: false,
    });
    expect(result.logsDeleted).toBe(1);
    expect(fs.existsSync(stderrFile)).toBe(false);
    expect(fs.existsSync(noiseFile)).toBe(true);
    // collectLogFiles must start from a clean [] — a leftover entry would
    // surface as a stat failure here.
    expect(result.errors).toEqual([]);
  });
});
