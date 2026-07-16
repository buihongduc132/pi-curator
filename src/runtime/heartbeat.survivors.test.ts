/**
 * heartbeat.survivors.test.ts — kills surviving mutants in src/runtime/heartbeat.ts.
 *
 * Killable:
 *  - id 1575 (nextPhase signal arm → false): nextPhase("scanning","signal") must
 *    yield "signaling".
 *  - id 1585 (nextPhase default case): an unknown event returns current (a
 *    no-default mutant returns undefined).
 *  - id 1599 (default scheduler object → {}): startHeartbeat without a scheduler
 *    must not throw (mutant: scheduler.setInterval is not a function).
 *  - id 1600 (setInterval arrow → noop): periodic ticks MUST fire (fake timers).
 *  - id 1601 (clearInterval arrow → noop): stop() MUST halt periodic ticks.
 *  - id 1603 (default writer in startHeartbeat): the default writer MUST actually
 *    write to the claim file (mutant is a noop → loop halts on `undefined`).
 *  - id 1655 (default writer in createBeforeExitHandler): MUST write phase "done".
 *  - id 1635 (runTick missing/not_owner `return false`): controller.tick() after a
 *    "missing" writer result resolves to false (mutant returns true).
 *
 * EQUIVALENT:
 *  - id 1554 (`if (current === "done") return "done"`): every event from "done"
 *    already returns "done" via the switch, so skipping the terminal guard is a
 *    no-op.
 *  - id 1642/1643 (firstTick bookkeeping): with firstTick stuck true, every tick
 *    passes "start_review", but start_review only transitions spawned→scanning;
 *    once scanning it is a no-op, so the written phase is unchanged.
 *  - id 1662 (`onError?.(err)` → `onError(err)`): when onError is undefined the
 *    mutant throws, but it is inside a try-catch swallow block, so the beforeExit
 *    handler still resolves void identically.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  nextPhase,
  startHeartbeat,
  createBeforeExitHandler,
} from "./heartbeat.js";

describe("heartbeat survivors — pure FSM", () => {
  it("nextPhase: signal from scanning → signaling (kills signal-arm mutant)", () => {
    expect(nextPhase("scanning", "signal")).toBe("signaling");
  });

  it("nextPhase: signal from spawned → signaling (defensive jump)", () => {
    expect(nextPhase("spawned", "signal")).toBe("signaling");
  });

  it("nextPhase: unknown event returns current phase (kills default-case mutant)", () => {
    expect(nextPhase("scanning", "unknown" as never)).toBe("scanning");
    expect(nextPhase("signaling", "mystery" as never)).toBe("signaling");
  });
});

describe("heartbeat survivors — default scheduler/writer", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hb-surv-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("startHeartbeat without a scheduler does not throw (kills scheduler-object mutant)", () => {
    const ctrl = startHeartbeat({
      pidsFile: path.join(tmp, "claim.json"),
      pid: 1,
      writer: async () => "updated",
      intervalMs: 1e9,
    });
    expect(ctrl).toBeDefined();
    ctrl.stop();
  });

  it("startHeartbeat default writer actually writes the claim (kills default-writer mutant)", async () => {
    const claimFile = path.join(tmp, "claim.json");
    // Seed a claim owned by pid 1 so the default writer (heartbeatCuratorClaim)
    // returns "updated" rather than "missing".
    fs.writeFileSync(
      claimFile,
      JSON.stringify({
        pid: 1,
        mainSessionId: "ses",
        curator: "c",
        spawnedAt: new Date(0).toISOString(),
        heartbeatAt: new Date(0).toISOString(),
        phase: "spawned",
      }),
    );
    const ctrl = startHeartbeat({
      pidsFile: claimFile,
      pid: 1,
      // No writer → uses the real default writer.
      intervalMs: 1e9,
    });
    // Let the immediate first tick (fire-and-forget) settle.
    await new Promise((r) => setTimeout(r, 50));
    ctrl.stop();
    const updated = JSON.parse(fs.readFileSync(claimFile, "utf8"));
    // Phase advanced spawned → scanning and heartbeatAt refreshed far past epoch.
    expect(updated.phase).toBe("scanning");
    expect(Date.parse(updated.heartbeatAt)).toBeGreaterThan(1_000_000);
  });

  it("createBeforeExitHandler default writer writes phase 'done' (kills default-writer mutant)", async () => {
    const claimFile = path.join(tmp, "claim.json");
    fs.writeFileSync(
      claimFile,
      JSON.stringify({
        pid: 1,
        mainSessionId: "ses",
        curator: "c",
        spawnedAt: new Date(0).toISOString(),
        heartbeatAt: new Date(0).toISOString(),
        phase: "scanning",
      }),
    );
    const handler = createBeforeExitHandler(claimFile, 1); // no writer → default
    await handler();
    const updated = JSON.parse(fs.readFileSync(claimFile, "utf8"));
    expect(updated.phase).toBe("done");
  });
});

describe("heartbeat survivors — periodic ticks (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("periodic interval ticks fire (kills setInterval→noop mutant)", async () => {
    let calls = 0;
    const ctrl = startHeartbeat({
      pidsFile: "/tmp/none.json",
      pid: 1,
      writer: async () => {
        calls++;
        return "updated";
      },
      intervalMs: 100,
    });
    // Let the immediate first tick resolve.
    await vi.advanceTimersByTimeAsync(0);
    const first = calls;
    // Advance past several intervals.
    await vi.advanceTimersByTimeAsync(350);
    ctrl.stop();
    expect(calls - first).toBeGreaterThanOrEqual(2); // periodic ticks fired
  });

  it("stop() halts periodic ticks (kills clearInterval→noop mutant)", async () => {
    let calls = 0;
    const ctrl = startHeartbeat({
      pidsFile: "/tmp/none.json",
      pid: 1,
      writer: async () => {
        calls++;
        return "updated";
      },
      intervalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(0);
    const before = calls;
    ctrl.stop();
    await vi.advanceTimersByTimeAsync(1000);
    // No further writes after stop().
    expect(calls).toBe(before);
  });

  it("tick() after a 'missing' writer result resolves false (kills return-false→true mutant)", async () => {
    let call = 0;
    const ctrl = startHeartbeat({
      pidsFile: "/tmp/none.json",
      pid: 1,
      writer: async () => (call++ === 0 ? "updated" : "missing"),
      intervalMs: 1e9,
    });
    // Let the immediate first tick ("updated") settle so stopped stays false.
    await vi.advanceTimersByTimeAsync(0);
    // Second explicit tick → "missing" → runTick returns false (original).
    const r = await ctrl.tick();
    expect(r).toBe(false);
    ctrl.stop();
  });
});
