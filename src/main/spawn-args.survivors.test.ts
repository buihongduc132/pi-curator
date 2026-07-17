/**
 * spawn-args.survivors.test.ts — kills remaining spawn-args mutants.
 *
 * Survivors were all in resolveTaskPrompt's custom-branch guard:
 *   - L108 `custom.trim().length > 0` mutants (>, >=, .trim removal): a
 *     whitespace-only custom prompt must fall back to the default template.
 *   - L110 `mainSessionName ?? mainSessionId` -> `&&` mutant: when a name is
 *     supplied, the custom branch must embed the NAME (not the id).
 *
 * (Mutant 39 `piBin ?? "pi"` -> `&&` is a genuine equivalent: `piBin` is the
 * spawn executable, not part of the returned `args`; it is unobservable in
 * buildSpawnArgs's result. Documented, not killable.)
 */

import { describe, it, expect } from "vitest";
import { resolveTaskPrompt } from "./spawn-args.js";
import type { ResolvedPersona } from "../util/config.js";

function persona(overrides: Partial<ResolvedPersona> = {}): ResolvedPersona {
  return {
    alias: "spec",
    enabled: true,
    scope: "main-only",
    includeThinking: false,
    appendDisplay: false,
    heartbeat: { intervalSec: 5, staleSec: 30, deadSec: 120 },
    goalFile: "/goals/spec.md",
    ...overrides,
  };
}

describe("resolveTaskPrompt — custom-branch guard (kill >0/>=/trim mutants)", () => {
  it("whitespace-only custom prompt falls back to default template (kills >0, >=0, .trim-removal)", () => {
    const prompt = resolveTaskPrompt(persona({ taskPrompt: "    " }), {
      mainSessionId: "s1",
      mainSessionName: "sess-name",
      goalContents: "goal body",
    });
    // default template marker
    expect(prompt).toContain("curator:spec");
    expect(prompt).toContain("goal body");
    // must NOT be the whitespace custom
    expect(prompt).not.toBe("    ");
    expect(prompt.length).toBeGreaterThan(10);
  });

  it("tab/newline-only custom prompt also falls back to default", () => {
    const prompt = resolveTaskPrompt(persona({ taskPrompt: "\t\n  " }), {
      mainSessionId: "s1",
      goalContents: "g",
    });
    expect(prompt).toContain("curator:spec");
  });

  it("custom branch embeds the supplied mainSessionName (kills ?? -> && mutant)", () => {
    const p = persona({ taskPrompt: "name=<mainSessionName> id=<mainSessionId>" });
    const prompt = resolveTaskPrompt(p, {
      mainSessionId: "the-id",
      mainSessionName: "the-name",
      goalContents: "g",
    });
    expect(prompt).toBe("name=the-name id=the-id");
  });

  it("custom branch falls back to id when name missing (?? semantics)", () => {
    const p = persona({ taskPrompt: "name=<mainSessionName>" });
    const prompt = resolveTaskPrompt(p, {
      mainSessionId: "the-id",
      goalContents: "g",
    });
    expect(prompt).toBe("name=the-id");
  });
});
