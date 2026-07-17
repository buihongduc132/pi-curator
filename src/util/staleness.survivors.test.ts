/**
 * staleness.survivors.test.ts — kills remaining staleness mutants.
 *
 * Gaps in the prior suite:
 *  - mutant 1 (classifyLiveness `opts.config ?? DEFAULT` -> `&&`): the prior
 *    suite only tested assessHeartbeatFreshness with a custom config, never
 *    classifyLiveness. A custom config must change the verdict.
 *  - mutant 25 (readPidEntries `.filter(.json)` removed): prior .txt test used
 *    invalid JSON ("hi"). A .txt file with VALID claim JSON must still be
 *    excluded by the filter.
 *  - mutants 40/41 (results.sort comparator removed/->undefined): prior sort
 *    test used filenames whose readdir order already matched curator order.
 *    Decoupling filename order from curator alias order makes the sort
 *    observable.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { classifyLiveness, readPidEntries } from "./staleness.js";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const SEC = 1000;
function iso(secsAgo: number): string {
  return new Date(NOW - secsAgo * SEC).toISOString();
}
function killAlive(): (pid: number, signal: 0) => void {
  return () => undefined;
}
function makeEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid: 12345,
    mainSessionId: "ses-main",
    curator: "spec",
    spawnedAt: iso(60),
    heartbeatAt: iso(10),
    phase: "scanning",
    ...over,
  };
}

describe("classifyLiveness — honors custom config (kills ?? -> && mutant)", () => {
  it("a heartbeat that is LIVE under default (30s) is DEAD under a tight custom config", () => {
    const entry = makeEntry({ heartbeatAt: iso(25) }); // 25s old
    // default staleSec=30 -> live
    expect(classifyLiveness(entry as never, { nowMs: NOW, checkPid: false })).toBe("live");
    // custom staleSec=5, deadSec=15 -> 25s > 15s -> dead
    const tight = { intervalSec: 2, staleSec: 5, deadSec: 15 };
    expect(
      classifyLiveness(entry as never, { nowMs: NOW, checkPid: false, config: tight }),
    ).toBe("dead");
  });

  it("custom config moves a mid-age heartbeat into stale", () => {
    const entry = makeEntry({ heartbeatAt: iso(40) }); // 40s old
    // default: stale (30<40<=120)
    expect(classifyLiveness(entry as never, { nowMs: NOW, checkPid: false })).toBe("stale");
    // custom staleSec=10 deadSec=60 -> 10<40<=60 -> stale (same), but custom
    // staleSec=10 deadSec=35 -> 40>35 -> dead. Verify custom deadSec respected.
    const custom = { intervalSec: 2, staleSec: 10, deadSec: 35 };
    expect(
      classifyLiveness(entry as never, { nowMs: NOW, checkPid: false, config: custom }),
    ).toBe("dead");
  });
});

describe("readPidEntries — filter + sort (kills filter/sort mutants)", () => {
  let tmpDir: string;
  it("excludes a .txt file even when it contains valid claim JSON (kills filter-removal mutant)", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stal-surv-"));
    const dir = path.join(tmpDir, "ses-main");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify(makeEntry({ curator: "spec" })));
    // A .txt file with VALID claim JSON — without the .json filter this would
    // be parsed and included as a curator entry.
    fs.writeFileSync(
      path.join(dir, "intruder.txt"),
      JSON.stringify(makeEntry({ curator: "intruder" })),
    );
    const entries = await readPidEntries(dir, { nowMs: NOW, kill: killAlive() });
    expect(entries.map((e) => e.curator)).toEqual(["spec"]);
    expect(entries).toHaveLength(1);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sorts by curator alias regardless of filename order (kills sort-removal + comparator mutants)", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stal-sort-"));
    const dir = path.join(tmpDir, "ses-main");
    fs.mkdirSync(dir, { recursive: true });
    // Filename order ("1" < "2" < "3") is the readdir order; curator aliases
    // are intentionally in REVERSE so the sort is the ONLY thing producing
    // alphabetical output.
    fs.writeFileSync(path.join(dir, "1.json"), JSON.stringify(makeEntry({ curator: "zulu" })));
    fs.writeFileSync(path.join(dir, "2.json"), JSON.stringify(makeEntry({ curator: "mike" })));
    fs.writeFileSync(path.join(dir, "3.json"), JSON.stringify(makeEntry({ curator: "alpha" })));
    const entries = await readPidEntries(dir, { nowMs: NOW, kill: killAlive() });
    expect(entries.map((e) => e.curator)).toEqual(["alpha", "mike", "zulu"]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
