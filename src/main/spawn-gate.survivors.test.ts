/**
 * spawn-gate.survivors.test.ts — kills the 4 remaining mutants.
 * All 4 mutate the `!hasTurns && !hasMins` early-return: either force
 * hasTurns/hasMins to `true`, force the `if` condition to `false`, or empty
 * the block. They all change the resulting `reason` string when no spawn
 * config is set (falling through to "gate not satisfied" instead of the
 * dedicated "has no spawn..." reason). Asserting the reason kills all four.
 */

import { describe, it, expect } from "vitest";
import { evaluateSpawnGate } from "./spawn-gate.js";
import type { ResolvedPersona } from "../util/config.js";

function persona(overrides: Partial<ResolvedPersona> = {}): ResolvedPersona {
  return {
    alias: "spec",
    enabled: true,
    scope: "main-only",
    includeThinking: false,
    appendDisplay: false,
    heartbeat: { intervalSec: 5, staleSec: 30, deadSec: 120 },
    ...overrides,
  };
}

describe("evaluateSpawnGate — reason strings (kill early-return mutants)", () => {
  it("reports the dedicated no-config reason when no spawn config (kills hasTurns/hasMins/condition/block mutants)", () => {
    const result = evaluateSpawnGate({
      persona: persona(),
      turnsSinceLastSpawn: 0,
      minsSinceLastSpawn: 0,
    });
    expect(result.spawn).toBe(false);
    expect(result.reason).toContain("has no spawn");
    expect(result.reason).not.toContain("gate not satisfied");
  });

  it("reports the disabled reason verbatim (alias embedded)", () => {
    const result = evaluateSpawnGate({
      persona: persona({ alias: "rev", enabled: false }),
      turnsSinceLastSpawn: 0,
      minsSinceLastSpawn: 0,
    });
    expect(result.spawn).toBe(false);
    expect(result.reason).toBe("persona rev is disabled");
  });

  it("reports satisfied reason with both counters embedded", () => {
    const result = evaluateSpawnGate({
      persona: persona({ alias: "rev", spawn: { everyTurns: 3, everyMins: 20 } }),
      turnsSinceLastSpawn: 4,
      minsSinceLastSpawn: 22,
    });
    expect(result.spawn).toBe(true);
    expect(result.reason).toContain("gate satisfied");
    expect(result.reason).toContain("turns=4");
    expect(result.reason).toContain("mins=22");
  });

  it("reports not-satisfied reason when below thresholds (hasTurns true, everyTurns number)", () => {
    const result = evaluateSpawnGate({
      persona: persona({ alias: "rev", spawn: { everyTurns: 10, everyMins: 30 } }),
      turnsSinceLastSpawn: 3,
      minsSinceLastSpawn: 15,
    });
    expect(result.spawn).toBe(false);
    expect(result.reason).toContain("gate not satisfied");
    expect(result.reason).toContain("turns=3");
    expect(result.reason).toContain("mins=15");
  });

  it("exact boundary: turns === everyTurns satisfies", () => {
    const result = evaluateSpawnGate({
      persona: persona({ spawn: { everyTurns: 5 } }),
      turnsSinceLastSpawn: 5,
      minsSinceLastSpawn: 999,
    });
    expect(result.spawn).toBe(true);
  });

  it("one below boundary: turns === everyTurns-1 does not satisfy via turns", () => {
    const result = evaluateSpawnGate({
      persona: persona({ spawn: { everyTurns: 5 } }),
      turnsSinceLastSpawn: 4,
      minsSinceLastSpawn: 0,
    });
    expect(result.spawn).toBe(false);
    expect(result.reason).toContain("gate not satisfied");
  });
});
