/**
 * spawn-args.survivors.test.ts — kills surviving mutants in src/main/spawn-args.ts.
 *
 * Killable:
 *  - id 1429 (custom-prompt guard `typeof===string && trim().length>0` → true):
 *    an undefined taskPrompt must use the default template (mutant throws on .trim()).
 *  - id 1430 (`length > 0` → `>= 0`) & id 1432 (drop `.trim()`): a WHITESPACE-only
 *    custom taskPrompt must fall back to the default template.
 *  - id 1434 (`name ?? id` → `name && id`): passing a mainSessionName must surface
 *    in the rendered prompt (mutant collapses name→id).
 *
 * EQUIVALENT:
 *  - id 1442 (`piBin ?? "pi"` → `piBin && "pi"`): `piBin` is computed inside
 *    buildSpawnArgs but never referenced afterward (the executable is returned/
 *    used by the caller, not pushed into `args`), so the mutant has no observable
 *    effect.
 */
import { describe, it, expect } from "vitest";
import { buildSpawnArgs, resolveTaskPrompt } from "./spawn-args.js";
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

const inputBase = {
  filteredJsonlPath: "/tmp/fork.jsonl",
  mainSessionId: "ses-123",
  runtimeExtensionPath: "/tmp/rt.js",
  intercomExtensionPath: "/tmp/ic.js",
};

describe("spawn-args survivors", () => {
  it("undefined taskPrompt → default template, no throw (kills cond→true mutant)", () => {
    const { taskPrompt } = buildSpawnArgs({
      ...inputBase,
      persona: basePersona(),
    });
    expect(taskPrompt).toContain("You are curator:spec");
  });

  it("whitespace-only taskPrompt → default template (kills length>=0 / trim-removal mutants)", () => {
    const { taskPrompt } = buildSpawnArgs({
      ...inputBase,
      persona: basePersona({ taskPrompt: "    " }),
    });
    // Default template is used; whitespace prompt is NOT injected.
    expect(taskPrompt).toContain("You are curator:spec");
    expect(taskPrompt).toContain("Use the `signal_main` tool");
  });

  it("mainSessionName surfaces in the rendered prompt (kills name ?? id → name && id mutant)", () => {
    const p = resolveTaskPrompt(basePersona(), {
      mainSessionId: "ses-123",
      mainSessionName: "My Cool Session",
      goalContents: "G",
    });
    // The mutant (`name ?? id` → `name && id`) collapses name to the id, so the
    // display name MUST appear (the id alone would not).
    expect(p).toContain("My Cool Session");
  });

  it("custom taskPrompt is used when non-empty (covers the truthy branch)", () => {
    const p = resolveTaskPrompt(basePersona({ taskPrompt: "Custom <alias> <mainSessionId>" }), {
      mainSessionId: "ses-123",
      goalContents: "G",
    });
    expect(p).toBe("Custom spec ses-123");
  });
});
