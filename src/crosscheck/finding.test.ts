import { describe, it, expect } from "vitest";
import {
  SEVERITY_RANK,
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

// ─── Mutation survivor remediation (targeted TDD) ────────────────────────────

describe("SEVERITY_RANK values", () => {
  it("ranks info<warn<critical", () => {
    // Kills: line 37 ObjectLiteral→{} (empty object).
    expect(SEVERITY_RANK).toEqual({ info: 0, warn: 1, critical: 2 });
    expect(SEVERITY_RANK.info).toBeLessThan(SEVERITY_RANK.warn);
    expect(SEVERITY_RANK.warn).toBeLessThan(SEVERITY_RANK.critical);
  });
});

describe("normalizeFinding — non-string field coercion", () => {
  const base = {
    type: "finding",
    topic: "failing-ci",
    curator: "spec",
    ts: "2026-07-07T10:00:00.000Z",
    severity: "critical",
    summary: "x",
  };
  it("treats a non-string curator as missing (no throw, returns null)", () => {
    // Kills: line 129 ConditionalExpression→true (would call .trim() on undefined → throw).
    expect(normalizeFinding({ ...base, curator: undefined })).toBeNull();
    expect(normalizeFinding({ ...base, curator: 42 as never })).toBeNull();
  });
  it("coerces a non-string ts to empty string", () => {
    // Kills: line 130 ConditionalExpression→true (would thread the raw non-string).
    const out = normalizeFinding({ ...base, ts: undefined });
    expect(out?.ts).toBe("");
  });
});

describe("normalizeAgreement — trim + non-string coercion", () => {
  const base = {
    type: "agreement",
    topic: "failing-ci",
    curator: "quality",
    ts: "2026-07-07T10:01:00.000Z",
    severity: "critical",
  };
  it("trims whitespace from topic + curator", () => {
    // Kills: line 150/151 MethodExpression (drops .trim()) + ConditionalExpression→true.
    const out = normalizeAgreement({
      ...base,
      topic: "  failing-ci  ",
      curator: "  quality  ",
    });
    expect(out?.topic).toBe("failing-ci");
    expect(out?.curator).toBe("quality");
  });
  it("treats a non-string topic as missing (returns null, no throw)", () => {
    // Kills: line 150 ConditionalExpression→true (.trim() on undefined).
    expect(normalizeAgreement({ ...base, topic: undefined })).toBeNull();
  });
  it("coerces a non-string ts to empty string", () => {
    // Kills: line 152 ConditionalExpression→true (threads raw non-string).
    const out = normalizeAgreement({ ...base, ts: undefined });
    expect(out?.ts).toBe("");
  });
  it("rejects an agreement with an empty topic OR empty curator", () => {
    // Kills: line 153 ConditionalExpression→false + LogicalOperator→&&.
    expect(normalizeAgreement({ ...base, topic: "" })).toBeNull();
    expect(normalizeAgreement({ ...base, curator: "" })).toBeNull();
    // Both empty: original `!topic || !curator` short-circuits on topic.
    // Mutant `!topic && !curator` would only reject when BOTH empty.
    expect(normalizeAgreement({ ...base, topic: "", curator: "x" })).toBeNull();
    expect(normalizeAgreement({ ...base, topic: "x", curator: "" })).toBeNull();
  });
});

describe("normalizeEntry — null / non-object guards are honored", () => {
  it("rejects null without throwing", () => {
    // Kills: line 172 ConditionalExpression→false (would dereference null → throw).
    expect(() => normalizeEntry(null)).not.toThrow();
    expect(normalizeEntry(null)).toBeNull();
  });
  it("rejects primitive numbers", () => {
    expect(() => normalizeEntry(42)).not.toThrow();
    expect(normalizeEntry(42)).toBeNull();
  });
  it("routes a finding correctly (does not collapse to agreement)", () => {
    // Kills: line 175 ConditionalExpression→true (would route everything to agreement).
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
  it("returns null for an unknown type (neither branch fires)", () => {
    // Covers the final `return null` after both type checks.
    expect(normalizeEntry({ type: "vote" })).toBeNull();
    expect(normalizeEntry({})).toBeNull();
  });
});

describe("parseEntry — leading/trailing whitespace is trimmed before parse", () => {
  it("parses a JSON line padded with surrounding whitespace", () => {
    // Kills: line 218 MethodExpression→line (drops .trim(); JSON.parse fails on
    // surrounding whitespace / the trimmed-prefix regexes would not match).
    const line =
      '   {"type":"finding","topic":"t","curator":"c","ts":"x","severity":"info","summary":"s"}   ';
    expect(parseEntry(line)?.type).toBe("finding");
  });
  it("returns null for a whitespace-only line (trimmed→empty)", () => {
    // Documents line 219 behavior. NOTE: line 219 ConditionalExpression→false is
    // an equivalent mutant (JSON.parse("") throws → catch returns null anyway).
    expect(parseEntry("    ")).toBeNull();
  });
});
