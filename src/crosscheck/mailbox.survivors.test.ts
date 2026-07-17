/**
 * mailbox.survivors.test.ts — targets the fail-open DEBUG-log + null-check
 * mutants in readMailbox/appendEntry.
 *
 *  - mutant 27 (`if (text === null) return []` -> false): when injected
 *    readFile returns null, readMailbox must still resolve to [] WITHOUT
 *    invoking the debug logger (the early return short-circuits before catch).
 *  - mutants 43/58 (`process.env?.DEBUG?.includes` -> removes ?before .includes):
 *    on the error path with DEBUG UNSET, readMailbox/appendEntry must NOT
 *    throw a TypeError (the optional chaining on undefined DEBUG must hold).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readMailbox, appendEntry, type MailboxFs } from "./mailbox.js";
import { serializeEntry, type Finding } from "./finding.js";

function validFinding(): Finding {
  return {
    dedupKey: "k1",
    kind: "steer",
    curatorAlias: "spec",
    mainSessionId: "ses-main",
    summary: "s",
    bodyMarkdown: "b",
    severity: "info",
    at: 123,
  } as Finding;
}

describe("readMailbox — null-text short-circuit (kills text===null mutant)", () => {
  let realDebug: string | undefined;
  beforeEach(() => {
    realDebug = process.env.DEBUG;
    delete process.env.DEBUG;
  });
  afterEach(() => {
    if (realDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = realDebug;
  });

  it("resolves [] without debug log when readFile returns null", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const fs: MailboxFs = {
      readFile: async () => null,
      appendLine: async () => undefined,
      mkdirp: async () => undefined,
    };
    await expect(readMailbox("/m/shared.jsonl", fs)).resolves.toEqual([]);
    expect(debug).not.toHaveBeenCalled();
    debug.mockRestore();
  });

  it("does NOT throw on the error path when DEBUG is unset (kills ?.includes mutant)", async () => {
    // readFile throws a non-ENOENT error -> readMailbox catch fires -> evaluates
    // process.env?.DEBUG?.includes("curator") with DEBUG undefined. Removing the
    // ? before .includes would throw TypeError and reject. It must resolve [].
    const fs: MailboxFs = {
      readFile: async () => {
        throw new Error("boom");
      },
      appendLine: async () => undefined,
      mkdirp: async () => undefined,
    };
    await expect(readMailbox("/m/shared.jsonl", fs)).resolves.toEqual([]);
  });
});

describe("appendEntry — error path with DEBUG unset (kills ?.includes mutant)", () => {
  let realDebug: string | undefined;
  beforeEach(() => {
    realDebug = process.env.DEBUG;
    delete process.env.DEBUG;
  });
  afterEach(() => {
    if (realDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = realDebug;
  });

  it("swallows appendLine error without throwing when DEBUG unset", async () => {
    const fs: MailboxFs = {
      readFile: async () => null,
      appendLine: async () => {
        throw new Error("append boom");
      },
      mkdirp: async () => undefined,
    };
    await expect(appendEntry("/m/shared.jsonl", validFinding(), fs)).resolves.toBeUndefined();
  });
});

describe("DEBUG=curator exercises the debug-log branch", () => {
  let realDebug: string | undefined;
  beforeEach(() => {
    realDebug = process.env.DEBUG;
    process.env.DEBUG = "curator";
  });
  afterEach(() => {
    if (realDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = realDebug;
  });

  it("readMailbox logs to console.debug when DEBUG includes curator and readFile throws", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const fs: MailboxFs = {
      readFile: async () => {
        throw new Error("boom");
      },
      appendLine: async () => undefined,
      mkdirp: async () => undefined,
    };
    await readMailbox("/m/shared.jsonl", fs);
    expect(debug).toHaveBeenCalled();
    debug.mockRestore();
  });

  it("readMailbox does NOT log when readFile returns null (early return, no error)", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const fs: MailboxFs = {
      readFile: async () => null,
      appendLine: async () => undefined,
      mkdirp: async () => undefined,
    };
    await readMailbox("/m/shared.jsonl", fs);
    expect(debug).not.toHaveBeenCalled();
    debug.mockRestore();
  });
});
