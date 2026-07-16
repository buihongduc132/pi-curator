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
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  parseCuratorClaim,
  acquireCuratorClaim,
  heartbeatCuratorClaim,
  releaseCuratorClaim,
  seedCuratorPid,
  readCuratorClaim,
  curatorClaimFile,
  defaultPidRoot,
  isSlotFree,
  type CuratorClaim,
} from "./team-attach-claim.js";
import { DEFAULT_HEARTBEAT_CONFIG } from "./heartbeat-lease.js";

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

// ─── seedCuratorPid (BLOCKER D2 PID handoff) ────────────────────────────────

describe("seedCuratorPid (D2 — force-write child pid without ownership check)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "curator-seed-"));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("overwrites the placeholder main pid with the real child pid", async () => {
    const claimPath = curatorClaimFile(tmpRoot, "ses_main", "spec");
    // Acquire with the MAIN pid as placeholder.
    await acquireCuratorClaim(claimPath, {
      pid: 11111,
      mainSessionId: "ses_main",
      curator: "spec",
      nowMs: NOW,
    });

    const childPid = 99999;
    const result = await seedCuratorPid(claimPath, childPid, { phase: "spawned", nowMs: NOW + 1000 });

    expect(result).toBe("seeded");
    const seeded = await readCuratorClaim(claimPath);
    expect(seeded).not.toBeNull();
    // The pid MUST now be the child pid, NOT the main placeholder.
    expect(seeded!.pid).toBe(childPid);
    expect(seeded!.pid).not.toBe(11111);
    expect(seeded!.phase).toBe("spawned");
    // heartbeatAt refreshed.
    expect(seeded!.heartbeatAt).toBe(new Date(NOW + 1000).toISOString());
  });

  it("does NOT perform an ownership check (D2 — main just acquired the slot)", async () => {
    const claimPath = curatorClaimFile(tmpRoot, "ses_main", "spec");
    // Acquire with main pid 11111; the child pid 99999 is DIFFERENT.
    await acquireCuratorClaim(claimPath, {
      pid: 11111,
      mainSessionId: "ses_main",
      curator: "spec",
      nowMs: NOW,
    });
    // seedCuratorPid must succeed even though pid mismatches the placeholder.
    const result = await seedCuratorPid(claimPath, 99999);
    expect(result).toBe("seeded");
    const seeded = await readCuratorClaim(claimPath);
    expect(seeded!.pid).toBe(99999);
  });

  it("returns 'missing' when the claim file does not exist", async () => {
    const claimPath = curatorClaimFile(tmpRoot, "ses_main", "absent");
    const result = await seedCuratorPid(claimPath, 12345);
    expect(result).toBe("missing");
  });

  it("preserves all other claim fields (mainSessionId, curator, goalFile, ...)", async () => {
    const claimPath = curatorClaimFile(tmpRoot, "ses_main", "spec");
    await acquireCuratorClaim(claimPath, {
      pid: 11111,
      mainSessionId: "ses_main",
      curator: "spec",
      mainSessionName: "main",
      goalFile: "/goals/spec.md",
      nowMs: NOW,
    });
    await seedCuratorPid(claimPath, 99999, { nowMs: NOW + 5000 });
    const seeded = await readCuratorClaim(claimPath);
    expect(seeded!.mainSessionId).toBe("ses_main");
    expect(seeded!.curator).toBe("spec");
    expect(seeded!.mainSessionName).toBe("main");
    expect(seeded!.goalFile).toBe("/goals/spec.md");
    expect(seeded!.pid).toBe(99999);
  });
});

// ─── Mutation survivor remediation (targeted kills) ─────────────────────────

