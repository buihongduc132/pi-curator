/**
 * staleness.test.ts — co-located unit tests for curator liveness classification
 * (REQ-LC-06, foundation T3).
 *
 * Test matrix (from task description):
 *   - 5s/30s/120s heartbeat thresholds → live/stale/dead
 *   - dead-pid fast-path (process.kill fails → dead)
 *   - missing/invalid heartbeat → dead
 *   - readPidEntries (filesystem integration)
 *   - summarizeLiveness / formatLivenessStatus
 *
 * Tests inject `nowMs` and a fake `kill` so they never touch real processes.
 * Heartbeat-lease and team-attach-claim pure helpers are also covered here.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  classifyLiveness,
  heartbeatAgeMs,
  readPidEntries,
  summarizeLiveness,
  formatLivenessStatus,
} from "./staleness";
import {
  assessHeartbeatFreshness,
  getCuratorHeartbeatConfig,
  isSlotHeld,
  DEFAULT_HEARTBEAT_CONFIG,
} from "./heartbeat-lease";
import {
  isSlotFree,
  assessClaimFreshness,
  parseCuratorClaim,
  acquireCuratorClaim,
  heartbeatCuratorClaim,
  releaseCuratorClaim,
  curatorClaimFile,
  defaultPidRoot,
} from "./team-attach-claim";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Fixed "now" for deterministic tests: 2026-01-01T00:00:00Z = 1767225600000. */
const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const SEC = 1000;

/** ISO timestamp `secs` seconds before NOW. */
function iso(secsAgo: number): string {
  return new Date(NOW - secsAgo * SEC).toISOString();
}

/** A fake kill that always succeeds (process alive). */
function killAlive(): (pid: number, signal: 0) => void {
  return () => undefined;
}

/** A fake kill that always throws ESRCH (process gone). */
function killDead(): (pid: number, signal: 0) => void {
  const err: NodeJS.ErrnoException = new Error("no such process");
  err.code = "ESRCH";
  return () => {
    throw err;
  };
}

/** A fake kill that throws EPERM (process exists, no permission). */
function killNoPerm(): (pid: number, signal: 0) => void {
  const err: NodeJS.ErrnoException = new Error("operation not permitted");
  err.code = "EPERM";
  return () => {
    throw err;
  };
}

