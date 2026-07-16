/**
 * crosscheck.survivors.test.ts — kills surviving mutants in src/crosscheck/crosscheck.ts.
 *
 * Killable:
 *  - id 11/21 (mode/trigger union guards → false): pass valid non-default values.
 *  - id 31 (windowMinutes `typeof===number && isFinite` → true): non-number /
 *    NaN windowMinutes must fall back to 10.
 *  - id 72/81 (buildFinding/buildAgreement `now instanceof Date` first arm → true):
 *    a STRING `now` must be passed through verbatim (mutant calls .toISOString).
 *  - id 100 (decideSignal critical-only gate → true): a before-every-signal config
 *    with non-critical severity must NOT short-circuit to trigger-skipped.
 *
 * EQUIVALENT:
 *  - id 37 (`if (ts instanceof Date) return ts.getTime()`): for every real Date,
 *    `ts.getTime()` and the fallback `Date.parse(String(ts))` yield the same
 *    epoch-ms in Node/V8, so the fast-path is observationally redundant.
 *  - id 60 (`if (Number.isNaN(eMs)) continue`): an entry with NaN ts is never
 *    selected anyway (`NaN > bestMs` is always false), so skipping it changes
 *    nothing.
 */
import { describe, it, expect } from "vitest";
import {
  resolveCrossCheck,
  buildFinding,
  buildAgreement,
  decideSignal,
} from "./crosscheck.js";

const pending = { topic: "failing-ci", curator: "c", severity: "info" as const, summary: "s" };

describe("crosscheck survivors", () => {
  it("resolveCrossCheck keeps mode='signal-anyway' (kills union→false mutant)", () => {
    const c = resolveCrossCheck({ crossCheck: { enabled: true, mode: "signal-anyway" } });
    expect(c.mode).toBe("signal-anyway");
    expect(c.enabled).toBe(true);
  });

  it("resolveCrossCheck keeps trigger='critical-only' (kills union→false mutant)", () => {
    const c = resolveCrossCheck({ crossCheck: { enabled: true, trigger: "critical-only" } });
    expect(c.trigger).toBe("critical-only");
  });

  it("resolveCrossCheck: string windowMinutes → default 10 (kills typeof→true mutant)", () => {
    const c = resolveCrossCheck({ crossCheck: { windowMinutes: "5" } });
    expect(c.windowMinutes).toBe(10);
  });

  it("resolveCrossCheck: NaN windowMinutes → default 10 (kills typeof→true mutant)", () => {
    const c = resolveCrossCheck({ crossCheck: { windowMinutes: NaN } });
    expect(c.windowMinutes).toBe(10);
  });

  it("resolveCrossCheck: valid numeric windowMinutes is preserved", () => {
    const c = resolveCrossCheck({ crossCheck: { windowMinutes: 42 } });
    expect(c.windowMinutes).toBe(42);
  });

  it("buildFinding: string `now` passes through verbatim (kills instanceof→true mutant)", () => {
    const f = buildFinding(pending, "2026-01-02T03:04:05Z");
    expect(f.ts).toBe("2026-01-02T03:04:05Z");
  });

  it("buildAgreement: string `now` passes through verbatim (kills instanceof→true mutant)", () => {
    const a = buildAgreement(pending, "2026-01-02T03:04:05Z");
    expect(a.ts).toBe("2026-01-02T03:04:05Z");
  });

  it("buildFinding: number `now` → ISO string (covers the numeric arm)", () => {
    const f = buildFinding(pending, 1_700_000_000_000);
    expect(f.ts).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("decideSignal: before-every-signal + non-critical does NOT trigger-skip (kills cond→true mutant)", () => {
    const cfg = {
      enabled: true,
      mode: "append-agreement" as const,
      trigger: "before-every-signal" as const,
      windowMinutes: 10,
    };
    const d = decideSignal(cfg, pending, [], "2026-01-02T03:04:05Z");
    expect(d.reason).not.toBe("trigger-skipped-non-critical");
    // No peer finding → signal + append a finding.
    expect(d.signal).toBe(true);
    expect(d.append).not.toBeNull();
    expect(d.reason).toBe("no-peer-finding");
  });

  it("decideSignal: critical-only + non-critical DOES trigger-skip (covers the real branch)", () => {
    const cfg = {
      enabled: true,
      mode: "append-agreement" as const,
      trigger: "critical-only" as const,
      windowMinutes: 10,
    };
    const d = decideSignal(cfg, pending, [], "2026-01-02T03:04:05Z");
    expect(d.reason).toBe("trigger-skipped-non-critical");
  });
});
