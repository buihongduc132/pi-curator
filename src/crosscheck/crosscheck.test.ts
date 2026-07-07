import { describe, it, expect } from "vitest";
import {
  DEFAULT_CROSSCHECK,
  buildAgreement,
  buildFinding,
  decideSignal,
  failOpenDecision,
  findMatchingPeerFinding,
  resolveCrossCheck,
  type CrossCheckConfig,
  type PendingFinding,
} from "./crosscheck.js";
import type { Finding } from "./finding.js";

const NOW = "2026-07-07T10:00:00.000Z";
const NOW_MS = Date.parse(NOW);

const pending: PendingFinding = {
  topic: "failing-ci",
  curator: "quality",
  severity: "critical",
  summary: "Build is red on main",
};

function finding(
  topic: string,
  curator: string,
  tsOffsetMin: number,
  severity: PendingFinding["severity"] = "critical",
): Finding {
  return {
    type: "finding",
    topic,
    curator,
    ts: new Date(NOW_MS + tsOffsetMin * 60_000).toISOString(),
    severity,
    summary: "x",
  };
}

function cfg(over: Partial<CrossCheckConfig>): CrossCheckConfig {
  return { ...DEFAULT_CROSSCHECK, ...over };
}

describe("resolveCrossCheck", () => {
  it("undefined → all defaults", () => {
    const c = resolveCrossCheck(undefined);
    expect(c).toEqual(DEFAULT_CROSSCHECK);
  });
  it("null → defaults", () => {
    expect(resolveCrossCheck(null)).toEqual(DEFAULT_CROSSCHECK);
  });
  it("enables via nested crossCheck field", () => {
    const c = resolveCrossCheck({ crossCheck: { enabled: true } });
    expect(c.enabled).toBe(true);
    expect(c.mode).toBe("append-agreement");
    expect(c.trigger).toBe("before-every-signal");
    expect(c.windowMinutes).toBe(10);
  });
  it("enables via top-level (tolerant)", () => {
    expect(resolveCrossCheck({ enabled: true }).enabled).toBe(true);
  });
  it("unknown mode/trigger fall back to defaults (never throw)", () => {
    const c = resolveCrossCheck({
      crossCheck: { enabled: true, mode: "majority" as never, trigger: "weird" as never },
    });
    expect(c.mode).toBe("append-agreement");
    expect(c.trigger).toBe("before-every-signal");
  });
  it("windowMinutes: non-number/NaN/negative → default 10; finite negative clamped to 0", () => {
    expect(resolveCrossCheck({ crossCheck: { windowMinutes: "x" as never } }).windowMinutes).toBe(10);
    expect(resolveCrossCheck({ crossCheck: { windowMinutes: NaN } }).windowMinutes).toBe(10);
    expect(resolveCrossCheck({ crossCheck: { windowMinutes: -5 } }).windowMinutes).toBe(0);
    expect(resolveCrossCheck({ crossCheck: { windowMinutes: 30 } }).windowMinutes).toBe(30);
  });
});

describe("findMatchingPeerFinding (D3 exact topic, within window)", () => {
  it("matches same topic within window", () => {
    const m = findMatchingPeerFinding(
      [finding("failing-ci", "spec", -3)],
      pending,
      10,
      NOW,
    );
    expect(m?.curator).toBe("spec");
  });
  it("matches case-insensitively and trimmed", () => {
    const p: PendingFinding = { ...pending, topic: "  FAILING-CI " };
    const m = findMatchingPeerFinding(
      [finding("failing-ci", "spec", -3)],
      p,
      10,
      NOW,
    );
    expect(m).not.toBeNull();
  });
  it("does NOT match divergent topics (D3: no fuzzy)", () => {
    const m = findMatchingPeerFinding(
      [finding("red-build", "spec", -3)],
      pending,
      10,
      NOW,
    );
    expect(m).toBeNull();
  });
  it("expired finding (> window) does not match", () => {
    const m = findMatchingPeerFinding(
      [finding("failing-ci", "spec", -20)], // 20 min ago, window 10
      pending,
      10,
      NOW,
    );
    expect(m).toBeNull();
  });
  it("boundary: exactly windowMinutes ago matches (abs diff == window)", () => {
    const m = findMatchingPeerFinding(
      [finding("failing-ci", "spec", -10)],
      pending,
      10,
      NOW,
    );
    expect(m).not.toBeNull();
  });
  it("returns the most recent match when several exist", () => {
    const m = findMatchingPeerFinding(
      [finding("failing-ci", "old", -8), finding("failing-ci", "new", -2)],
      pending,
      10,
      NOW,
    );
    expect(m?.curator).toBe("new");
  });
  it("ignores agreement entries", () => {
    const m = findMatchingPeerFinding(
      [
        { type: "agreement", topic: "failing-ci", curator: "x", ts: NOW, severity: "info" },
      ],
      pending,
      10,
      NOW,
    );
    expect(m).toBeNull();
  });
  it("ignores findings with unparseable ts", () => {
    const m = findMatchingPeerFinding(
      [{ ...finding("failing-ci", "spec", 0), ts: "not-a-date" }],
      pending,
      10,
      NOW,
    );
    expect(m).toBeNull();
  });
  it("unparseable `now` returns null (never throws)", () => {
    expect(findMatchingPeerFinding([finding("failing-ci", "spec", -3)], pending, 10, "garbage")).toBeNull();
  });
});

describe("buildFinding / buildAgreement", () => {
  it("buildFinding carries summary; buildAgreement drops it", () => {
    const f = buildFinding(pending, NOW);
    const a = buildAgreement(pending, NOW);
    expect(f.type).toBe("finding");
    expect(f.summary).toBe(pending.summary);
    expect(a.type).toBe("agreement");
    expect("summary" in a).toBe(false);
  });
  it("accepts Date and epoch ms for `now`", () => {
    const f1 = buildFinding(pending, new Date(NOW_MS));
    const f2 = buildFinding(pending, NOW_MS);
    expect(f1.ts).toBe(NOW);
    expect(f2.ts).toBe(NOW);
  });
});

