import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  appendEntry,
  mailboxPath,
  readMailbox,
  type MailboxFs,
} from "./mailbox.js";
import { serializeEntry, type Finding } from "./finding.js";

// ─── In-memory fake filesystem ──────────────────────────────────────────────

interface FakeFile {
  content: string; // full file content
}

function makeMemFs(): MailboxFs & {
  files: Map<string, FakeFile>;
  reads: number;
  appends: number;
} {
  const files = new Map<string, FakeFile>();
  let reads = 0;
  let appends = 0;
  return {
    files,
    reads,
    appends,
    async readFile(path) {
      reads++;
      const f = files.get(path);
      return f ? f.content : null;
    },
    async appendLine(path, line) {
      appends++;
      const existing = files.get(path);
      const content = existing ? existing.content + line + "\n" : line + "\n";
      files.set(path, { content });
    },
    async mkdirp(_dir) {
      /* no-op in memory */
    },
  } as MailboxFs & {
    files: Map<string, FakeFile>;
    reads: number;
    appends: number;
  };
}

// Mutator helpers: the above reads/appends counters are captured at creation
// and won't update, so we read .reads/.appends off the object's prototype via
// closures. To keep tests simple, we re-read the maps directly.

describe("mailboxPath", () => {
  it("joins root/findings/<id>/shared.jsonl", () => {
    expect(mailboxPath("m1", { root: "/tmp/x" })).toBe(
      "/tmp/x/findings/m1/shared.jsonl",
    );
  });
  it("uses ~/.pi-curator by default", () => {
    const p = mailboxPath("m1");
    expect(p.endsWith("/.pi-curator/findings/m1/shared.jsonl")).toBe(true);
  });
  it("resolves relative root against cwd", () => {
    const p = mailboxPath("m1", { root: "rel" });
    expect(p.includes("findings/m1/shared.jsonl")).toBe(true);
    expect(p.endsWith("/findings/m1/shared.jsonl")).toBe(true);
  });
});

describe("readMailbox", () => {
  it("returns empty when file missing", async () => {
    const fs = makeMemFs();
    const out = await readMailbox("/m/shared.jsonl", fs);
    expect(out).toEqual([]);
  });
  it("returns parsed entries for a valid mailbox", async () => {
    const fs = makeMemFs();
    const line1 =
      '{"type":"finding","topic":"t","curator":"a","ts":"2026-07-07T10:00:00.000Z","severity":"info","summary":"s"}';
    const line2 =
      '{"type":"agreement","topic":"t","curator":"b","ts":"2026-07-07T10:01:00.000Z","severity":"info"}';
    fs.files.set("/m/shared.jsonl", { content: `${line1}\n${line2}\n` });
    const out = await readMailbox("/m/shared.jsonl", fs);
    expect(out).toHaveLength(2);
    expect(out[0].type).toBe("finding");
    expect(out[1].type).toBe("agreement");
  });
  it("skips blank + malformed lines (fail-open)", async () => {
    const fs = makeMemFs();
    fs.files.set("/m/shared.jsonl", {
      content: "{garbage\n\n" +
        '{"type":"finding","topic":"t","curator":"a","ts":"x","severity":"info","summary":"s"}\n' +
        '{"type":"vote"}\n',
    });
    const out = await readMailbox("/m/shared.jsonl", fs);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("finding");
  });
  it("fail-open: readFile throw returns [] (never rejects)", async () => {
    const boom: MailboxFs = {
      readFile: () => Promise.reject(new Error("perm denied")),
      appendLine: () => Promise.resolve(),
      mkdirp: () => Promise.resolve(),
    };
    await expect(readMailbox("/m/shared.jsonl", boom)).resolves.toEqual([]);
  });
});

