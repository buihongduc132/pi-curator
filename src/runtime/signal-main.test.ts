import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applySeverityRouting,
  buildContent,
  buildSignalPayload,
  createSignalMainTool,
  CURATOR_SIGNAL_TYPE,
  formatFallbackLine,
  KIND_PREFIX,
  normalizeKind,
  normalizeSeverity,
  resolveFindingsPath,
  writeFindingsFallback,
  type FallbackRecord,
  type IntercomClient,
  type SignalPayload,
} from "./signal-main.js";

const IDENTITY = {
  curatorAlias: "spec",
  mainSessionId: "main-abc",
  mainSessionName: "main-session",
  spawnedAt: "2026-07-07T00:00:00.000Z",
};

const tmpDirs: string[] = [];
function mkdtemp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pi-curator-runtime-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tmpDirs.length = 0;
});

// ─── normalization ─────────────────────────────────────────────────────────

describe("normalizeKind", () => {
  it("accepts steer/append case-insensitively", () => {
    expect(normalizeKind("steer")).toBe("steer");
    expect(normalizeKind("APPEND")).toBe("append");
    expect(normalizeKind("  Steer ")).toBe("steer");
  });
  it("rejects invalid kinds", () => {
    expect(() => normalizeKind("urgent")).toThrow();
    expect(() => normalizeKind("")).toThrow();
    expect(() => normalizeKind(123 as unknown as string)).toThrow();
  });
});

describe("normalizeSeverity", () => {
  it("defaults to info", () => {
    expect(normalizeSeverity(undefined)).toBe("info");
    expect(normalizeSeverity("")).toBe("info");
  });
  it("accepts info/warn/critical case-insensitively", () => {
    expect(normalizeSeverity("warn")).toBe("warn");
    expect(normalizeSeverity("CRITICAL")).toBe("critical");
  });
  it("rejects invalid severities", () => {
    expect(() => normalizeSeverity("severe")).toThrow();
  });
});

// ─── severity routing (REQ-SG-08) ──────────────────────────────────────────

describe("applySeverityRouting", () => {
  it("critical overrides kind to steer", () => {
    expect(applySeverityRouting("append", "critical")).toBe("steer");
    expect(applySeverityRouting("steer", "critical")).toBe("steer");
  });
  it("info/warn leave kind unchanged", () => {
    expect(applySeverityRouting("append", "info")).toBe("append");
    expect(applySeverityRouting("steer", "warn")).toBe("steer");
  });
});

// ─── buildContent (prefix) ─────────────────────────────────────────────────

describe("buildContent", () => {
  it("prepends the kind prefix (T0-Q4 receiver-compat)", () => {
    expect(buildContent("steer", "stop!")).toBe("[STEER] stop!");
    expect(buildContent("append", "note")).toBe("[APPEND] note");
  });
  it("trims the message", () => {
    expect(buildContent("steer", "   hi   ")).toBe("[STEER] hi");
  });
  it("rejects empty messages", () => {
    expect(() => buildContent("steer", "   ")).toThrow();
    expect(() => buildContent("steer", "")).toThrow();
  });
  it("KIND_PREFIX exposes both prefixes", () => {
    expect(KIND_PREFIX.steer).toBe("[STEER]");
    expect(KIND_PREFIX.append).toBe("[APPEND]");
  });
});

// ─── buildSignalPayload ────────────────────────────────────────────────────

describe("buildSignalPayload", () => {
  it("builds the REQ-SG-02 payload shape", () => {
    const p = buildSignalPayload("steer", "deviation!", "main-abc", {
      ...IDENTITY,
      severity: "warn",
    });
    expect(p.to).toBe("main-session");
    expect(p.customType).toBe(CURATOR_SIGNAL_TYPE);
    expect(p.content).toBe("[STEER] deviation!");
    expect(p.details).toEqual({
      kind: "steer",
      severity: "warn",
      curatorAlias: "spec",
      mainSessionId: "main-abc",
      spawnedAt: IDENTITY.spawnedAt,
    });
  });

  it("defaults severity to info", () => {
    const p = buildSignalPayload("append", "note", "main-abc", IDENTITY);
    expect(p.details.severity).toBe("info");
  });

  it("critical severity overrides append→steer in details.kind AND content prefix", () => {
    const p = buildSignalPayload("append", "danger", "main-abc", {
      ...IDENTITY,
      severity: "critical",
    });
    expect(p.details.kind).toBe("steer"); // overridden
    expect(p.details.severity).toBe("critical"); // severity preserved
    expect(p.content).toBe("[STEER] danger"); // prefix matches effective kind
  });

  it("append payload has append prefix", () => {
    const p = buildSignalPayload("append", "fyi", "main-abc", IDENTITY);
    expect(p.content).toBe("[APPEND] fyi");
    expect(p.details.kind).toBe("append");
  });
});

