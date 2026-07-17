import { describe, it, expect } from "vitest";
import {
  getCuratorHeartbeatConfig,
  parseIsoMs,
  assessHeartbeatFreshness,
  isSlotHeld,
  DEFAULT_HEARTBEAT_CONFIG,
} from "./heartbeat-lease";

describe("getCuratorHeartbeatConfig — env override parsing", () => {
  it("returns configured positive numbers (kills ternary->false mutant)", () => {
    const cfg = getCuratorHeartbeatConfig({
      PI_CURATOR_HEARTBEAT_INTERVAL_SEC: "10",
      PI_CURATOR_HEARTBEAT_STALE_SEC: "45",
      PI_CURATOR_HEARTBEAT_DEAD_SEC: "180",
    } as NodeJS.ProcessEnv);
    expect(cfg.intervalSec).toBe(10);
    expect(cfg.staleSec).toBe(45);
    expect(cfg.deadSec).toBe(180);
  });

  it("treats zero as INVALID and falls back (kills >0 -> >=0 mutant)", () => {
    const cfg = getCuratorHeartbeatConfig({
      PI_CURATOR_HEARTBEAT_INTERVAL_SEC: "0",
      PI_CURATOR_HEARTBEAT_STALE_SEC: "0",
      PI_CURATOR_HEARTBEAT_DEAD_SEC: "0",
    } as NodeJS.ProcessEnv);
    // 0 is not a positive number -> must fall back to defaults
    expect(cfg.intervalSec).toBe(DEFAULT_HEARTBEAT_CONFIG.intervalSec);
    expect(cfg.staleSec).toBe(DEFAULT_HEARTBEAT_CONFIG.staleSec);
    expect(cfg.deadSec).toBe(DEFAULT_HEARTBEAT_CONFIG.deadSec);
  });

  it("falls back on negative and non-numeric", () => {
    const cfg = getCuratorHeartbeatConfig({
      PI_CURATOR_HEARTBEAT_INTERVAL_SEC: "-5",
      PI_CURATOR_HEARTBEAT_STALE_SEC: "abc",
      PI_CURATOR_HEARTBEAT_DEAD_SEC: "NaN",
    } as NodeJS.ProcessEnv);
    expect(cfg.intervalSec).toBe(DEFAULT_HEARTBEAT_CONFIG.intervalSec);
    expect(cfg.staleSec).toBe(DEFAULT_HEARTBEAT_CONFIG.staleSec);
    expect(cfg.deadSec).toBe(DEFAULT_HEARTBEAT_CONFIG.deadSec);
  });

  it("falls back when env absent", () => {
    const cfg = getCuratorHeartbeatConfig({});
    expect(cfg).toEqual(DEFAULT_HEARTBEAT_CONFIG);
  });
});

describe("parseIsoMs", () => {
  it("parses a valid ISO timestamp to finite ms (kills ternary->false mutant)", () => {
    const ms = parseIsoMs("2024-01-01T00:00:00Z");
    expect(ms).not.toBeNull();
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBe(Date.parse("2024-01-01T00:00:00Z"));
  });

  it("returns null for empty/missing", () => {
    expect(parseIsoMs(undefined)).toBeNull();
    expect(parseIsoMs(null)).toBeNull();
    expect(parseIsoMs("")).toBeNull();
  });

  it("returns null for unparseable", () => {
    expect(parseIsoMs("not-a-date")).toBeNull();
  });
});

describe("assessHeartbeatFreshness classification", () => {
  const NOW = 1_000_000_000;
  it("missing -> dead/missing", () => {
    const f = assessHeartbeatFreshness(undefined, NOW);
    expect(f.classification).toBe("dead");
    expect(f.reason).toBe("missing");
    expect(f.ageMs).toBeNull();
    expect(f.lastSeenMs).toBeNull();
  });
  it("invalid -> dead/invalid", () => {
    const f = assessHeartbeatFreshness("garbage", NOW);
    expect(f.classification).toBe("dead");
    expect(f.reason).toBe("invalid");
  });
  it("live when age <= staleSec", () => {
    const hb = new Date(NOW - 10_000).toISOString();
    const f = assessHeartbeatFreshness(hb, NOW);
    expect(f.classification).toBe("live");
    expect(f.reason).toBe("fresh");
    expect(f.ageMs).toBe(10_000);
  });
  it("stale between stale and dead", () => {
    const hb = new Date(NOW - 60_000).toISOString();
    const f = assessHeartbeatFreshness(hb, NOW);
    expect(f.classification).toBe("stale");
    expect(f.reason).toBe("stale");
  });
  it("dead beyond deadSec", () => {
    const hb = new Date(NOW - 200_000).toISOString();
    const f = assessHeartbeatFreshness(hb, NOW);
    expect(f.classification).toBe("dead");
    expect(f.reason).toBe("dead");
  });
  it("age clamps negative to 0 (clock skew)", () => {
    const hb = new Date(NOW + 5_000).toISOString();
    const f = assessHeartbeatFreshness(hb, NOW);
    expect(f.ageMs).toBe(0);
    expect(f.classification).toBe("live");
  });
});

describe("isSlotHeld", () => {
  const NOW = 1_000_000_000;
  it("held when live or stale", () => {
    expect(isSlotHeld(new Date(NOW - 10_000).toISOString(), NOW)).toBe(true);
    expect(isSlotHeld(new Date(NOW - 60_000).toISOString(), NOW)).toBe(true);
  });
  it("free when dead/missing/invalid", () => {
    expect(isSlotHeld(new Date(NOW - 200_000).toISOString(), NOW)).toBe(false);
    expect(isSlotHeld(undefined, NOW)).toBe(false);
    expect(isSlotHeld("garbage", NOW)).toBe(false);
  });
});