describe("appendEntry", () => {
  it("appends a single line with trailing newline", async () => {
    const fs = makeMemFs();
    const finding: Finding = {
      type: "finding",
      topic: "t",
      curator: "a",
      ts: "2026-07-07T10:00:00.000Z",
      severity: "info",
      summary: "s",
    };
    await appendEntry("/m/shared.jsonl", finding, fs);
    const f = fs.files.get("/m/shared.jsonl");
    expect(f?.content).toBe(serializeEntry(finding) + "\n");
  });
  it("appends to an existing file (does not overwrite)", async () => {
    const fs = makeMemFs();
    fs.files.set("/m/shared.jsonl", { content: "existing\n" });
    const finding: Finding = {
      type: "finding",
      topic: "t",
      curator: "a",
      ts: "x",
      severity: "info",
      summary: "s",
    };
    await appendEntry("/m/shared.jsonl", finding, fs);
    const f = fs.files.get("/m/shared.jsonl");
    expect(f?.content).toBe("existing\n" + serializeEntry(finding) + "\n");
  });
  it("fail-open: appendLine throw is swallowed (never rejects)", async () => {
    const boom: MailboxFs = {
      readFile: () => Promise.resolve(null),
      appendLine: () => Promise.reject(new Error("disk full")),
      mkdirp: () => Promise.resolve(),
    };
    const finding: Finding = {
      type: "finding",
      topic: "t",
      curator: "a",
      ts: "x",
      severity: "info",
      summary: "s",
    };
    await expect(appendEntry("/m/shared.jsonl", finding, boom)).resolves.toBeUndefined();
  });
  it("fail-open: mkdirp throw is swallowed", async () => {
    const boom: MailboxFs = {
      readFile: () => Promise.resolve(null),
      appendLine: () => Promise.resolve(),
      mkdirp: () => Promise.reject(new Error("no perms")),
    };
    const finding: Finding = {
      type: "finding",
      topic: "t",
      curator: "a",
      ts: "x",
      severity: "info",
      summary: "s",
    };
    await expect(appendEntry("/m/shared.jsonl", finding, boom)).resolves.toBeUndefined();
  });
});

describe("end-to-end read-after-append (in-memory)", () => {
  it("write two findings, read both back", async () => {
    const fs = makeMemFs();
    const a: Finding = {
      type: "finding",
      topic: "t",
      curator: "spec",
      ts: "2026-07-07T10:00:00.000Z",
      severity: "critical",
      summary: "x",
    };
    const b: Finding = {
      type: "finding",
      topic: "t",
      curator: "quality",
      ts: "2026-07-07T10:05:00.000Z",
      severity: "warn",
      summary: "y",
    };
    await appendEntry("/m/shared.jsonl", a, fs);
    await appendEntry("/m/shared.jsonl", b, fs);
    const out = await readMailbox("/m/shared.jsonl", fs);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(a);
    expect(out[1]).toEqual(b);
  });
});

// ─── Mutation survivor remediation: real fs + DEBUG branches ─────────────────

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { makeRealFs } from "./mailbox.js";

describe("makeRealFs — real filesystem round-trip (tmpdir)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-mb-real-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("readFile returns null for a missing file (ENOENT path)", async () => {
    // Kills: line 50-58 NoCoverage (readFile catch + ENOENT branch) +
    // line 58 ConditionalExpression/EqualityOperator on `code === "ENOENT"`.
    const real = makeRealFs();
    const missing = path.join(dir, "nope", "shared.jsonl");
    await expect(real.readFile(missing)).resolves.toBeNull();
  });

  it("readFile returns contents for an existing file", async () => {
    // Kills: line 50-58 happy-path NoCoverage.
    const real = makeRealFs();
    const p = path.join(dir, "shared.jsonl");
    fs.writeFileSync(p, "hello\n", "utf8");
    await expect(real.readFile(p)).resolves.toBe("hello\n");
  });

  it("readFile rethrows on a non-ENOENT error (e.g. reading a directory)", async () => {
    // Kills: line 58 EqualityOperator `code !== "ENOENT"` mutant (would swallow
    // the EISDIR error and return null instead of rethrowing).
    const real = makeRealFs();
    // Reading a directory throws EISDIR (not ENOENT) → must propagate.
    await expect(real.readFile(dir)).rejects.toThrow();
  });

  it("mkdirp creates nested directories", async () => {
    // Kills: line 65/67 NoCoverage.
    const real = makeRealFs();
    const nested = path.join(dir, "a", "b", "c");
    await real.mkdirp(nested);
    expect(fs.existsSync(nested)).toBe(true);
  });

  it("appendLine creates the file and appends atomically", async () => {
    // Kills: line 71/73 NoCoverage (appendLine + O_APPEND 'a' flag).
    const real = makeRealFs();
    const p = path.join(dir, "shared.jsonl");
    await real.appendLine(p, '{"a":1}');
    await real.appendLine(p, '{"b":2}');
    expect(fs.readFileSync(p, "utf8")).toBe('{"a":1}\n{"b":2}\n');
  });

  it("readMailbox reads back entries written via real fs (end-to-end)", async () => {
    // Covers the full real-fs happy path through the public API.
    const real = makeRealFs();
    const p = path.join(dir, "shared.jsonl");
    const finding: Finding = {
      type: "finding",
      topic: "t",
      curator: "c",
      ts: "2026-07-07T10:00:00.000Z",
      severity: "info",
      summary: "s",
    };
    await appendEntry(p, finding, real);
    const out = await readMailbox(p, real);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(finding);
  });
});

