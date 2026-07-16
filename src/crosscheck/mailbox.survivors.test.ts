/**
 * mailbox.survivors.test.ts — kills surviving mutants in src/crosscheck/mailbox.ts.
 *
 * Survivors (all killable via the DEBUG-debug-log path + console spy):
 *  - id 303/318 (`if (DEBUG?.includes("curator"))` → `true`): when DEBUG is unset
 *    the mutant still calls console.debug in the fail-open catch.
 *  - id 307/322 (`process.env?.DEBUG?.includes("curator")` → `process.env.DEBUG`):
 *    a truthy DEBUG that does NOT contain "curator" (e.g. "cur") must NOT log,
 *    but the mutant (truthy check) would.
 *
 * EQUIVALENT:
 *  - id 284 (appendLine `finally { handle.close() }` → empty): the write has
 *    already completed (awaited) before finally; an unclosed handle has no
 *    observable effect through the public MailboxFs contract.
 *  - id 291 (`if (text === null) return []` → `false`): the surrounding
 *    try/catch already returns [] on any throw, so dereferencing null.split
 *    under the mutant is caught → [] identically.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { readMailbox, appendEntry, makeRealFs, type MailboxFs } from "./mailbox.js";

describe("mailbox survivors — DEBUG log gating", () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let realFs: MailboxFs;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    realFs = makeRealFs();
  });
  afterEach(() => {
    debugSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("readMailbox: DEBUG unset → no debug log on fail-open (kills cond→true mutant)", async () => {
    vi.stubEnv("DEBUG", "");
    // Inject an fs whose readFile throws (non-ENOENT) to hit the fail-open catch.
    const throwingFs: MailboxFs = {
      readFile: async () => {
        throw new Error("boom");
      },
      appendLine: async () => undefined,
      mkdirp: async () => undefined,
    };
    const out = await readMailbox("/x", throwingFs);
    expect(out).toEqual([]);
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("readMailbox: DEBUG='cur' (truthy, no 'curator') → no debug log (kills optional-chaining mutant)", async () => {
    vi.stubEnv("DEBUG", "cur");
    const throwingFs: MailboxFs = {
      readFile: async () => {
        throw new Error("boom");
      },
      appendLine: async () => undefined,
      mkdirp: async () => undefined,
    };
    const out = await readMailbox("/x", throwingFs);
    expect(out).toEqual([]);
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("readMailbox: DEBUG includes 'curator' → DOES log (sanity)", async () => {
    vi.stubEnv("DEBUG", "curator");
    const throwingFs: MailboxFs = {
      readFile: async () => {
        throw new Error("boom");
      },
      appendLine: async () => undefined,
      mkdirp: async () => undefined,
    };
    await readMailbox("/x", throwingFs);
    expect(debugSpy).toHaveBeenCalled();
  });

  it("appendEntry: DEBUG unset → no debug log on append failure (kills cond→true mutant)", async () => {
    vi.stubEnv("DEBUG", "");
    const throwingFs: MailboxFs = {
      readFile: async () => null,
      appendLine: async () => {
        throw new Error("boom");
      },
      mkdirp: async () => undefined,
    };
    // Should not throw (fail-open).
    await expect(
      appendEntry("/x/y", { type: "finding", topic: "t", curator: "c", ts: "t", severity: "info", summary: "s" }, throwingFs),
    ).resolves.toBeUndefined();
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("appendEntry: DEBUG='cur' → no debug log (kills optional-chaining mutant)", async () => {
    vi.stubEnv("DEBUG", "cur");
    const throwingFs: MailboxFs = {
      readFile: async () => null,
      appendLine: async () => {
        throw new Error("boom");
      },
      mkdirp: async () => undefined,
    };
    await appendEntry("/x/y", { type: "finding", topic: "t", curator: "c", ts: "t", severity: "info", summary: "s" }, throwingFs);
    expect(debugSpy).not.toHaveBeenCalled();
  });
});
