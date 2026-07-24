/**
 * logging-verification.test.ts — VERIFICATION (green) tests for the janitor's
 * OTel logging wiring.
 *
 * The janitor's logging is ALREADY wired via two layers:
 *   1. `runTick` accepts an `opts.onLog(level, msg, attrs)` callback seam and
 *      invokes it at every instrumentation point (tick start / reaped / tick
 *      complete / tick had errors).
 *   2. `tickOnce` (in pi-curator-janitor.ts) builds a `jLog` via
 *      `createCuratorLogger({ scope: "curator.janitor", ... })` and bridges it
 *      into runTick: `onLog: (level, msg, attrs) => jLog[level](msg, attrs)`.
 *
 * These tests PROVE both layers emit OTel-shaped records at the right level
 * with the required attributes. They are NOT RED — they must pass against the
 * current source unchanged.
 *
 * Design ref: flow/plans/otel-logging/design.md "Janitor" instrumentation points.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runTick } from "./run-tick.js";

// ── shared fixtures ─────────────────────────────────────────────────────────

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

function touchOld(file: string, ageMs: number, content = "x\n"): void {
  fs.writeFileSync(file, content);
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, t, t);
}

type LogCall = { level: "info" | "warn" | "error"; msg: string; attrs?: Record<string, unknown> };
function captureLog(): { calls: LogCall[]; onLog: NonNullable<Parameters<typeof runTick>[1]>["onLog"] } {
  const calls: LogCall[] = [];
  return {
    calls,
    onLog: (level, msg, attrs) => calls.push({ level, msg, attrs }),
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-curator-janitor-log-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Layer 1: runTick onLog seam (pure — no module mocking) ─────────────────

describe("runTick — OTel logging instrumentation (onLog seam)", () => {
  it("emits a 'janitor tick start' info record with pidsDir/forkRoot/logsDir attrs", async () => {
    const pidsDir = path.join(tmpDir, "pids");
    const archiveDir = path.join(tmpDir, "pids-archive");
    const forksDir = path.join(tmpDir, "forks");
    const logsDir = path.join(tmpDir, "logs");
    fs.mkdirSync(pidsDir, { recursive: true });

    const { calls, onLog } = captureLog();
    await runTick(pidsDir, {
      archiveDir,
      forksDir,
      logsDir,
      killPids: false,
      checkPid: false,
      onLog,
    });

    const start = calls.find((c) => c.msg === "janitor tick start");
    expect(start).toBeDefined();
    expect(start!.level).toBe("info");
    // design.md "Tick start — attrs: pidRoot, forkRoot, logsDir".
    expect(start!.attrs).toMatchObject({
      pidsDir,
      archiveDir,
      forksDir,
      logsDir,
    });
  });

  it("emits null logsDir attr when logsDir is omitted (tick start still carries the key)", async () => {
    const pidsDir = path.join(tmpDir, "pids");
    const archiveDir = path.join(tmpDir, "pids-archive");
    const forksDir = path.join(tmpDir, "forks");
    fs.mkdirSync(pidsDir, { recursive: true });

    const { calls, onLog } = captureLog();
    await runTick(pidsDir, {
      archiveDir,
      forksDir,
      killPids: false,
      checkPid: false,
      onLog,
    });

    const start = calls.find((c) => c.msg === "janitor tick start");
    expect(start!.attrs).toHaveProperty("logsDir", null);
  });

  it("emits a 'reaped dead curator' info record per dead pid with pid/alias/session/archivePath", async () => {
    const pidsDir = path.join(tmpDir, "pids");
    const archiveDir = path.join(tmpDir, "pids-archive");
    const forksDir = path.join(tmpDir, "forks");

    writePid(pidsDir, "dead1", {
      pid: 4242,
      mainSessionId: "sess-A",
      heartbeatAt: isoAgo(5 * 60_000), // dead
    });

    const { calls, onLog } = captureLog();
    await runTick(pidsDir, {
      archiveDir,
      forksDir,
      killPids: false,
      checkPid: false,
      onLog,
    });

    const reaped = calls.filter((c) => c.msg === "reaped dead curator");
    expect(reaped).toHaveLength(1);
    expect(reaped[0]!.level).toBe("info");
    expect(reaped[0]!.attrs).toMatchObject({
      pid: 4242,
      "persona.alias": "dead1",
      "session.id": "sess-A",
    });
    expect(reaped[0]!.attrs).toHaveProperty("archivePath");
    expect(String(reaped[0]!.attrs!.archivePath)).toContain("sess-A");
  });

  it("does NOT emit a 'reaped dead curator' record for live or stale curators", async () => {
    const pidsDir = path.join(tmpDir, "pids");
    const archiveDir = path.join(tmpDir, "pids-archive");
    const forksDir = path.join(tmpDir, "forks");

    writePid(pidsDir, "live1", { heartbeatAt: isoAgo(5_000) }); // live
    writePid(pidsDir, "stale1", { heartbeatAt: isoAgo(60_000) }); // stale (30s < x < 120s)

    const { calls, onLog } = captureLog();
    await runTick(pidsDir, {
      archiveDir,
      forksDir,
      killPids: false,
      checkPid: false,
      onLog,
    });

    const reaped = calls.filter((c) => c.msg === "reaped dead curator");
    expect(reaped).toHaveLength(0);
  });

  it("emits a 'janitor tick complete' info record with swept/forksDeleted/logsDeleted/live/errors", async () => {
    const pidsDir = path.join(tmpDir, "pids");
    const archiveDir = path.join(tmpDir, "pids-archive");
    const forksDir = path.join(tmpDir, "forks");
    const logsDir = path.join(tmpDir, "logs");
    fs.mkdirSync(forksDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    // live curator (counted in `live`)
    writePid(pidsDir, "live1", { heartbeatAt: isoAgo(5_000) });

    const { calls, onLog } = captureLog();
    await runTick(pidsDir, {
      archiveDir,
      forksDir,
      logsDir,
      killPids: false,
      checkPid: false,
      onLog,
    });

    const complete = calls.find((c) => c.msg === "janitor tick complete");
    expect(complete).toBeDefined();
    expect(complete!.level).toBe("info");
    expect(complete!.attrs).toMatchObject({
      swept: 0,
      forksDeleted: 0,
      logsDeleted: 0,
      live: 1,
      errors: 0,
    });
  });

  it("reflects swept/forksDeleted/logsDeleted counts in the tick complete record after real GC", async () => {
    const pidsDir = path.join(tmpDir, "pids");
    const archiveDir = path.join(tmpDir, "pids-archive");
    const forksDir = path.join(tmpDir, "forks");
    const logsDir = path.join(tmpDir, "logs");
    fs.mkdirSync(forksDir, { recursive: true });
    const sessLogs = path.join(logsDir, "sess-1");
    fs.mkdirSync(sessLogs, { recursive: true });

    // dead curator → swept
    writePid(pidsDir, "dead1", { heartbeatAt: isoAgo(5 * 60_000) });
    // old fork → forksDeleted
    const oldFork = path.join(forksDir, "old.jsonl");
    touchOld(oldFork, 2 * 24 * 60 * 60 * 1000, "{}\n");
    // old stderr → logsDeleted
    const oldLog = path.join(sessLogs, "spec-1.stderr");
    touchOld(oldLog, 2 * 24 * 60 * 60 * 1000, "noise\n");

    const { calls, onLog } = captureLog();
    await runTick(pidsDir, {
      archiveDir,
      forksDir,
      logsDir,
      killPids: false,
      checkPid: false,
      onLog,
    });

    const complete = calls.find((c) => c.msg === "janitor tick complete");
    expect(complete!.attrs).toMatchObject({
      swept: 1,
      forksDeleted: 1,
      logsDeleted: 1,
      live: 0,
      errors: 0,
    });
  });

  it("emits a 'janitor tick had errors' WARN record (with count + errors) only when errors > 0", async () => {
    const pidsDir = path.join(tmpDir, "pids");
    const archiveDir = path.join(tmpDir, "pids-archive");
    const forksDir = path.join(tmpDir, "forks");
    fs.mkdirSync(forksDir, { recursive: true });

    // Force an archive error: archiveDir sits under a regular file → mkdir ENOTDIR.
    const blocker = path.join(tmpDir, "blocker");
    fs.writeFileSync(blocker, "");
    const badArchive = path.join(blocker, "sub");

    writePid(pidsDir, "dead1", { heartbeatAt: isoAgo(5 * 60_000) });

    const { calls, onLog } = captureLog();
    await runTick(pidsDir, {
      archiveDir: badArchive,
      forksDir,
      killPids: false,
      checkPid: false,
      onLog,
    });

    const warn = calls.find((c) => c.msg === "janitor tick had errors");
    expect(warn).toBeDefined();
    expect(warn!.level).toBe("warn");
    expect(warn!.attrs).toHaveProperty("count");
    expect((warn!.attrs!.count as number) > 0).toBe(true);
    expect(Array.isArray(warn!.attrs!.errors)).toBe(true);
    expect((warn!.attrs!.errors as string[]).length > 0).toBe(true);
  });

  it("does NOT emit a 'tick had errors' record on a clean tick (errors.length === 0)", async () => {
    const pidsDir = path.join(tmpDir, "pids");
    const archiveDir = path.join(tmpDir, "pids-archive");
    const forksDir = path.join(tmpDir, "forks");
    fs.mkdirSync(pidsDir, { recursive: true });
    fs.mkdirSync(forksDir, { recursive: true });

    const { calls, onLog } = captureLog();
    await runTick(pidsDir, {
      archiveDir,
      forksDir,
      killPids: false,
      checkPid: false,
      onLog,
    });

    const warn = calls.find((c) => c.msg === "janitor tick had errors");
    expect(warn).toBeUndefined();
  });
});

// ── Layer 2: tickOnce → createCuratorLogger bridge (module mock) ────────────
//
// Verifies the production entry path (pi-curator-janitor.ts) constructs a
// `curator.janitor`-scoped logger and forwards runTick's onLog records into it
// at the matching level. The mock replaces createCuratorLogger with a capturing
// fake so we can assert the bridge wiring without touching disk for logs.

describe("tickOnce — createCuratorLogger bridge (jLog ← onLog)", () => {
  type Emit = { level: string; msg: string; attrs?: Record<string, unknown> };

  // Hoisted capture: vi.mock is hoisted to the top of the file, so the capture
  // array + scope records must live in a hoisted mutable holder.
  const holder = vi.hoisted(() => ({
    emits: [] as Emit[],
    scopes: [] as Array<{ scope: string }>,
    persistentAttrs: [] as Array<Record<string, unknown>>,
  }));

  vi.mock("../util/logger.js", () => {
    const makeFake = (scope: string) => {
      const fn = (level: string) => (msg: string, attrs?: Record<string, unknown>) => {
        holder.emits.push({ level, msg, attrs });
      };
      return {
        trace: fn("trace"),
        debug: fn("debug"),
        info: fn("info"),
        warn: fn("warn"),
        error: fn("error"),
        // child() not used by the janitor; minimal stub for type completeness.
        child: () => makeFake(scope),
      };
    };
    return {
      createCuratorLogger: (opts: { scope: string; persistentAttrs?: Record<string, unknown> }) => {
        holder.scopes.push({ scope: opts.scope });
        if (opts.persistentAttrs) holder.persistentAttrs.push(opts.persistentAttrs);
        return makeFake(opts.scope);
      },
    };
  });

  beforeEach(() => {
    holder.emits.length = 0;
    holder.scopes.length = 0;
    holder.persistentAttrs.length = 0;
  });

  it("constructs the janitor logger with scope 'curator.janitor' and persistent dir attrs", async () => {
    const { main } = await import("./pi-curator-janitor.js");
    const pidsDir = path.join(tmpDir, "pids");
    const archiveDir = path.join(tmpDir, "pids-archive");
    const forksDir = path.join(tmpDir, "forks");
    const logsDir = path.join(tmpDir, "logs");
    fs.mkdirSync(pidsDir, { recursive: true });
    fs.mkdirSync(forksDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await main([
        "node", "src/janitor/pi-curator-janitor.ts", "--once",
        "--pids-dir", pidsDir,
        "--archive-dir", archiveDir,
        "--forks-dir", forksDir,
        "--logs-dir", logsDir,
      ]);
    } finally {
      logSpy.mockRestore();
    }

    // One logger built per session-dir sweep (>=1). All carry the janitor scope.
    expect(holder.scopes.length).toBeGreaterThanOrEqual(1);
    for (const s of holder.scopes) {
      expect(s).toMatchObject({ scope: "curator.janitor" });
    }
    // persistentAttrs carry the operational roots.
    const firstAttrs = holder.persistentAttrs[0] ?? {};
    expect(firstAttrs).toHaveProperty("pidsRoot");
    expect(firstAttrs).toHaveProperty("archiveDir");
    expect(firstAttrs).toHaveProperty("forksDir");
  });

  it("forwards runTick onLog records into jLog at the matching level (tick start + complete)", async () => {
    const { main } = await import("./pi-curator-janitor.js");
    const pidsDir = path.join(tmpDir, "pids");
    const archiveDir = path.join(tmpDir, "pids-archive");
    const forksDir = path.join(tmpDir, "forks");
    const logsDir = path.join(tmpDir, "logs");
    fs.mkdirSync(pidsDir, { recursive: true });
    fs.mkdirSync(forksDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await main([
        "node", "src/janitor/pi-curator-janitor.ts", "--once",
        "--pids-dir", pidsDir,
        "--archive-dir", archiveDir,
        "--forks-dir", forksDir,
        "--logs-dir", logsDir,
      ]);
    } finally {
      logSpy.mockRestore();
    }

    // The bridge forwards onLog → jLog[level]. With a clean tick (empty pids),
    // every sweep dir emits at least a tick start + tick complete at INFO level.
    const tickStarts = holder.emits.filter((e) => e.msg === "janitor tick start");
    const tickCompletes = holder.emits.filter((e) => e.msg === "janitor tick complete");
    expect(tickStarts.length).toBeGreaterThanOrEqual(1);
    expect(tickCompletes.length).toBeGreaterThanOrEqual(1);

    // Every forwarded record is at the level the bridge selected — no leakage
    // of an undefined level from a mis-wired onLog callback.
    const knownLevels = new Set(["trace", "debug", "info", "warn", "error"]);
    for (const e of holder.emits) {
      expect(knownLevels.has(e.level)).toBe(true);
    }
    // Tick start + complete are always info; the bridge maps "info" → jLog.info.
    for (const e of [...tickStarts, ...tickCompletes]) {
      expect(e.level).toBe("info");
    }
  });

  it("forwards a reaped-dead-curator info record when a dead curator is swept", async () => {
    const { main } = await import("./pi-curator-janitor.js");
    const pidsDir = path.join(tmpDir, "pids");
    const archiveDir = path.join(tmpDir, "pids-archive");
    const forksDir = path.join(tmpDir, "forks");
    const logsDir = path.join(tmpDir, "logs");
    fs.mkdirSync(forksDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    writePid(path.join(pidsDir, "sess-1"), "dead1", {
      pid: 99999, // no such OS process → no real SIGTERM
      heartbeatAt: isoAgo(5 * 60_000), // dead
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await main([
        "node", "src/janitor/pi-curator-janitor.ts", "--once",
        "--pids-dir", pidsDir,
        "--archive-dir", archiveDir,
        "--forks-dir", forksDir,
        "--logs-dir", logsDir,
      ]);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }

    const reaped = holder.emits.find((e) => e.msg === "reaped dead curator");
    expect(reaped).toBeDefined();
    expect(reaped!.level).toBe("info");
    expect(reaped!.attrs).toMatchObject({
      pid: 99999,
      "persona.alias": "dead1",
      "session.id": "sess-1",
    });
  });
});