describe("readMailbox / appendEntry — DEBUG logging branches", () => {
  const REAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...REAL_ENV };
  });

  it("logs to console.debug when DEBUG includes 'curator' and readFile throws", async () => {
    // Kills: line 103 ConditionalExpression/LogicalOperator/EqualityOperator +
    // OptionalChaining on process.env?.DEBUG — only the truthy branch logs.
    process.env.DEBUG = "curator";
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const boom: MailboxFs = {
      readFile: () => Promise.reject(new Error("boom")),
      appendLine: () => Promise.resolve(),
      mkdirp: () => Promise.resolve(),
    };
    await expect(readMailbox("/x/shared.jsonl", boom)).resolves.toEqual([]);
    expect(debugSpy).toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it("stays silent when DEBUG does NOT include 'curator'", async () => {
    // Kills: line 103 ConditionalExpression→true (would log unconditionally).
    process.env.DEBUG = "something-else";
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const boom: MailboxFs = {
      readFile: () => Promise.reject(new Error("boom")),
      appendLine: () => Promise.resolve(),
      mkdirp: () => Promise.resolve(),
    };
    await expect(readMailbox("/x/shared.jsonl", boom)).resolves.toEqual([]);
    expect(debugSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it("logs when appendEntry fails and DEBUG includes 'curator'", async () => {
    // Kills: line 129 ConditionalExpression/LogicalOperator/EqualityOperator +
    // OptionalChaining + line 128 BlockStatement (catch body).
    process.env.DEBUG = "curator";
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const boom: MailboxFs = {
      readFile: () => Promise.resolve(null),
      appendLine: () => Promise.reject(new Error("disk full")),
      mkdirp: () => Promise.resolve(),
    };
    const finding: Finding = {
      type: "finding",
      topic: "t",
      curator: "c",
      ts: "x",
      severity: "info",
      summary: "s",
    };
    await expect(appendEntry("/x/shared.jsonl", finding, boom)).resolves.toBeUndefined();
    expect(debugSpy).toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it("stays silent on append failure when DEBUG omits 'curator'", async () => {
    // Kills: line 129 ConditionalExpression→true (would log unconditionally).
    delete process.env.DEBUG;
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const boom: MailboxFs = {
      readFile: () => Promise.resolve(null),
      appendLine: () => Promise.reject(new Error("disk full")),
      mkdirp: () => Promise.resolve(),
    };
    const finding: Finding = {
      type: "finding",
      topic: "t",
      curator: "c",
      ts: "x",
      severity: "info",
      summary: "s",
    };
    await expect(appendEntry("/x/shared.jsonl", finding, boom)).resolves.toBeUndefined();
    expect(debugSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();
  });
});

describe("readMailbox — null-text early return", () => {
  it("returns [] when readFile returns null (early bail, not via catch)", () => {
    // NOTE: line 94 ConditionalExpression→false is an EQUIVALENT mutant — when
    // the early return is skipped, null.split() throws and the catch still
    // returns []. This test documents the contract but cannot distinguish.
    const fsNull: MailboxFs = {
      readFile: () => Promise.resolve(null),
      appendLine: () => Promise.resolve(),
      mkdirp: () => Promise.resolve(),
    };
    return expect(readMailbox("/m/shared.jsonl", fsNull)).resolves.toEqual([]);
  });
});
