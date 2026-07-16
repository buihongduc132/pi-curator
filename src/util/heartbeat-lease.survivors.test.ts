/**
 * heartbeat-lease.survivors.test.ts — kills surviving mutants in
 * src/util/heartbeat-lease.ts.
 *
 * Survivor analysis:
 *  - id 2722 (parsePositiveNumber `parsed > 0` → `parsed >= 0`): KILL by passing
 *    env value "0" — must fall back to default, not 0.
 *  - id 2717 / 2729 (`if (!value) return fallback/null` → `if (false)`): genuinely
 *    EQUIVALENT — for any falsy `value` (undefined/""/null), the subsequent
 *    `Number.parseFloat(value)` / `Date.parse(value)` yields NaN, which the
 *    `Number.isFinite(...)` guards already collapse to the fallback/null branch.
 *    Removing the early return changes nothing observable.
 */
import { describe, it, expect } from "vitest";
import { getCuratorHeartbeatConfig, parseIsoMs } from "./heartbeat-lease.js";

describe("heartbeat-lease survivors", () => {
  it("getCuratorHeartbeatConfig: env '0' falls back to default (kills parsed >= 0 mutant)", () => {
    // parsePositiveNumber("0") → parseFloat=0, 0>0 false → fallback (default 5).
    // Mutant `0 >= 0` would return 0 instead of the default 5.
    const c = getCuratorHeartbeatConfig({
      PI_CURATOR_HEARTBEAT_INTERVAL_SEC: "0",
      PI_CURATOR_HEARTBEAT_STALE_SEC: "0",
      PI_CURATOR_HEARTBEAT_DEAD_SEC: "0",
    });
    expect(c.intervalSec).toBe(5);
    expect(c.staleSec).toBe(30);
    expect(c.deadSec).toBe(120);
  });

  it("getCuratorHeartbeatConfig: env '0.0' also falls back to default", () => {
    const c = getCuratorHeartbeatConfig({ PI_CURATOR_HEARTBEAT_STALE_SEC: "0.0" });
    expect(c.staleSec).toBe(30);
  });

  it("parseIsoMs returns null for falsy inputs (documents equivalent mutants)", () => {
    // Covers the `if (!value) return null` early-return (id 2729). Removing it
    // → Date.parse(undefined|"") = NaN → isFinite false → null. Same outcome.
    expect(parseIsoMs(undefined)).toBeNull();
    expect(parseIsoMs("")).toBeNull();
    expect(parseIsoMs(null)).toBeNull();
  });
});
