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
});
