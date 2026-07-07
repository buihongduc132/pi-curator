import { describe, it, expect } from "vitest";
import {
  dedupKey,
  isValidSeverity,
  normalizeAgreement,
  normalizeEntry,
  normalizeFinding,
  parseEntry,
  parseMailboxText,
  serializeEntry,
  topicKey,
  type Finding,
  type Agreement,
} from "./finding.js";

describe("severity validation", () => {
  it("accepts the three spec values", () => {
    expect(isValidSeverity("info")).toBe(true);
    expect(isValidSeverity("warn")).toBe(true);
    expect(isValidSeverity("critical")).toBe(true);
  });
  it("rejects unknown / non-string", () => {
    expect(isValidSeverity("high")).toBe(false);
    expect(isValidSeverity("CRITICAL")).toBe(false); // case-sensitive
    expect(isValidSeverity(2)).toBe(false);
    expect(isValidSeverity(null)).toBe(false);
    expect(isValidSeverity(undefined)).toBe(false);
  });
});

describe("topicKey / dedupKey (D3 exact + case-insensitive + trimmed)", () => {
  it("lowercases and trims", () => {
    expect(topicKey("  Failing-CI ")).toBe("failing-ci");
    expect(topicKey("Failing-CI")).toBe("failing-ci");
  });
  it("non-string → empty string", () => {
    expect(topicKey(undefined)).toBe("");
    expect(topicKey(42)).toBe("");
    expect(topicKey(null)).toBe("");
  });
  it("dedupKey matches normalized topic regardless of source curator/ts", () => {
    const a: Finding = {
      type: "finding",
      topic: "Red-Build",
      curator: "spec",
      ts: "2026-07-07T10:00:00.000Z",
      severity: "critical",
      summary: "x",
    };
    const b: Finding = {
      type: "finding",
      topic: "  red-build ",
      curator: "quality",
      ts: "2026-07-07T10:05:00.000Z",
      severity: "warn",
      summary: "y",
    };
    expect(dedupKey(a)).toBe(dedupKey(b));
  });
});

describe("normalizeFinding", () => {
  const validRaw = {
    type: "finding",
    topic: "failing-ci",
    curator: "spec",
    ts: "2026-07-07T10:00:00.000Z",
    severity: "critical",
    summary: "CI is red",
  };
  it("accepts a well-formed finding", () => {
    expect(normalizeFinding(validRaw)).toEqual(validRaw);
  });
  it("rejects wrong type", () => {
    expect(normalizeFinding({ ...validRaw, type: "agreement" })).toBeNull();
  });
  it("rejects empty/missing topic", () => {
    expect(normalizeFinding({ ...validRaw, topic: "  " })).toBeNull();
    expect(normalizeFinding({ ...validRaw, topic: undefined })).toBeNull();
  });
  it("rejects empty/missing curator", () => {
    expect(normalizeFinding({ ...validRaw, curator: "" })).toBeNull();
  });
  it("rejects invalid severity", () => {
    expect(normalizeFinding({ ...validRaw, severity: "high" })).toBeNull();
    expect(normalizeFinding({ ...validRaw, severity: undefined })).toBeNull();
  });
  it("trims topic/curator", () => {
    const out = normalizeFinding({
      ...validRaw,
      topic: "  failing-ci  ",
      curator: "  spec  ",
    });
    expect(out).not.toBeNull();
    expect(out?.topic).toBe("failing-ci");
    expect(out?.curator).toBe("spec");
  });
  it("accepts empty summary", () => {
    const out = normalizeFinding({ ...validRaw, summary: "" });
    expect(out?.summary).toBe("");
  });
  it("coerces missing summary to empty string", () => {
    const { summary: _s, ...noSummary } = validRaw;
    void _s;
    expect(normalizeFinding(noSummary as typeof validRaw)?.summary).toBe("");
  });
});

describe("normalizeAgreement", () => {
  const validRaw = {
    type: "agreement",
    topic: "failing-ci",
    curator: "quality",
    ts: "2026-07-07T10:01:00.000Z",
    severity: "critical",
  };
  it("accepts a well-formed agreement", () => {
    expect(normalizeAgreement(validRaw)).toEqual(validRaw);
  });
  it("rejects wrong type", () => {
    expect(normalizeAgreement({ ...validRaw, type: "finding" })).toBeNull();
  });
  it("rejects invalid severity", () => {
    expect(normalizeAgreement({ ...validRaw, severity: "low" })).toBeNull();
  });
});

