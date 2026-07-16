/**
 * spawn-args.test.ts — unit tests for the pure argv builder.
 */

import { describe, it, expect } from "vitest";
import {
  buildSpawnArgs,
  renderDefaultTaskPrompt,
  resolveTaskPrompt,
  type BuildSpawnArgsInput,
} from "./spawn-args.js";
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

const RUNTIME_PATH = "/repo/src/runtime/index.ts";
const INTERCOM_PATH = "/repo/node_modules/pi-intercom/index.ts";

/** Minimal required input (with the two new REQ-CR-06 extension paths). */
function baseInput(
  overrides: Partial<BuildSpawnArgsInput> = {},
): BuildSpawnArgsInput {
  return {
    persona: persona(),
    filteredJsonlPath: "/tmp/fork.jsonl",
    mainSessionId: "sess-1",
    runtimeExtensionPath: RUNTIME_PATH,
    intercomExtensionPath: INTERCOM_PATH,
    ...overrides,
  };
}

describe("buildSpawnArgs", () => {
  it("builds the minimal command (fork + goal + name + prompt)", () => {
    const { args } = buildSpawnArgs(baseInput());
    expect(args).toContain("--fork");
    expect(args).toContain("/tmp/fork.jsonl");
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("/goals/spec.md");
    expect(args).toContain("--name");
    expect(args).toContain("curator:spec");
    expect(args).toContain("-p");
  });

  it("emits --no-extensions FIRST (REQ-CR-06 recursion guard)", () => {
    const { args } = buildSpawnArgs(baseInput());
    expect(args).toContain("--no-extensions");
    expect(args[0]).toBe("--no-extensions");
  });

  it("emits -e <runtime> and -e <intercom> after --no-extensions (REQ-CR-06)", () => {
    const { args } = buildSpawnArgs(baseInput());
    // First two args are --no-extensions; then the two -e pairs.
    expect(args[1]).toBe("-e");
    expect(args[2]).toBe(RUNTIME_PATH);
    expect(args[3]).toBe("-e");
    expect(args[4]).toBe(INTERCOM_PATH);
    // exactly two -e flags
    const eFlags = args.filter((a) => a === "-e");
    expect(eFlags).toHaveLength(2);
  });

  it("throws when runtimeExtensionPath is missing (REQ-CR-06 required)", () => {
    expect(() =>
      buildSpawnArgs({
        persona: persona(),
        filteredJsonlPath: "/tmp/fork.jsonl",
        mainSessionId: "sess-1",
        runtimeExtensionPath: "",
        intercomExtensionPath: INTERCOM_PATH,
      }),
    ).toThrow(/runtimeExtensionPath is required/);
  });

  it("throws when intercomExtensionPath is missing (REQ-CR-06 required)", () => {
    expect(() =>
      buildSpawnArgs({
        persona: persona(),
        filteredJsonlPath: "/tmp/fork.jsonl",
        mainSessionId: "sess-1",
        runtimeExtensionPath: RUNTIME_PATH,
        intercomExtensionPath: "",
      }),
    ).toThrow(/intercomExtensionPath is required/);
  });

  it("injects goalContents into the task prompt (D7)", () => {
    const { taskPrompt } = buildSpawnArgs(
      baseInput({ goalContents: "Nudge on skipped skills." }),
    );
    expect(taskPrompt).toContain("Nudge on skipped skills.");
  });

  it("includes --model when persona.model is set", () => {
    const { args } = buildSpawnArgs(baseInput({ persona: persona({ model: "qwen3-coder" }) }));
    expect(args).toContain("--model");
    expect(args).toContain("qwen3-coder");
  });

  it("omits --model when persona.model is unset", () => {
    const { args } = buildSpawnArgs(baseInput());
    expect(args).not.toContain("--model");
  });

  it("includes --exclude-tools when persona.excludeTools is set", () => {
    const { args } = buildSpawnArgs(
      baseInput({ persona: persona({ excludeTools: ["bash", "edit"] }) }),
    );
    expect(args).toContain("--exclude-tools");
    expect(args).toContain("bash,edit");
    expect(args).not.toContain("--tools");
  });

  it("includes --tools when persona.tools is set", () => {
    const { args } = buildSpawnArgs(
      baseInput({ persona: persona({ tools: ["read", "grep"] }) }),
    );
    expect(args).toContain("--tools");
    expect(args).toContain("read,grep");
    expect(args).not.toContain("--exclude-tools");
  });

  it("omits BOTH --tools and --exclude-tools when neither is set", () => {
    const { args } = buildSpawnArgs(baseInput());
    expect(args).not.toContain("--tools");
    expect(args).not.toContain("--exclude-tools");
  });

  it("throws when BOTH excludeTools and tools are set (mutual exclusion)", () => {
    expect(() =>
      buildSpawnArgs(
        baseInput({ persona: persona({ excludeTools: ["bash"], tools: ["read"] }) }),
      ),
    ).toThrow(/mutually exclusive/);
  });

  it("uses the provided piBin when set", () => {
    const { args } = buildSpawnArgs(baseInput({ piBin: "/usr/local/bin/pi" }));
    // piBin is the executable, not in args; args starts with --no-extensions.
    // The caller does: spawn(piBin, args).
    expect(args[0]).toBe("--no-extensions");
  });

  it("omits goalFile flag when persona.goalFile is unset", () => {
    const { args } = buildSpawnArgs(baseInput({ persona: persona({ goalFile: undefined }) }));
    expect(args).not.toContain("--append-system-prompt");
  });
});

describe("renderDefaultTaskPrompt", () => {
  it("injects alias, session name, id, and goal contents", () => {
    const prompt = renderDefaultTaskPrompt({
      alias: "scold",
      mainSessionId: "abc123",
      mainSessionName: "my-session",
      goalContents: "Nudge on skipped skills.",
    });
    expect(prompt).toContain("curator:scold");
    expect(prompt).toContain("my-session");
    expect(prompt).toContain("abc123");
    expect(prompt).toContain("Nudge on skipped skills.");
    expect(prompt).toContain("signal_main");
    expect(prompt).toContain('kind="steer"');
    expect(prompt).toContain('kind="append"');
  });

  it("defaults mainSessionName to the id when not supplied", () => {
    const prompt = renderDefaultTaskPrompt({
      alias: "spec",
      mainSessionId: "xyz",
      goalContents: "goal",
    });
    expect(prompt).toContain("(id: xyz)");
    expect(prompt).toContain("session xyz");
  });
});

describe("resolveTaskPrompt", () => {
  it("uses custom taskPrompt when set", () => {
    const personaCustom = persona({ taskPrompt: "Custom: <alias> on <mainSessionId>" });
    const prompt = resolveTaskPrompt(personaCustom, {
      mainSessionId: "s1",
      goalContents: "g",
    });
    expect(prompt).toBe("Custom: spec on s1");
  });

  it("falls back to default template when taskPrompt is empty", () => {
    const prompt = resolveTaskPrompt(persona(), {
      mainSessionId: "s1",
      mainSessionName: "sess",
      goalContents: "goal body",
    });
    expect(prompt).toContain("curator:spec");
    expect(prompt).toContain("goal body");
  });
});
