/**
 * index-knowncurators-throw.test.ts — kills the ArrayDeclaration survivor
 * (line 47: `let knownCurators: string[] = []` -> `["Stryker was here"]`).
 *
 * That initial value is only observable when `getCachedConfig` THROWS (the
 * catch leaves knownCurators at its initializer). Under the mutant a sender
 * literally named "Stryker was here" would then be re-delivered (it is in the
 * list); under the original it is filtered out. We force the throw via
 * vi.mock so the catch path is exercised.
 */
// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:os";

vi.mock("../util/config.js", () => ({
  // Force the index.ts try-block to throw so knownCurators stays at its
  // initial value (mutant: ["Stryker was here"]).
  getCachedConfig: () => {
    throw new Error("forced config load failure");
  },
  enabledPersonas: (cfg: any) => cfg?.curators ?? {},
}));

describe("curator-receiver entry — knownCurators initializer on config throw", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a sender named 'Stryker was here' is NEVER re-delivered (kills ArrayDeclaration mutant)", async () => {
    const mod = await import("./index");
    const sendMessage = vi.fn();
    const pi: any = { on: vi.fn(), sendMessage };
    const ctx: any = {
      cwd: path.join(fs.tmpdir(), "noop"),
      sessionId: "ses_main",
      ui: { notify: vi.fn() },
    };
    mod.default(pi, ctx);
    const handler = pi.on.mock.calls.find((c: any[]) => c[0] === "message_start")[1];

    const event = {
      message: {
        customType: "intercom_message",
        content: "**📨 From Stryker was here** (/p)\n\n[STEER] body",
        details: {
          from: { name: "Stryker was here", id: "id-sh" },
          bodyText: "[STEER] body",
        },
      },
    };
    handler(event, ctx);
    // Original: knownCurators=[] -> sender filtered out.
    // Mutant:   knownCurators=["Stryker was here"] -> sender matches -> re-delivered.
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
