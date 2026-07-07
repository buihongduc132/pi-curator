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
import { main } from "./pi-curator-janitor.js";

let tmpRoot: string;

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
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
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