describe("normalizeEntry (union)", () => {
  it("routes finding → normalizeFinding", () => {
    const out = normalizeEntry({
      type: "finding",
      topic: "t",
      curator: "c",
      ts: "x",
      severity: "info",
      summary: "s",
    });
    expect(out?.type).toBe("finding");
  });
  it("routes agreement → normalizeAgreement", () => {
    const out = normalizeEntry({
      type: "agreement",
      topic: "t",
      curator: "c",
      ts: "x",
      severity: "info",
    });
    expect(out?.type).toBe("agreement");
  });
  it("rejects unknown type", () => {
    expect(normalizeEntry({ type: "vote", topic: "t" })).toBeNull();
  });
  it("rejects null / non-object", () => {
    expect(normalizeEntry(null)).toBeNull();
    expect(normalizeEntry("finding")).toBeNull();
    expect(normalizeEntry(undefined)).toBeNull();
  });
});

describe("serializeEntry", () => {
  it("serializes a finding in spec field order", () => {
    const f: Finding = {
      type: "finding",
      topic: "failing-ci",
      curator: "spec",
      ts: "2026-07-07T10:00:00.000Z",
      severity: "critical",
      summary: "CI red",
    };
    const out = serializeEntry(f);
    expect(out).toBe(
      '{"type":"finding","topic":"failing-ci","curator":"spec","ts":"2026-07-07T10:00:00.000Z","severity":"critical","summary":"CI red"}',
    );
    expect(out).not.toContain("\n"); // single line
  });
  it("serializes an agreement (no summary field)", () => {
    const a: Agreement = {
      type: "agreement",
      topic: "failing-ci",
      curator: "quality",
      ts: "2026-07-07T10:01:00.000Z",
      severity: "critical",
    };
    expect(JSON.parse(serializeEntry(a))).toEqual(a);
  });
  it("round-trips via parseEntry", () => {
    const f: Finding = {
      type: "finding",
      topic: "t",
      curator: "c",
      ts: "2026-07-07T10:00:00.000Z",
      severity: "warn",
      summary: "s",
    };
    expect(parseEntry(serializeEntry(f))).toEqual(f);
  });
});

describe("parseEntry / parseMailboxText (fail-open)", () => {
  it("parses a valid line", () => {
    const line =
      '{"type":"finding","topic":"t","curator":"c","ts":"x","severity":"info","summary":"s"}';
    expect(parseEntry(line)?.type).toBe("finding");
  });
  it("returns null for blank line", () => {
    expect(parseEntry("   ")).toBeNull();
    expect(parseEntry("")).toBeNull();
  });
  it("returns null for malformed JSON (no throw)", () => {
    expect(parseEntry("{not json")).toBeNull();
    expect(parseEntry("garbage")).toBeNull();
  });
  it("returns null for valid JSON of wrong shape", () => {
    expect(parseEntry('{"type":"vote"}')).toBeNull();
    expect(parseEntry('{"foo":1}')).toBeNull();
  });
  it("parseMailboxText skips blank + malformed, keeps valid", () => {
    const text = [
      '{"type":"finding","topic":"a","curator":"c","ts":"x","severity":"info","summary":"s"}',
      "",
      "{garbage",
      '{"type":"agreement","topic":"a","curator":"d","ts":"y","severity":"warn"}',
      '  {"type":"vote"}  ',
    ].join("\n");
    const entries = parseMailboxText(text);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe("finding");
    expect(entries[1].type).toBe("agreement");
  });
  it("parseMailboxText handles CRLF (\\r\\n) lines", () => {
    const text =
      '{"type":"finding","topic":"a","curator":"c","ts":"x","severity":"info","summary":"s"}\r\n' +
      '{"type":"agreement","topic":"a","curator":"d","ts":"y","severity":"warn"}\r\n';
    expect(parseMailboxText(text)).toHaveLength(2);
  });
});
