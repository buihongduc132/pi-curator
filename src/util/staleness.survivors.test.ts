/**
 * staleness.survivors.test.ts — kills surviving mutants in src/util/staleness.ts.
 *
 * Survivors:
 *  - id 2779 (`opts.config ?? DEFAULT` → `opts.config && DEFAULT`): KILL by
 *    passing a custom config whose thresholds produce a different classification
 *    than the default.
 *  - id 2803 (`files.filter(f => f.endsWith(".json"))` → `files`): KILL by
 *    placing a NON-.json file whose CONTENT is a valid claim — the mutant would
 *    read+parse it as an entry.
 *  - id 2818/2819 (sort comparator): KILL by asserting strict alphabetical order
 *    with ≥2 out-of-order entries.
 *  - id 2811 (readdir catch `return []`): KILL by reading a missing dir → [].
 *
 * EQUIVALENT:
 *  - id 2813 (readFile catch → continue): emptying it leaves `raw` undefined;
 *    the immediately-following `JSON.parse(undefined)` throws and is caught by
 *    the next `catch { continue }` → entry skipped identically.
 *  - id 2832 (`else if (e.liveness === "dead")`): only reached when liveness is
 *    neither "live" nor "stale" — for the classified entries that is always
 *    "dead", so mutating the condition to `true` is a no-op.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  classifyLiveness,
  readPidEntries,
  summarizeLiveness,
  type CuratorPidEntry,
} from "./staleness.js";

const NOW = new Date("2026-07-16T00:00:00Z").getTime();
const iso = (ageSec: number) => new Date(NOW - ageSec * 1000).toISOString();

function entry(opts: Partial<CuratorPidEntry> & { curator: string }): CuratorPidEntry {
  return {
    type: "message",
    pid: 99999,
    mainSessionId: "ses-main",
    curator: opts.curator,
    spawnedAt: iso(100),
    heartbeatAt: opts.heartbeatAt ?? iso(10),
    phase: opts.phase ?? "scanning",
  } as CuratorPidEntry;
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "staleness-surv-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("staleness survivors", () => {
  it("classifyLiveness honors a custom config (kills opts.config ?? DEFAULT mutant)", () => {
    // Heartbeat 5s old. Default config (30/120) → "live".
    // Custom config staleSec=1, deadSec=2 → "dead".
    const e = entry({ curator: "x", heartbeatAt: iso(5) });
    const withDefault = classifyLiveness(e, { nowMs: NOW, checkPid: false });
    expect(withDefault).toBe("live");
    const withCustom = classifyLiveness(e, {
      nowMs: NOW,
      checkPid: false,
      config: { intervalSec: 1, staleSec: 1, deadSec: 2 },
    });
    expect(withCustom).toBe("dead");
  });

  it("readPidEntries ignores a non-.json file even when its content is valid claim JSON (kills filter mutant)", async () => {
    const dir = path.join(tmp, "ses");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify(entry({ curator: "spec" })));
    // A non-.json file containing a perfectly valid claim. The mutant
    // (drop the .endsWith filter) would read+parse this into a 2nd entry.
    fs.writeFileSync(path.join(dir, "spec.lock"), JSON.stringify(entry({ curator: "spec2" })));
    const entries = await readPidEntries(dir, { nowMs: NOW, checkPid: false });
    expect(entries).toHaveLength(1);
    expect(entries[0].curator).toBe("spec");
  });

  it("readPidEntries returns strictly alphabetical order (kills sort comparator mutants)", async () => {
    const dir = path.join(tmp, "ses");
    fs.mkdirSync(dir, { recursive: true });
    // Written in reverse-alpha filesystem order; result MUST be alpha-sorted.
    fs.writeFileSync(path.join(dir, "zeta.json"), JSON.stringify(entry({ curator: "zeta" })));
    fs.writeFileSync(path.join(dir, "mike.json"), JSON.stringify(entry({ curator: "mike" })));
    fs.writeFileSync(path.join(dir, "alpha.json"), JSON.stringify(entry({ curator: "alpha" })));
    const entries = await readPidEntries(dir, { nowMs: NOW, checkPid: false });
    expect(entries.map((e) => e.curator)).toEqual(["alpha", "mike", "zeta"]);
  });

  it("readPidEntries returns [] for a missing dir (kills readdir-catch mutant)", async () => {
    const entries = await readPidEntries(path.join(tmp, "does-not-exist"), {
      nowMs: NOW,
      checkPid: false,
    });
    expect(entries).toEqual([]);
  });

  it("summarizeLiveness: only live/stale/dead counted (documents dead-branch equivalent)", () => {
    // The `else if (liveness === "dead")` branch is only reachable for "dead".
    const entries = [
      { liveness: "live" },
      { liveness: "stale" },
      { liveness: "dead" },
      { liveness: "dead" },
    ] as never;
    const s = summarizeLiveness(entries);
    expect(s).toEqual({ live: 1, stale: 1, dead: 2, total: 4 });
  });
});
