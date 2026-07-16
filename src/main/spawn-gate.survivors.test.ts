/**
 * spawn-gate.survivors.test.ts — kills ALL 4 surviving mutants in
 * src/main/spawn-gate.ts via the "neither everyTurns nor everyMins" reason:
 *  - id 1512/1516 (hasTurns/hasMins typeof → true)
 *  - id 1521 (gate condition → false)
 *  - id 1525 (gate block → empty)
 *
 * With neither field set, the original returns a reason mentioning
 * "no spawn.everyTurns or spawn.everyMins". Every one of these mutants would
 * instead fall through to the "gate not satisfied" reason.
 */
import { describe, it, expect } from "vitest";
import { evaluateSpawnGate } from "./spawn-gate.js";
import type { ResolvedPersona } from "../util/config.js";

const basePersona = (over: Partial<ResolvedPersona> = {}): ResolvedPersona =>
  ({
    enabled: true,
    alias: "spec",
    scope: "main-only",
    includeThinking: false,
    appendDisplay: false,
    heartbeat: { intervalSec: 5, staleSec: 30, deadSec: 120 },
    ...over,
  }) as ResolvedPersona;

describe("spawn-gate survivors — neither-configured reason", () => {
  it("persona with neither everyTurns nor everyMins → reason names the missing fields", () => {
    const r = evaluateSpawnGate({
      persona: basePersona(),
      turnsSinceLastSpawn: 100,
      minsSinceLastSpawn: 100,
    });
    expect(r.spawn).toBe(false);
    expect(r.reason).toContain("no spawn.everyTurns");
    expect(r.reason).toContain("everyMins");
  });

  it("persona with only everyMins does not hit the neither-branch", () => {
    const r = evaluateSpawnGate({
      persona: basePersona({ spawn: { everyMins: 5 } }),
      turnsSinceLastSpawn: 0,
      minsSinceLastSpawn: 100,
    });
    expect(r.spawn).toBe(true);
    expect(r.reason).toContain("gate satisfied");
  });

  it("persona with only everyTurns does not hit the neither-branch", () => {
    const r = evaluateSpawnGate({
      persona: basePersona({ spawn: { everyTurns: 3 } }),
      turnsSinceLastSpawn: 5,
      minsSinceLastSpawn: 0,
    });
    expect(r.spawn).toBe(true);
  });
});