describe("decideSignal — all branches", () => {
  it("(1) disabled → signal, NO append", () => {
    const d = decideSignal(cfg({ enabled: false }), pending, [], NOW);
    expect(d.signal).toBe(true);
    expect(d.append).toBeNull();
    expect(d.reason).toBe("disabled");
  });
  it("(2a) critical-only + non-critical → signal, NO append", () => {
    const d = decideSignal(
      cfg({ enabled: true, trigger: "critical-only" }),
      { ...pending, severity: "warn" },
      [finding("failing-ci", "spec", -3)],
      NOW,
    );
    expect(d.signal).toBe(true);
    expect(d.append).toBeNull();
    expect(d.reason).toBe("trigger-skipped-non-critical");
  });
  it("(2b) critical-only + critical severity DOES run cross-check", () => {
    const d = decideSignal(
      cfg({ enabled: true, trigger: "critical-only" }),
      pending, // severity: critical
      [finding("failing-ci", "spec", -3)],
      NOW,
    );
    expect(d.signal).toBe(false); // suppressed — matched peer
    expect(d.append?.type).toBe("agreement");
    expect(d.reason).toBe("first-finding-wins");
  });
  it("(3a) matched + append-agreement → SUPPRESS signal + append agreement", () => {
    const d = decideSignal(
      cfg({ enabled: true, mode: "append-agreement" }),
      pending,
      [finding("failing-ci", "spec", -3)],
      NOW,
    );
    expect(d.signal).toBe(false);
    expect(d.append?.type).toBe("agreement");
    if (d.append?.type === "agreement") {
      expect(d.append.topic).toBe("failing-ci");
      expect(d.append.curator).toBe("quality"); // this curator
      expect(d.append.severity).toBe("critical");
    }
    expect(d.reason).toBe("first-finding-wins");
  });
  it("(3b) matched + signal-anyway → signal ANYWAY + append finding (NOT agreement)", () => {
    const d = decideSignal(
      cfg({ enabled: true, mode: "signal-anyway" }),
      pending,
      [finding("failing-ci", "spec", -3)],
      NOW,
    );
    expect(d.signal).toBe(true);
    expect(d.append?.type).toBe("finding"); // NOT an agreement
    expect(d.reason).toBe("signal-anyway");
  });
  it("(4) no peer finding → signal + append finding", () => {
    const d = decideSignal(cfg({ enabled: true }), pending, [], NOW);
    expect(d.signal).toBe(true);
    expect(d.append?.type).toBe("finding");
    expect(d.reason).toBe("no-peer-finding");
  });
  it("divergent topics both signal (spec scenario: no false dedup)", () => {
    // curator B has a different topic slug for the same conceptual issue
    const d = decideSignal(
      cfg({ enabled: true, mode: "append-agreement" }),
      { ...pending, topic: "red-build" },
      [finding("failing-ci", "spec", -3)], // different topic
      NOW,
    );
    expect(d.signal).toBe(true);
    expect(d.append?.type).toBe("finding");
  });
  it("expired finding does NOT dedup (signals + appends finding)", () => {
    const d = decideSignal(
      cfg({ enabled: true, mode: "append-agreement", windowMinutes: 10 }),
      pending,
      [finding("failing-ci", "spec", -20)], // 20 min stale
      NOW,
    );
    expect(d.signal).toBe(true);
    expect(d.append?.type).toBe("finding");
    expect(d.reason).toBe("no-peer-finding");
  });
});

describe("failOpenDecision", () => {
  it("always signals + appends a finding (channel-down path)", () => {
    const d = failOpenDecision(pending, NOW);
    expect(d.signal).toBe(true);
    expect(d.append?.type).toBe("finding");
    expect(d.reason).toBe("fail-open");
  });
});

describe("spec conformance — scenario walkthroughs", () => {
  it("first curator signals; second agrees silently (append-agreement)", () => {
    const cc = cfg({ enabled: true, mode: "append-agreement", windowMinutes: 10 });
    // curator A sees empty mailbox
    const a = decideSignal(cc, { ...pending, curator: "a" }, [], NOW);
    expect(a.signal).toBe(true);
    expect(a.append?.type).toBe("finding");
    // simulate A's finding now in mailbox; curator B reads it
    const mailboxAfterA = a.append ? [a.append as Finding] : [];
    const b = decideSignal(cc, { ...pending, curator: "b" }, mailboxAfterA, NOW);
    expect(b.signal).toBe(false);
    expect(b.append?.type).toBe("agreement");
  });

  it("spec scenario: signal-anyway never suppresses", () => {
    const cc = cfg({ enabled: true, mode: "signal-anyway", windowMinutes: 10 });
    const prior = [finding("failing-ci", "a", -1)];
    const d = decideSignal(cc, pending, prior, NOW);
    expect(d.signal).toBe(true);
    expect(d.append?.type).toBe("finding"); // new finding, not agreement
  });

  it("spec scenario: critical-only skips cross-check for non-critical", () => {
    const cc = cfg({ enabled: true, trigger: "critical-only", windowMinutes: 10 });
    const prior = [finding("failing-ci", "a", -1)];
    const d = decideSignal(cc, { ...pending, severity: "high" as never }, prior, NOW);
    // "high" is not a real severity; resolveCrossCheck would never produce it,
    // but the decision logic only checks `!== "critical"` so it skips.
    expect(d.signal).toBe(true);
    expect(d.append).toBeNull();
  });
});
