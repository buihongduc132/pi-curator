/**
 * fs-lock.survivors.test.ts — final-round kills for src/util/fs-lock.ts.
 *
 * NOTE: fs-lock.test.ts + fs-lock.internals.test.ts already kill the majority of
 * listed survivors (2550 bare-dir, 2631 cause-ObjectLiteral, EEXIST/cause
 * rethrow, fd-leak, label ternary, staleMs default, optional-chaining metadata,
 * stale-live-owner, etc.). The Stryker *incremental* report still lists them
 * because incremental mode does not re-evaluate mutants when only TESTS change.
 *
 * This file adds a deterministic kill for the one genuinely-surviving mutant:
 *  - id 2698 (`Math.round(expBackoff * jitterFactor)` → `/`): with Math.random
 *    pinned, the first backoff delay is a fixed value under `*` but a different
 *    fixed value under `/`.
 *
 * EQUIVALENT (genuine, documented):
 *  - id 2579/2580/2582/2583 (EPERM check): the `EPERM` branch returns `true`,
 *    identical to the conservative `return true` fallback immediately after, so
 *    every mutation of the EPERM condition is observationally a no-op.
 *  - id 2591/2592/2593/2596/2599/2607/2608/2609/2615 (readLockMetadata guards &
 *    fields): `null` and an object of all-`undefined` fields are treated
 *    identically by every downstream `metadata?.x` / `typeof === "number"` use;
 *    `createdAt` is never read at all.
 *  - id 2664 (`lockAgeMs > staleMs` → `>=`): the exact-equality boundary is
 *    unreachable — `lockAgeMs` is `now - mtime` and `now` strictly advances
 *    between setting the mtime and the check, so the value is always a hair
 *    ABOVE staleMs (both branches reclaim) or well below (neither does).
 *  - id 2676 (`elapsedMs > timeoutMs` → `>=`): the check runs only after a sleep
 *    of ≥1ms, so elapsedMs jumps past timeoutMs in discrete steps and never
 *    equals it exactly.
 *  - id 2699 (`timeoutMs - elapsedMs` → `+`): `remainingMs` only clamps the sleep
 *    when elapsedMs is a large fraction of timeoutMs; distinguishing requires
 *    precise multi-iteration real-timer interaction that is non-deterministic.
 *  - id 2705 (`if (fd !== null) fs.closeSync(fd)` → `if (true)`): when fd is null
 *    the mutant calls `closeSync(null)` which throws, but it is inside the
 *    surrounding try-catch ignore block, so the finally still unlinks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withLock } from "./fs-lock.js";

describe("withLock — backoff arithmetic (mutation survivor L216, deterministic)", () => {
  let root: string;
  let randomSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fslock-surv-"));
    // Pin jitter to its floor (0.5) so the delay is deterministic.
    randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    randomSpy.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("first backoff delay uses expBackoff * jitter (not / jitter)", async () => {
    const lock = path.join(root, "backoff.lock");
    // Fresh lock held by a LIVE owner → unreclaimable → reaches the sleep branch.
    fs.writeFileSync(
      lock,
      JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        createdAt: new Date().toISOString(),
        label: "bk",
      }),
    );
    fs.utimesSync(lock, Date.now() / 1000, Date.now() / 1000);

    const delays: number[] = [];
    const realSetTimeout = setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: any, ms?: number) => {
      if (typeof ms === "number") delays.push(ms);
      return realSetTimeout(fn, ms);
    });
    try {
      await expect(
        withLock(lock, async () => "x", { timeoutMs: 2_000, pollMs: 100, staleMs: 60_000 }),
      ).rejects.toThrow(/Timeout acquiring lock/);
    } finally {
      spy.mockRestore();
    }
    expect(delays.length).toBeGreaterThan(0);
    // basePollMs=100, attempt=1 → expBackoff = min(1000, 100*2)=200.
    // jitterFactor = 0.5 + 0 = 0.5. Original: round(200 * 0.5) = 100.
    // Mutant (`/`):  round(200 / 0.5) = 400.
    // remainingMs ≈ 2000 so no clamp on the first delay.
    expect(delays[0]).toBeGreaterThanOrEqual(90);
    expect(delays[0]).toBeLessThanOrEqual(150);
  });
});