function makeEntry(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
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

// ─── getCuratorHeartbeatConfig (defaults + env) ─────────────────────────────

describe("getCuratorHeartbeatConfig (defaults + env)", () => {
  it("defaults to 5s/30s/120s", () => {
    const c = getCuratorHeartbeatConfig({});
    expect(c.intervalSec).toBe(5);
    expect(c.staleSec).toBe(30);
    expect(c.deadSec).toBe(120);
  });

  it("reads env overrides (seconds)", () => {
    const c = getCuratorHeartbeatConfig({
      PI_CURATOR_HEARTBEAT_INTERVAL_SEC: "7",
      PI_CURATOR_HEARTBEAT_STALE_SEC: "45",
      PI_CURATOR_HEARTBEAT_DEAD_SEC: "180",
    });
    expect(c.intervalSec).toBe(7);
    expect(c.staleSec).toBe(45);
    expect(c.deadSec).toBe(180);
  });

  it("ignores invalid env values (falls back to defaults)", () => {
    const c = getCuratorHeartbeatConfig({
      PI_CURATOR_HEARTBEAT_STALE_SEC: "not-a-number",
      PI_CURATOR_HEARTBEAT_DEAD_SEC: "-5",
    });
    expect(c.staleSec).toBe(30);
    expect(c.deadSec).toBe(120);
  });
});

// ─── assessHeartbeatFreshness (5s/30s/120s thresholds) ──────────────────────

describe("assessHeartbeatFreshness (5s/30s/120s thresholds, REQ-LC-06)", () => {
  it("age ≤ 30s → live (reason fresh)", () => {
    // 10s ago
    const f = assessHeartbeatFreshness(iso(10), NOW);
    expect(f.classification).toBe("live");
    expect(f.reason).toBe("fresh");
    expect(f.ageMs).toBe(10 * SEC);
  });

  it("age exactly 30s → live (boundary inclusive)", () => {
    const f = assessHeartbeatFreshness(iso(30), NOW);
    expect(f.classification).toBe("live");
  });

  it("30s < age ≤ 120s → stale", () => {
    const f = assessHeartbeatFreshness(iso(60), NOW);
    expect(f.classification).toBe("stale");
    expect(f.reason).toBe("stale");
  });

  it("age just over 30s → stale", () => {
    const f = assessHeartbeatFreshness(iso(31), NOW);
    expect(f.classification).toBe("stale");
  });

  it("age exactly 120s → stale (boundary inclusive)", () => {
    const f = assessHeartbeatFreshness(iso(120), NOW);
    expect(f.classification).toBe("stale");
  });

  it("age > 120s → dead", () => {
    const f = assessHeartbeatFreshness(iso(121), NOW);
    expect(f.classification).toBe("dead");
    expect(f.reason).toBe("dead");
  });

  it("missing heartbeatAt → dead (reason missing)", () => {
    const f = assessHeartbeatFreshness(undefined, NOW);
    expect(f.classification).toBe("dead");
    expect(f.reason).toBe("missing");
    expect(f.ageMs).toBeNull();
  });

  it("invalid heartbeatAt → dead (reason invalid)", () => {
    const f = assessHeartbeatFreshness("not-a-date", NOW);
    expect(f.classification).toBe("dead");
    expect(f.reason).toBe("invalid");
    expect(f.ageMs).toBeNull();
  });

  it("honors custom config thresholds", () => {
    // custom: staleSec=10, deadSec=20
    const config = { intervalSec: 2, staleSec: 10, deadSec: 20 };
    expect(assessHeartbeatFreshness(iso(5), NOW, config).classification).toBe("live");
    expect(assessHeartbeatFreshness(iso(15), NOW, config).classification).toBe("stale");
    expect(assessHeartbeatFreshness(iso(25), NOW, config).classification).toBe("dead");
  });

  it("future heartbeat (clock skew) → clamped to age 0, live", () => {
    const f = assessHeartbeatFreshness(new Date(NOW + 5000).toISOString(), NOW);
    expect(f.ageMs).toBe(0);
    expect(f.classification).toBe("live");
  });
});

// ─── isSlotHeld ──────────────────────────────────────────────────────────────

describe("isSlotHeld (REQ-LC-07)", () => {
  it("returns true for live/stale heartbeats", () => {
    expect(isSlotHeld(iso(10), NOW)).toBe(true); // live
    expect(isSlotHeld(iso(60), NOW)).toBe(true); // stale
  });

  it("returns false for dead/missing heartbeats (slot free)", () => {
    expect(isSlotHeld(iso(200), NOW)).toBe(false); // dead
    expect(isSlotHeld(undefined, NOW)).toBe(false); // missing
  });
});

// ─── classifyLiveness (dead-pid fast-path) ──────────────────────────────────

describe("classifyLiveness (REQ-LC-06 + dead-pid fast-path)", () => {
  it("live: fresh heartbeat AND pid alive", () => {
    const entry = makeEntry({ heartbeatAt: iso(10) });
    expect(classifyLiveness(entry as never, { nowMs: NOW, kill: killAlive() })).toBe("live");
  });

  it("stale: 30-120s heartbeat AND pid alive", () => {
    const entry = makeEntry({ heartbeatAt: iso(60) });
    expect(classifyLiveness(entry as never, { nowMs: NOW, kill: killAlive() })).toBe("stale");
  });

  it("dead: heartbeat > 120s (even if pid alive)", () => {
    const entry = makeEntry({ heartbeatAt: iso(200) });
    expect(classifyLiveness(entry as never, { nowMs: NOW, kill: killAlive() })).toBe("dead");
  });

  it("dead-pid fast-path: process.kill fails (ESRCH) → dead regardless of heartbeat", () => {
    // Fresh heartbeat (10s ago) but PID is gone.
    const entry = makeEntry({ heartbeatAt: iso(10) });
    expect(classifyLiveness(entry as never, { nowMs: NOW, kill: killDead() })).toBe("dead");
  });

  it("EPERM (process exists, no permission) → treated as alive, classify by heartbeat", () => {
    const entry = makeEntry({ heartbeatAt: iso(10) });
    expect(classifyLiveness(entry as never, { nowMs: NOW, kill: killNoPerm() })).toBe("live");
  });

  it("checkPid disabled → classify purely by heartbeat (no kill call)", () => {
    const entry = makeEntry({ heartbeatAt: iso(60) });
    expect(classifyLiveness(entry as never, { nowMs: NOW, checkPid: false })).toBe("stale");
  });

  it("missing heartbeat → dead (even with pid alive)", () => {
    const entry = makeEntry({ heartbeatAt: undefined });
    expect(classifyLiveness(entry as never, { nowMs: NOW, kill: killAlive() })).toBe("dead");
  });

  it("invalid pid (0 or negative) → dead (treated as gone)", () => {
    const entry = makeEntry({ pid: 0, heartbeatAt: iso(10) });
    expect(classifyLiveness(entry as never, { nowMs: NOW, kill: killAlive() })).toBe("dead");
  });
});

// ─── heartbeatAgeMs ─────────────────────────────────────────────────────────

describe("heartbeatAgeMs", () => {
  it("returns age in ms", () => {
    const entry = makeEntry({ heartbeatAt: iso(10) });
    expect(heartbeatAgeMs(entry as never, NOW)).toBe(10 * SEC);
  });

  it("returns Infinity for missing/invalid heartbeat", () => {
    expect(heartbeatAgeMs(makeEntry({ heartbeatAt: undefined }) as never, NOW)).toBe(Infinity);
    expect(heartbeatAgeMs(makeEntry({ heartbeatAt: "bad" }) as never, NOW)).toBe(Infinity);
  });
});

// ─── summarizeLiveness / formatLivenessStatus ───────────────────────────────

describe("summarizeLiveness + formatLivenessStatus", () => {
  it("counts live/stale/dead", () => {
    const entries = [
      { ...makeEntry({ curator: "a" }), liveness: "live" as const },
      { ...makeEntry({ curator: "b" }), liveness: "live" as const },
      { ...makeEntry({ curator: "c" }), liveness: "stale" as const },
      { ...makeEntry({ curator: "d" }), liveness: "dead" as const },
    ];
    const summary = summarizeLiveness(entries as never);
    expect(summary).toEqual({ live: 2, stale: 1, dead: 1, total: 4 });
  });

  it("formats the UI status string", () => {
    const summary = { live: 2, stale: 1, dead: 0, total: 3 };
    expect(formatLivenessStatus(summary)).toBe("curator: 2 live, 1 stale, 0 dead");
  });

  it("empty entries → all zero", () => {
    expect(summarizeLiveness([])).toEqual({ live: 0, stale: 0, dead: 0, total: 0 });
  });
});

// ─── team-attach-claim pure helpers ─────────────────────────────────────────

describe("parseCuratorClaim (validation)", () => {
  it("parses a valid claim", () => {
    const claim = parseCuratorClaim(makeEntry());
    expect(claim).not.toBeNull();
    expect(claim!.pid).toBe(12345);
    expect(claim!.curator).toBe("spec");
    expect(claim!.phase).toBe("scanning");
  });

  it("returns null when required fields are missing", () => {
    expect(parseCuratorClaim({ pid: 1, curator: "x" })).toBeNull(); // missing mainSessionId, timestamps, phase
    expect(parseCuratorClaim({ pid: "notnum", curator: "x", mainSessionId: "m", spawnedAt: "a", heartbeatAt: "b", phase: "p" })).toBeNull();
    expect(parseCuratorClaim(null)).toBeNull();
    expect(parseCuratorClaim("string")).toBeNull();
  });
});

describe("isSlotFree (REQ-LC-07)", () => {
  it("returns true when no claim (null)", () => {
    expect(isSlotFree(null, NOW)).toBe(true);
  });

  it("returns true when phase is terminal (done/killed/exiting)", () => {
    for (const phase of ["done", "killed", "exiting"]) {
      const entry = makeEntry({ phase, heartbeatAt: iso(1) }); // fresh heartbeat but terminal
      expect(isSlotFree(entry as never, NOW)).toBe(true);
    }
  });

  it("returns true when heartbeat is dead", () => {
    const entry = makeEntry({ heartbeatAt: iso(200), phase: "scanning" });
    expect(isSlotFree(entry as never, NOW)).toBe(true);
  });

  it("returns false when heartbeat is live and phase non-terminal", () => {
    const entry = makeEntry({ heartbeatAt: iso(1), phase: "scanning" });
    expect(isSlotFree(entry as never, NOW)).toBe(false);
  });

  it("returns true when heartbeat is stale (stale but non-terminal = reclaimable per isSlotFree)", () => {
    // Note: isSlotFree uses classification !== "live", so stale counts as free.
    const entry = makeEntry({ heartbeatAt: iso(60), phase: "scanning" });
    expect(isSlotFree(entry as never, NOW)).toBe(true);
  });
});

describe("assessClaimFreshness", () => {
  it("returns isStale:false for a fresh heartbeat", () => {
    const entry = makeEntry({ heartbeatAt: iso(1) });
    const f = assessClaimFreshness(entry as never, NOW);
    expect(f.isStale).toBe(false);
    expect(f.ageMs).toBe(1 * SEC);
  });

  it("returns isStale:true for an old heartbeat", () => {
    const entry = makeEntry({ heartbeatAt: iso(60) });
    const f = assessClaimFreshness(entry as never, NOW);
    expect(f.isStale).toBe(true);
  });

  it("returns Infinity age for invalid heartbeat", () => {
    const entry = makeEntry({ heartbeatAt: "bad" });
    const f = assessClaimFreshness(entry as never, NOW);
    expect(f.isStale).toBe(true);
    expect(f.ageMs).toBe(Infinity);
  });
});

// ─── team-attach-claim async fs primitives (integration via temp dirs) ─────

describe("acquire/heartbeat/release claim (fs integration)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-curator-test-"));
  });

  it("acquires a free slot, writes phase:spawned, and refreshes heartbeat", async () => {
    const file = path.join(tmpDir, "ses-main", "spec.json");
    // 1. Acquire (free).
    const acquired = await acquireCuratorClaim(file, {
      pid: 999,
      mainSessionId: "ses-main",
      curator: "spec",
      mainSessionName: "Main",
      nowMs: NOW,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    expect(acquired.claim.phase).toBe("spawned");
    expect(acquired.claim.pid).toBe(999);

    // File written.
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(onDisk.phase).toBe("spawned");
    expect(onDisk.pid).toBe(999);

    // 2. Heartbeat refresh updates heartbeatAt + phase.
    const hb = await heartbeatCuratorClaim(file, 999, { phase: "scanning", nowMs: NOW + 5000 });
    expect(hb).toBe("updated");
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(after.phase).toBe("scanning");
    expect(Date.parse(after.heartbeatAt)).toBe(NOW + 5000);
  });

  it("rejects a second acquirer while a fresh non-terminal holder exists", async () => {
    const file = path.join(tmpDir, "ses-main", "spec.json");
    await acquireCuratorClaim(file, {
      pid: 999,
      mainSessionId: "ses-main",
      curator: "spec",
      nowMs: NOW,
    });
    const second = await acquireCuratorClaim(file, {
      pid: 1000,
      mainSessionId: "ses-main",
      curator: "spec",
      nowMs: NOW + 1000, // still fresh
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe("claimed_by_other");
    // File unchanged (still holder 999).
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(onDisk.pid).toBe(999);
  });

  it("allows reclaiming a slot whose holder is dead (stale heartbeat)", async () => {
    const file = path.join(tmpDir, "ses-main", "spec.json");
    await acquireCuratorClaim(file, {
      pid: 999,
      mainSessionId: "ses-main",
      curator: "spec",
      nowMs: NOW,
    });
    // Much later — the old holder's heartbeat is now dead (>120s).
    const reclaimed = await acquireCuratorClaim(file, {
      pid: 1000,
      mainSessionId: "ses-main",
      curator: "spec",
      nowMs: NOW + 200 * 1000,
    });
    expect(reclaimed.ok).toBe(true);
    if (!reclaimed.ok) return;
    expect(reclaimed.claim.pid).toBe(1000);
    expect(reclaimed.replacedClaim).toBeDefined();
    expect(reclaimed.replacedClaim!.pid).toBe(999);
  });

  it("heartbeat from a non-owner pid → not_owner", async () => {
    const file = path.join(tmpDir, "ses-main", "spec.json");
    await acquireCuratorClaim(file, {
      pid: 999,
      mainSessionId: "ses-main",
      curator: "spec",
      nowMs: NOW,
    });
    const result = await heartbeatCuratorClaim(file, 777, { nowMs: NOW });
    expect(result).toBe("not_owner");
  });

  it("heartbeat on a missing file → missing", async () => {
    const file = path.join(tmpDir, "ses-main", "spec.json");
    const result = await heartbeatCuratorClaim(file, 999, { nowMs: NOW });
    expect(result).toBe("missing");
  });

  it("release deletes the claim file", async () => {
    const file = path.join(tmpDir, "ses-main", "spec.json");
    await acquireCuratorClaim(file, {
      pid: 999,
      mainSessionId: "ses-main",
      curator: "spec",
      nowMs: NOW,
    });
    expect(fs.existsSync(file)).toBe(true);
    const result = await releaseCuratorClaim(file, 999);
    expect(result).toBe("released");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("release by non-owner → not_owner", async () => {
    const file = path.join(tmpDir, "ses-main", "spec.json");
    await acquireCuratorClaim(file, {
      pid: 999,
      mainSessionId: "ses-main",
      curator: "spec",
      nowMs: NOW,
    });
    const result = await releaseCuratorClaim(file, 777);
    expect(result).toBe("not_owner");
    expect(fs.existsSync(file)).toBe(true);
  });
});

// ─── readPidEntries (filesystem integration) ────────────────────────────────

describe("readPidEntries (filesystem)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-curator-test-"));
  });

  it("reads and classifies all *.json pid files", async () => {
    const dir = path.join(tmpDir, "ses-main");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify(makeEntry({ curator: "spec", heartbeatAt: iso(10) })));
    fs.writeFileSync(path.join(dir, "scold.json"), JSON.stringify(makeEntry({ curator: "scold", heartbeatAt: iso(60) })));
    fs.writeFileSync(path.join(dir, "dead.json"), JSON.stringify(makeEntry({ curator: "dead", heartbeatAt: iso(200) })));

    const entries = await readPidEntries(dir, { nowMs: NOW, kill: killAlive() });
    expect(entries).toHaveLength(3);
    const byCurator = Object.fromEntries(entries.map((e) => [e.curator, e.liveness]));
    expect(byCurator.spec).toBe("live");
    expect(byCurator.scold).toBe("stale");
    expect(byCurator.dead).toBe("dead");
  });

  it("dead-pid fast-path marks a fresh-heartbeat entry dead when the process is gone", async () => {
    const dir = path.join(tmpDir, "ses-main");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify(makeEntry({ curator: "spec", heartbeatAt: iso(10) })));
    const entries = await readPidEntries(dir, { nowMs: NOW, kill: killDead() });
    expect(entries).toHaveLength(1);
    expect(entries[0].liveness).toBe("dead");
  });

  it("skips corrupt/invalid JSON files", async () => {
    const dir = path.join(tmpDir, "ses-main");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "good.json"), JSON.stringify(makeEntry({ curator: "good" })));
    fs.writeFileSync(path.join(dir, "bad.json"), "NOT JSON");
    fs.writeFileSync(path.join(dir, "invalid.json"), JSON.stringify({ not: "a claim" }));
    const entries = await readPidEntries(dir, { nowMs: NOW, kill: killAlive() });
    expect(entries).toHaveLength(1);
    expect(entries[0].curator).toBe("good");
  });

  it("ignores non-.json files", async () => {
    const dir = path.join(tmpDir, "ses-main");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify(makeEntry({ curator: "spec" })));
    fs.writeFileSync(path.join(dir, "spec.lock"), "{}");
    fs.writeFileSync(path.join(dir, "readme.txt"), "hi");
    const entries = await readPidEntries(dir, { nowMs: NOW, kill: killAlive() });
    expect(entries).toHaveLength(1);
  });

  it("returns [] when directory does not exist", async () => {
    const entries = await readPidEntries(path.join(tmpDir, "nope"), { nowMs: NOW });
    expect(entries).toEqual([]);
  });

  it("returns entries sorted by curator alias", async () => {
    const dir = path.join(tmpDir, "ses-main");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "zeta.json"), JSON.stringify(makeEntry({ curator: "zeta" })));
    fs.writeFileSync(path.join(dir, "alpha.json"), JSON.stringify(makeEntry({ curator: "alpha" })));
    const entries = await readPidEntries(dir, { nowMs: NOW, kill: killAlive() });
    expect(entries.map((e) => e.curator)).toEqual(["alpha", "zeta"]);
  });
});