describe("parseCuratorClaim — validation guards (mutation survivors)", () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "curator-parse-"));
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // L152 ConditionalExpression `true` on `typeof v === "object"` in isRecord:
  // passing `undefined` must return null, NOT throw.
  it("returns null (without throwing) for an undefined value", () => {
    expect(parseCuratorClaim(undefined)).toBeNull();
  });

  // L157 ConditionalExpression `true` on the full getString condition: a
  // required field that is a NUMBER (not a string) must invalidate the claim.
  it("returns null when required string fields are numbers", () => {
    const numericOnly: Record<string, unknown> = {
      pid: 4242,
      mainSessionId: 12345,
      curator: 67890,
      spawnedAt: 11111,
      heartbeatAt: 22222,
      phase: 33333,
    };
    expect(parseCuratorClaim(numericOnly)).toBeNull();
  });

  // L167 LogicalOperator `||` on getNumber: NaN must be rejected (pid null →
  // claim null), not accepted.
  it("rejects NaN as the pid", () => {
    expect(parseCuratorClaim(rawClaim({ pid: NaN }))).toBeNull();
  });

  it("rejects Infinity as the pid", () => {
    expect(parseCuratorClaim(rawClaim({ pid: Infinity }))).toBeNull();
  });

  // L207 BlockStatement `{}`: readCuratorClaim's catch block. A corrupt JSON
  // file must yield null, NOT throw.
  it("readCuratorClaim returns null for a corrupt JSON file (no throw)", async () => {
    const claimPath = curatorClaimFile(tmpRoot, "ses_main", "spec");
    fs.mkdirSync(path.dirname(claimPath), { recursive: true });
    fs.writeFileSync(claimPath, "{ this is not valid json ", "utf8");
    await expect(readCuratorClaim(claimPath)).resolves.toBeNull();
  });

  it("readCuratorClaim returns null for a missing file (no throw)", async () => {
    const claimPath = curatorClaimFile(tmpRoot, "ses_main", "absent");
    await expect(readCuratorClaim(claimPath)).resolves.toBeNull();
  });
});

describe("acquireCuratorClaim — config + force (mutation survivors)", () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "curator-acq-"));
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // L252 LogicalOperator `&&` (`opts.config ?? DEFAULT` → `opts.config && DEFAULT`):
  // a custom config with a SHORT staleSec must be honored.
  it("honors a custom (short-stale) config and reclaims a stale-under-custom holder", async () => {
    const claimPath = curatorClaimFile(tmpRoot, "ses_main", "spec");
    const SHORT_STALE = { ...DEFAULT_HEARTBEAT_CONFIG, staleSec: 1, deadSec: 2 };
    await acquireCuratorClaim(claimPath, {
      pid: 111,
      mainSessionId: "ses_main",
      curator: "spec",
      nowMs: NOW,
    });
    const res = await acquireCuratorClaim(claimPath, {
      pid: 222,
      mainSessionId: "ses_main",
      curator: "spec",
      nowMs: NOW + 5_000,
      config: SHORT_STALE,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.claim.pid).toBe(222);
      expect(res.replacedClaim).toBeDefined();
    }
    // Sanity: the same timestamp under DEFAULT config would be LIVE → blocked.
    expect(
      isSlotFree(
        { pid: 111, mainSessionId: "s", curator: "c", spawnedAt: "x", heartbeatAt: new Date(NOW).toISOString(), phase: "scanning" },
        NOW + 5_000,
        DEFAULT_HEARTBEAT_CONFIG,
      ),
    ).toBe(false);
  });

  // L253 ConditionalExpression `false` + BooleanLiteral `false` on
  // `opts.force === true`: force=true must overwrite a live holder.
  it("force:true overwrites a live holder owned by another curator", async () => {
    const claimPath = curatorClaimFile(tmpRoot, "ses_main", "spec");
    await acquireCuratorClaim(claimPath, {
      pid: 111,
      mainSessionId: "ses_main",
      curator: "spec",
      nowMs: NOW,
    });
    const res = await acquireCuratorClaim(claimPath, {
      pid: 222,
      mainSessionId: "ses_main",
      curator: "spec",
      nowMs: NOW, // same ts → still live → would block without force
      force: true,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.claim.pid).toBe(222);
    }
  });

  it("without force, a live holder blocks the acquire (claimed_by_other)", async () => {
    const claimPath = curatorClaimFile(tmpRoot, "ses_main", "spec");
    await acquireCuratorClaim(claimPath, {
      pid: 111,
      mainSessionId: "ses_main",
      curator: "spec",
      nowMs: NOW,
    });
    const res = await acquireCuratorClaim(claimPath, {
      pid: 222,
      mainSessionId: "ses_main",
      curator: "spec",
      nowMs: NOW,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("claimed_by_other");
      expect(res.claim.pid).toBe(111);
    }
  });
});

