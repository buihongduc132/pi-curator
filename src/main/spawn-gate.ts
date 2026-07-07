/**
 * spawn-gate.ts — pure spawn-gate logic for curator sidecars (REQ-LC-01).
 *
 * The main-side `turn_end` hook evaluates, per persona, whether the gate
 * passes: `turnsSinceLastSpawn >= spawn.everyTurns` OR
 * `minsSinceLastSpawn >= spawn.everyMins`. The gate is non-blocking; this
 * module is pure logic (no fs, no spawn, no Date.now). The caller decides
 * what to do with a `spawn:true` result.
 */

import type { ResolvedPersona } from "../util/config.js";

export interface SpawnGateInput {
  persona: ResolvedPersona;
  /** Number of turns since the last spawn for this persona. */
  turnsSinceLastSpawn: number;
  /** Number of minutes since the last spawn for this persona. */
  minsSinceLastSpawn: number;
}

export interface SpawnGateResult {
  spawn: boolean;
  /** Human-readable reason for the decision. */
  reason: string;
}

/**
 * Evaluate the curator spawn gate for a single persona (REQ-LC-01).
 *
 * Rules:
 * - Persona disabled (`enabled:false`) → no spawn.
 * - Neither `spawn.everyTurns` nor `spawn.everyMins` configured → no spawn.
 * - `turnsSinceLastSpawn >= everyTurns` OR `minsSinceLastSpawn >= everyMins`
 *   → spawn.
 * - Otherwise → no spawn.
 *
 * Pure.
 */
export function evaluateSpawnGate(input: SpawnGateInput): SpawnGateResult {
  const { persona } = input;
  if (!persona.enabled) {
    return { spawn: false, reason: `persona ${persona.alias} is disabled` };
  }
  const everyTurns = persona.spawn?.everyTurns;
  const everyMins = persona.spawn?.everyMins;
  const hasTurns = typeof everyTurns === "number";
  const hasMins = typeof everyMins === "number";

  if (!hasTurns && !hasMins) {
    return {
      spawn: false,
      reason: `persona ${persona.alias} has no spawn.everyTurns or spawn.everyMins`,
    };
  }

  const byTurns = hasTurns && input.turnsSinceLastSpawn >= everyTurns;
  const byMins = hasMins && input.minsSinceLastSpawn >= everyMins;

  if (byTurns || byMins) {
    return {
      spawn: true,
      reason: `persona ${persona.alias} gate satisfied (turns=${input.turnsSinceLastSpawn}, mins=${input.minsSinceLastSpawn})`,
    };
  }

  return {
    spawn: false,
    reason: `persona ${persona.alias} gate not satisfied (turns=${input.turnsSinceLastSpawn}, mins=${input.minsSinceLastSpawn})`,
  };
}

export {};