// ─── fallback file (path + line format + write) ────────────────────────────

describe("resolveFindingsPath", () => {
  it("produces <dir>/<curator>-<ts>.jsonl", () => {
    const p = resolveFindingsPath("/findings/main-abc", "spec", 1234);
    expect(p).toBe(path.join("/findings/main-abc", "spec-1234.jsonl"));
  });
});

describe("formatFallbackLine", () => {
  it("emits one JSON line with trailing newline", () => {
    const rec: FallbackRecord = {
      kind: "steer",
      message: "hi",
      mainSessionId: "m",
      curatorAlias: "spec",
      writtenAtMs: 1,
    };
    const line = formatFallbackLine(rec);
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line.trim())).toEqual(rec);
  });
});

describe("writeFindingsFallback", () => {
  it("creates the dir + appends one JSONL line, returns path", async () => {
    const dir = path.join(mkdtemp(), "findings", "main-abc");
    const rec: FallbackRecord = {
      kind: "append",
      message: "note",
      mainSessionId: "main-abc",
      curatorAlias: "spec",
      writtenAtMs: 555,
    };
    const written = await writeFindingsFallback(dir, rec);
    expect(written).toBe(resolveFindingsPath(dir, "spec", 555));
    const content = fs.readFileSync(written, "utf8");
    expect(content).toBe(formatFallbackLine(rec));
  });

  it("appends multiple records to the same per-curator file (same ts)", async () => {
    const dir = path.join(mkdtemp(), "findings", "main-abc");
    // Same writtenAtMs → same file → append semantics (the meaningful case
    // for a curator emitting several findings in one fallback burst).
    await writeFindingsFallback(dir, {
      kind: "steer",
      message: "one",
      mainSessionId: "m",
      curatorAlias: "spec",
      writtenAtMs: 1,
    });
    await writeFindingsFallback(dir, {
      kind: "append",
      message: "two",
      mainSessionId: "m",
      curatorAlias: "spec",
      writtenAtMs: 1,
    });
    const file = resolveFindingsPath(dir, "spec", 1);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).message).toBe("one");
    expect(JSON.parse(lines[1]!).message).toBe("two");
  });

  it("distinct timestamps → distinct files (one record each)", async () => {
    const dir = path.join(mkdtemp(), "findings", "main-abc");
    await writeFindingsFallback(dir, {
      kind: "steer",
      message: "a",
      mainSessionId: "m",
      curatorAlias: "spec",
      writtenAtMs: 1,
    });
    await writeFindingsFallback(dir, {
      kind: "steer",
      message: "b",
      mainSessionId: "m",
      curatorAlias: "spec",
      writtenAtMs: 2,
    });
    const f1 = resolveFindingsPath(dir, "spec", 1);
    const f2 = resolveFindingsPath(dir, "spec", 2);
    expect(fs.existsSync(f1)).toBe(true);
    expect(fs.existsSync(f2)).toBe(true);
    expect(fs.readFileSync(f1, "utf8").trim().split("\n")).toHaveLength(1);
    expect(fs.readFileSync(f2, "utf8").trim().split("\n")).toHaveLength(1);
  });
});

// ─── createSignalMainTool ──────────────────────────────────────────────────

/** Build a fake intercom client that records sends and can be made to fail. */
function makeFakeClient(opts: {
  failNTimes?: number;
  sink?: SignalPayload[];
} = {}): IntercomClient & { sendCount: () => number } {
  let calls = 0;
  const sink = opts.sink ?? [];
  return {
    async send(payload) {
      sink.push(payload);
      calls += 1;
      if (opts.failNTimes && calls <= opts.failNTimes) {
        throw new Error(`broker down (call ${calls})`);
      }
      return { ok: true };
    },
    sendCount: () => calls,
  };
}