describe("heartbeatCuratorClaim — ownership", () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "curator-hb-"));
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns 'not_owner' when a different pid refreshes", async () => {
    const claimPath = curatorClaimFile(tmpRoot, "ses_main", "spec");
    await acquireCuratorClaim(claimPath, {
      pid: 111,
      mainSessionId: "ses_main",
      curator: "spec",
      nowMs: NOW,
    });
    const res = await heartbeatCuratorClaim(claimPath, 999, { nowMs: NOW + 1000 });
    expect(res).toBe("not_owner");
  });

  it("returns 'missing' when no claim exists", async () => {
    const claimPath = curatorClaimFile(tmpRoot, "ses_main", "absent");
    const res = await heartbeatCuratorClaim(claimPath, 111, { nowMs: NOW });
    expect(res).toBe("missing");
  });

  it("updates heartbeatAt + phase for the owner and stamps curatorSessionId", async () => {
    const claimPath = curatorClaimFile(tmpRoot, "ses_main", "spec");
    await acquireCuratorClaim(claimPath, {
      pid: 111,
      mainSessionId: "ses_main",
      curator: "spec",
      nowMs: NOW,
    });
    const res = await heartbeatCuratorClaim(claimPath, 111, {
      phase: "signaling",
      nowMs: NOW + 2000,
      curatorSessionId: "ses_cur_xyz",
    });
    expect(res).toBe("updated");
    const updated = await readCuratorClaim(claimPath);
    expect(updated!.heartbeatAt).toBe(new Date(NOW + 2000).toISOString());
    expect(updated!.phase).toBe("signaling");
    expect(updated!.curatorSessionId).toBe("ses_cur_xyz");
  });
});

describe("releaseCuratorClaim — force + missing (mutation survivors)", () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "curator-rel-"));
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // L334 force mutants + L341 `!current` mutant.
  it("returns 'none' when there is no claim to release", async () => {
    const claimPath = curatorClaimFile(tmpRoot, "ses_main", "absent");
    const res = await releaseCuratorClaim(claimPath, 111);
    expect(res).toBe("none");
  });

  it("returns 'not_owner' when a non-owner (no force) tries to release", async () => {
    const claimPath = curatorClaimFile(tmpRoot, "ses_main", "spec");
    await acquireCuratorClaim(claimPath, {
      pid: 111,
      mainSessionId: "ses_main",
      curator: "spec",
      nowMs: NOW,
    });
    const res = await releaseCuratorClaim(claimPath, 999);
    expect(res).toBe("not_owner");
    expect(await readCuratorClaim(claimPath)).not.toBeNull();
  });

  it("force:true releases a claim owned by another curator", async () => {
    const claimPath = curatorClaimFile(tmpRoot, "ses_main", "spec");
    await acquireCuratorClaim(claimPath, {
      pid: 111,
      mainSessionId: "ses_main",
      curator: "spec",
      nowMs: NOW,
    });
    const res = await releaseCuratorClaim(claimPath, 999, { force: true });
    expect(res).toBe("released");
    expect(await readCuratorClaim(claimPath)).toBeNull();
  });

  it("owner releases its own claim and the file is removed", async () => {
    const claimPath = curatorClaimFile(tmpRoot, "ses_main", "spec");
    await acquireCuratorClaim(claimPath, {
      pid: 111,
      mainSessionId: "ses_main",
      curator: "spec",
      nowMs: NOW,
    });
    const res = await releaseCuratorClaim(claimPath, 111);
    expect(res).toBe("released");
    expect(await readCuratorClaim(claimPath)).toBeNull();
  });
});

describe("seedCuratorPid — phase override (mutation survivor L386)", () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "curator-seed2-"));
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // L386 ObjectLiteral `{}` on the `{ phase: opts.phase }` spread.
  it("writes the supplied phase onto the seeded claim", async () => {
    const claimPath = curatorClaimFile(tmpRoot, "ses_main", "spec");
    await acquireCuratorClaim(claimPath, {
      pid: 11111,
      mainSessionId: "ses_main",
      curator: "spec",
      nowMs: NOW,
    });
    await seedCuratorPid(claimPath, 99999, { phase: "scanning", nowMs: NOW + 1000 });
    const seeded = await readCuratorClaim(claimPath);
    expect(seeded!.phase).toBe("scanning");
  });
});
