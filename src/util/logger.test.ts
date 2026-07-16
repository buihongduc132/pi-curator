/**
 * logger.test.ts — TDD RED suite for the OTel-compatible curator logger.
 * All tests are expected to FAIL against the RED-phase stub.
 *
 * Covers (per design flow/plans/otel-logging/design.md):
 *   - record shape (OTel field names)
 *   - file backend JSONL path <logsDir>/<sessionId>/curator.jsonl
 *   - 50MB rotation (deterministic via small maxBytes)
 *   - level filtering
 *   - PI_CURATOR_LOG_ENABLED=0 no-op
 *   - child() inheritance (scope/attrs/traceId)
 *   - traceId in every record
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  createCuratorLogger,
  type LogRecord,
} from "./logger.js";

function readRecords(file: string): LogRecord[] {
  const raw = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
  return raw.map((l) => JSON.parse(l) as LogRecord);
}

describe("createCuratorLogger — OTel record shape", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-log-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("emits a JSONL record with the OTel field names", () => {
    const log = createCuratorLogger({ logsDir: dir, sessionId: "ses-1", scope: "curator.main" });
    log.info("spawned", { "persona.alias": "spec" });
    const file = path.join(dir, "ses-1", "curator.jsonl");
    const rec = readRecords(file)[0];
    expect(rec.severity).toBe("INFO");
    expect(rec.body).toBe("spawned");
    expect(typeof rec.ts).toBe("string");
    expect(rec.ts.length).toBeGreaterThan(0);
    expect(typeof rec.observedTimeUnixNano).toBe("string");
    expect(rec.attributes["service.name"]).toBe("pi-curator");
    expect(rec.attributes["scope.name"]).toBe("curator.main");
    expect(rec.attributes["persona.alias"]).toBe("spec");
  });

  it("writes to <logsDir>/<sessionId>/curator.jsonl (per-session subdir)", () => {
    const log = createCuratorLogger({ logsDir: dir, sessionId: "ses-42", scope: "x" });
    log.info("hi");
    const expected = path.join(dir, "ses-42", "curator.jsonl");
    expect(fs.existsSync(expected)).toBe(true);
  });

  it("includes traceId in every record when provided", () => {
    const log = createCuratorLogger({
      logsDir: dir,
      sessionId: "ses-1",
      scope: "curator.main",
      traceId: "abcdef0123456789abcdef0123456789",
    });
    log.info("a");
    log.warn("b");
    const recs = readRecords(path.join(dir, "ses-1", "curator.jsonl"));
    expect(recs).toHaveLength(2);
    for (const r of recs) {
      expect(r.attributes["trace.id"]).toBe("abcdef0123456789abcdef0123456789");
    }
  });
});

describe("createCuratorLogger — file rotation at maxBytes", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-log-rot-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("renames the current file to .1 and starts fresh when a write would exceed maxBytes", () => {
    // maxBytes small enough to force a rotation after a couple writes.
    const log = createCuratorLogger({
      logsDir: dir,
      sessionId: "ses-1",
      scope: "x",
      maxBytes: 256,
    });
    const file = path.join(dir, "ses-1", "curator.jsonl");
    const rolled = path.join(dir, "ses-1", "curator.jsonl.1");
    // Write enough records to trigger at least one rotation.
    for (let i = 0; i < 20; i++) log.info("payload " + "x".repeat(40));
    // A roll file must exist (rotation happened).
    expect(fs.existsSync(rolled)).toBe(true);
    // Current file must be ≤ maxBytes.
    const cur = fs.statSync(file).size;
    expect(cur).toBeLessThanOrEqual(256);
    // Rolled file must be non-empty (the pre-rotation content).
    expect(fs.statSync(rolled).size).toBeGreaterThan(0);
  });
});

describe("createCuratorLogger — level filtering", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-log-lvl-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("drops records below the configured level", () => {
    const log = createCuratorLogger({
      logsDir: dir,
      sessionId: "ses-1",
      scope: "x",
      level: "warn",
    });
    log.trace("t");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    const recs = readRecords(path.join(dir, "ses-1", "curator.jsonl"));
    const sevs = recs.map((r) => r.severity);
    expect(sevs).not.toContain("TRACE");
    expect(sevs).not.toContain("DEBUG");
    expect(sevs).not.toContain("INFO");
    expect(sevs).toContain("WARN");
    expect(sevs).toContain("ERROR");
  });
});

describe("createCuratorLogger — disabled no-op", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-log-off-"));
    process.env.PI_CURATOR_LOG_ENABLED = "0";
  });
  afterEach(() => {
    delete process.env.PI_CURATOR_LOG_ENABLED;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates no file and does not throw when PI_CURATOR_LOG_ENABLED=0", () => {
    const log = createCuratorLogger({ logsDir: dir, sessionId: "ses-1", scope: "x" });
    log.info("ignored");
    expect(log.trace).not.toThrow();
    expect(fs.existsSync(path.join(dir, "ses-1", "curator.jsonl"))).toBe(false);
  });
});

describe("createCuratorLogger — child() inheritance", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-log-child-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("child inherits scope (dotted), persistentAttrs, and traceId", () => {
    const parent = createCuratorLogger({
      logsDir: dir,
      sessionId: "ses-1",
      scope: "curator.main",
      traceId: "t".repeat(32),
      persistentAttrs: { "session.id": "ses-1" },
    });
    const child = parent.child("gate", { turn: 5 });
    child.info("gate open");
    const rec = readRecords(path.join(dir, "ses-1", "curator.jsonl"))[0];
    expect(rec.attributes["scope.name"]).toBe("curator.main.gate");
    expect(rec.attributes["trace.id"]).toBe("t".repeat(32));
    expect(rec.attributes["session.id"]).toBe("ses-1");
    expect(rec.attributes["turn"]).toBe(5);
  });

  it("child never throws and shares the same file", () => {
    const parent = createCuratorLogger({ logsDir: dir, sessionId: "ses-1", scope: "p" });
    const c1 = parent.child("a");
    const c2 = c1.child("b");
    c1.info("one");
    c2.warn("two");
    parent.error("three");
    const recs = readRecords(path.join(dir, "ses-1", "curator.jsonl"));
    expect(recs).toHaveLength(3);
  });
});

describe("createCuratorLogger — exception safety", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-log-exc-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("logger calls never throw even when the logs dir disappears mid-flight", () => {
    const log = createCuratorLogger({ logsDir: dir, sessionId: "ses-1", scope: "x" });
    fs.rmSync(dir, { recursive: true, force: true });
    expect(() => log.info("after rm")).not.toThrow();
  });
});