describe("createSignalMainTool", () => {
  it("exposes name, description, parameters, execute", () => {
    const tool = createSignalMainTool(
      { client: makeFakeClient(), fallbackDir: "/tmp" },
      IDENTITY,
    );
    expect(tool.name).toBe("signal_main");
    expect(tool.description).toContain("steer");
    expect(tool.description).toContain("append");
    expect(tool.parameters.required).toEqual(["kind", "message"]);
  });

  it("happy path: sends via intercom, returns via:intercom", async () => {
    const sink: SignalPayload[] = [];
    const client = makeFakeClient({ sink });
    const tool = createSignalMainTool(
      { client, fallbackDir: "/tmp/never" },
      IDENTITY,
    );
    const res = await tool.execute({ kind: "steer", message: "deviation!" });
    expect(res).toEqual({ ok: true, via: "intercom" });
    expect(client.sendCount()).toBe(1);
    expect(sink[0]!.content).toBe("[STEER] deviation!");
    expect(sink[0]!.to).toBe("main-session");
  });

  it("retry-once-then-succeed on first failure (REQ-SG-02)", async () => {
    const client = makeFakeClient({ failNTimes: 1 });
    const tool = createSignalMainTool({ client, fallbackDir: "/tmp/x" }, IDENTITY);
    const res = await tool.execute({ kind: "append", message: "note" });
    expect(res).toEqual({ ok: true, via: "intercom" });
    expect(client.sendCount()).toBe(2); // one fail + one retry
  });

  it("broker unreachable after retry → writes fallback file (REQ-SG-08)", async () => {
    const client = makeFakeClient({ failNTimes: 2 }); // fail both
    const dir = path.join(mkdtemp(), "findings", "main-abc");
    let writtenRecord: FallbackRecord | undefined;
    const tool = createSignalMainTool(
      {
        client,
        fallbackDir: dir,
        now: () => 9999,
        fallbackWriter: async (_d, rec) => {
          writtenRecord = rec;
          return resolveFindingsPath(_d, rec.curatorAlias, rec.writtenAtMs);
        },
      },
      IDENTITY,
    );
    const res = await tool.execute({ kind: "steer", message: "urgent", severity: "warn" });
    expect(res.ok).toBe(true);
    expect(res).toHaveProperty("via", "fallback-file");
    expect(client.sendCount()).toBe(2); // initial + 1 retry
    expect(writtenRecord).toBeDefined();
    expect(writtenRecord!.kind).toBe("steer");
    expect(writtenRecord!.message).toBe("urgent");
    expect(writtenRecord!.severity).toBe("warn");
    expect(writtenRecord!.mainSessionId).toBe("main-abc");
    expect(writtenRecord!.curatorAlias).toBe("spec");
  });

  it("critical severity forces kind=steer even when curator chose append", async () => {
    const sink: SignalPayload[] = [];
    const client = makeFakeClient({ sink });
    const tool = createSignalMainTool(
      { client, fallbackDir: "/tmp/x" },
      IDENTITY,
    );
    await tool.execute({ kind: "append", message: "danger", severity: "critical" });
    expect(sink[0]!.details.kind).toBe("steer");
    expect(sink[0]!.content).toBe("[STEER] danger");
  });

  it("invalid kind → returns ok:false error, no send", async () => {
    const client = makeFakeClient();
    const tool = createSignalMainTool({ client, fallbackDir: "/tmp/x" }, IDENTITY);
    const res = await tool.execute({ kind: "URGENT", message: "x" });
    expect(res.ok).toBe(false);
    expect(client.sendCount()).toBe(0);
  });

  it("empty message → returns ok:false error, no send", async () => {
    const client = makeFakeClient();
    const tool = createSignalMainTool({ client, fallbackDir: "/tmp/x" }, IDENTITY);
    const res = await tool.execute({ kind: "steer", message: "   " });
    expect(res.ok).toBe(false);
    expect(client.sendCount()).toBe(0);
  });

  it("both intercom AND fallback fail → ok:false with combined error", async () => {
    const client = makeFakeClient({ failNTimes: 2 });
    const tool = createSignalMainTool(
      {
        client,
        fallbackDir: "/tmp/x",
        fallbackWriter: async () => {
          throw new Error("disk full");
        },
      },
      IDENTITY,
    );
    const res = await tool.execute({ kind: "steer", message: "x" });
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("disk full");
    expect((res as { error: string }).error).toContain("broker unreachable");
  });

  it("uses injected now() for the fallback writtenAtMs", async () => {
    const client = makeFakeClient({ failNTimes: 2 });
    let ts: number | undefined;
    const tool = createSignalMainTool(
      {
        client,
        fallbackDir: path.join(mkdtemp(), "f"),
        now: () => 424242,
        fallbackWriter: async (_d, rec) => {
          ts = rec.writtenAtMs;
          return "/tmp/x";
        },
      },
      IDENTITY,
    );
    await tool.execute({ kind: "steer", message: "x" });
    expect(ts).toBe(424242);
  });
});
