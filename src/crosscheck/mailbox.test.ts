import { describe, it, expect } from "vitest";
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
