/**
 * team-attach-claim.test.ts — RED PHASE tests for the `curatorSessionId`
 * pointer (LD1 — locked decision).
 *
 * These tests are EXPECTED TO FAIL until the GREEN phase implements:
 *   - `CuratorClaim.curatorSessionId?: string` (optional field)
 *   - `parseCuratorClaim` preserving the field when present
 *   - `parseCuratorClaim` returning `curatorSessionId: undefined` for legacy
 *     entries that lack the field (non-breaking; NOT a hard error)
 *
 * See: flow/findings/curator-observability/2026-07-07-locked-decisions.yaml LD1.
 */
import { describe, it, expect } from "vitest";
import { parseCuratorClaim, type CuratorClaim } from "./team-attach-claim.js";

// ─── Test helpers ───────────────────────────────────────────────────────────

const NOW = Date.parse("2026-01-01T00:00:00.000Z");

/** A complete, valid raw claim object (the minimal CuratorClaim shape). */
function rawClaim(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    pid: 4242,
    mainSessionId: "ses-main",
    mainSessionName: "Main",
    curator: "spec",
    spawnedAt: new Date(NOW).toISOString(),
    heartbeatAt: new Date(NOW).toISOString(),
    phase: "scanning",
    ...over,
  };
}

// ─── CuratorClaim type shape (LD1) ──────────────────────────────────────────

describe("CuratorClaim.curatorSessionId field (LD1 pointer)", () => {
  it("type includes optional curatorSessionId?: string", () => {
    // The type MUST allow an optional curatorSessionId. If the field does not
    // exist on the interface, this assignment is a compile error (and the
    // value is dropped on read). We assert the property round-trips.
    const claim: CuratorClaim = {
      pid: 1,
      mainSessionId: "m",
      curator: "spec",
      spawnedAt: "2026-01-01T00:00:00.000Z",
      heartbeatAt: "2026-01-01T00:00:00.000Z",
      phase: "scanning",
      curatorSessionId: "ses_abc123",
    };
    expect(claim.curatorSessionId).toBe("ses_abc123");
  });

  it("type allows omitting curatorSessionId (legacy, undefined)", () => {
    const claim: CuratorClaim = {
      pid: 1,
      mainSessionId: "m",
      curator: "spec",
      spawnedAt: "2026-01-01T00:00:00.000Z",
      heartbeatAt: "2026-01-01T00:00:00.000Z",
      phase: "scanning",
    };
    expect(claim.curatorSessionId).toBeUndefined();
  });
});

// ─── parseCuratorClaim preserves curatorSessionId when present ──────────────

describe("parseCuratorClaim — curatorSessionId preservation (LD1)", () => {
  it("preserves curatorSessionId when present in the raw JSON", () => {
    const claim = parseCuratorClaim(rawClaim({ curatorSessionId: "ses_abc123" }));
    expect(claim).not.toBeNull();
    expect(claim!.curatorSessionId).toBe("ses_abc123");
  });

  it("preserves an empty-ish session id? (non-empty string only)", () => {
    // getOptionalString rejects empty strings; a present-but-empty value is
    // treated as absent → undefined (consistent with mainSessionName/goalFile).
    const claim = parseCuratorClaim(rawClaim({ curatorSessionId: "" }));
    expect(claim).not.toBeNull();
    expect(claim!.curatorSessionId).toBeUndefined();
  });

  it("returns curatorSessionId: undefined when the field is absent (legacy)", () => {
    const claim = parseCuratorClaim(rawClaim());
    expect(claim).not.toBeNull();
    // Legacy entry: no pointer. NOT a hard error — claim still parses.
    expect(claim!.curatorSessionId).toBeUndefined();
  });

  it("returns curatorSessionId: undefined when the field is a non-string", () => {
    const claim = parseCuratorClaim(rawClaim({ curatorSessionId: 12345 }));
    expect(claim).not.toBeNull();
    expect(claim!.curatorSessionId).toBeUndefined();
  });

  it("does NOT treat a missing curatorSessionId as a hard error (non-breaking)", () => {
    // The legacy claim (no pointer) MUST still parse successfully — the field
    // is optional. This is the core LD1 non-breaking guarantee.
    const legacy = parseCuratorClaim(rawClaim());
    expect(legacy).not.toBeNull();
    expect(legacy!.pid).toBe(4242);
    expect(legacy!.curator).toBe("spec");
  });
});