// ─── path helpers ───────────────────────────────────────────────────────────

describe("path helpers", () => {
  it("defaultPidRoot → <home>/.pi-curator/pids", () => {
    expect(defaultPidRoot("/home/u")).toBe(path.join("/home/u", ".pi-curator", "pids"));
  });

  it("curatorClaimFile → <pidRoot>/<mainSessionId>/<curator>.json", () => {
    expect(curatorClaimFile("/home/u/.pi-curator/pids", "ses-main", "spec")).toBe(
      path.join("/home/u/.pi-curator/pids", "ses-main", "spec.json"),
    );
  });
});

// ─── Test scaffolding (makeTmpDir inlined in each beforeEach) ─────────────

// ─── curatorSessionId pointer surfacing (LD1) ───────────────────────────────
//
// RED PHASE: these tests are EXPECTED TO FAIL until the GREEN phase makes
// readPidEntries surface curatorSessionId via parseCuratorClaim.
//
// See: flow/findings/curator-observability/2026-07-07-locked-decisions.yaml LD1.

describe("readPidEntries — curatorSessionId surfacing (LD1)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-curator-test-"));
  });

  it("surfaces curatorSessionId when the pid file carries it", async () => {
    const dir = path.join(tmpDir, "ses-main");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "spec.json"),
      JSON.stringify(makeEntry({ curator: "spec", curatorSessionId: "ses_abc123" })),
    );
    const entries = await readPidEntries(dir, { nowMs: NOW, kill: killAlive() });
    expect(entries).toHaveLength(1);
    expect(entries[0].curatorSessionId).toBe("ses_abc123");
  });

  it("leaves curatorSessionId undefined for legacy entries (no pointer)", async () => {
    const dir = path.join(tmpDir, "ses-main");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "spec.json"),
      JSON.stringify(makeEntry({ curator: "spec" })), // no curatorSessionId
    );
    const entries = await readPidEntries(dir, { nowMs: NOW, kill: killAlive() });
    expect(entries).toHaveLength(1);
    expect(entries[0].curatorSessionId).toBeUndefined();
  });

  it("can mix legacy + pointer-bearing entries", async () => {
    const dir = path.join(tmpDir, "ses-main");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "legacy.json"),
      JSON.stringify(makeEntry({ curator: "legacy" })),
    );
    fs.writeFileSync(
      path.join(dir, "pointer.json"),
      JSON.stringify(makeEntry({ curator: "pointer", curatorSessionId: "ses_xyz" })),
    );
    const entries = await readPidEntries(dir, { nowMs: NOW, kill: killAlive() });
    const byCurator = Object.fromEntries(entries.map((e) => [e.curator, e.curatorSessionId]));
    expect(byCurator.legacy).toBeUndefined();
    expect(byCurator.pointer).toBe("ses_xyz");
  });
});
