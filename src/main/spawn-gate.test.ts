/**
 * spawn-gate.test.ts — unit tests for the pure spawn-gate evaluator.
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

describe("evaluateSpawnGate", () => {
  it("spawns when turns threshold is reached", () => {
    const result = evaluateSpawnGate({
      persona: persona({ spawn: { everyTurns: 5 } }),
      turnsSinceLastSpawn: 5,
      minsSinceLastSpawn: 0,
    });
    expect(result.spawn).toBe(true);
  });

  it("spawns when minutes threshold is reached", () => {
    const result = evaluateSpawnGate({
      persona: persona({ spawn: { everyMins: 10 } }),
      turnsSinceLastSpawn: 0,
      minsSinceLastSpawn: 10,
    });
    expect(result.spawn).toBe(true);
  });

  it("spawns when either threshold is satisfied", () => {
    const result = evaluateSpawnGate({
      persona: persona({ spawn: { everyTurns: 5, everyMins: 60 } }),
      turnsSinceLastSpawn: 5,
      minsSinceLastSpawn: 0,
    });
    expect(result.spawn).toBe(true);
  });

  it("does not spawn when both thresholds are unconfigured", () => {
    const result = evaluateSpawnGate({
      persona: persona(),
      turnsSinceLastSpawn: 100,
      minsSinceLastSpawn: 100,
    });
    expect(result.spawn).toBe(false);
  });

  it("does not spawn when below both thresholds", () => {
    const result = evaluateSpawnGate({
      persona: persona({ spawn: { everyTurns: 10, everyMins: 30 } }),
      turnsSinceLastSpawn: 3,
      minsSinceLastSpawn: 15,
    });
    expect(result.spawn).toBe(false);
  });

  it("does not spawn when turns below but minutes above (only minutes configured)", () => {
    const result = evaluateSpawnGate({
      persona: persona({ spawn: { everyMins: 20 } }),
      turnsSinceLastSpawn: 100,
      minsSinceLastSpawn: 20,
    });
    expect(result.spawn).toBe(true);
  });

  it("skips disabled personas", () => {
    const result = evaluateSpawnGate({
      persona: persona({ enabled: false, spawn: { everyTurns: 1 } }),
      turnsSinceLastSpawn: 99,
      minsSinceLastSpawn: 99,
    });
    expect(result.spawn).toBe(false);
    expect(result.reason).toMatch(/disabled/);
  });
});
