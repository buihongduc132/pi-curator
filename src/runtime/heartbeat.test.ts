import { describe, expect, it } from "vitest";
import {
  createBeforeExitHandler,
  isCuratorPhase,
  nextPhase,
  phaseAtLeast,
  startHeartbeat,
  tickHeartbeat,
  type CuratorPhase,
  type PhaseEvent,
} from "./heartbeat.js";

// ─── nextPhase (pure phase FSM) ────────────────────────────────────────────

describe("nextPhase", () => {
  const cases: Array<[CuratorPhase, PhaseEvent, CuratorPhase]> = [
    // start_review: only spawned advances to scanning
    ["spawned", "start_review", "scanning"],
    ["scanning", "start_review", "scanning"], // no-op once reviewing
    ["signaling", "start_review", "signaling"], // no regression
    // signal: advance to signaling
    ["spawned", "signal", "signaling"], // defensive fast-signal allowed
    ["scanning", "signal", "signaling"],
    ["signaling", "signal", "signaling"], // idempotent
    // exit: always terminal done
    ["spawned", "exit", "done"],
    ["scanning", "exit", "done"],
    ["signaling", "exit", "done"],
    // done is terminal
    ["done", "start_review", "done"],
    ["done", "signal", "done"],
    ["done", "exit", "done"],
  ];
  for (const [from, event, expected] of cases) {
    it(`${from} + ${event} → ${expected}`, () => {
      expect(nextPhase(from, event)).toBe(expected);
    });
  }

  it("never regresses past scanning except to done", () => {
    // signaling + start_review must not go back to scanning
    expect(nextPhase("signaling", "start_review")).toBe("signaling");
  });
});

// ─── phase helpers ─────────────────────────────────────────────────────────

describe("phase helpers", () => {
  it("isCuratorPhase narrows valid phases", () => {
    expect(isCuratorPhase("spawned")).toBe(true);
    expect(isCuratorPhase("scanning")).toBe(true);
    expect(isCuratorPhase("signaling")).toBe(true);
    expect(isCuratorPhase("done")).toBe(true);
    expect(isCuratorPhase("dead")).toBe(false);
    expect(isCuratorPhase("")).toBe(false);
  });

  it("phaseAtLeast compares ranks monotonically", () => {
    expect(phaseAtLeast("spawned", "spawned")).toBe(true);
    expect(phaseAtLeast("scanning", "spawned")).toBe(true);
    expect(phaseAtLeast("signaling", "scanning")).toBe(true);
    expect(phaseAtLeast("done", "signaling")).toBe(true);
    expect(phaseAtLeast("spawned", "scanning")).toBe(false);
    expect(phaseAtLeast("scanning", "signaling")).toBe(false);
  });
});

// ─── tickHeartbeat (pure) ──────────────────────────────────────────────────

describe("tickHeartbeat", () => {
  it("writes a fresh heartbeatAt ISO timestamp", () => {
    const r = tickHeartbeat({ phase: "scanning" }, { nowMs: 1_700_000_000_000 });
    expect(r.heartbeatAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(r.phase).toBe("scanning");
  });

  it("applies a phase event on the tick", () => {
    const r = tickHeartbeat(
      { phase: "scanning" },
      { nowMs: 1_700_000_000_001, phaseEvent: "signal" },
    );
    expect(r.phase).toBe("signaling");
  });

  it("start_review event on spawned advances to scanning on first tick", () => {
    const r = tickHeartbeat(
      { phase: "spawned" },
      { nowMs: 0, phaseEvent: "start_review" },
    );
    expect(r.phase).toBe("scanning");
  });

  it("exit event transitions to done", () => {
    const r = tickHeartbeat(
      { phase: "signaling" },
      { nowMs: 0, phaseEvent: "exit" },
    );
    expect(r.phase).toBe("done");
  });

  it("does not mutate input state", () => {
    const state = { phase: "scanning" as CuratorPhase };
    tickHeartbeat(state, { nowMs: 0, phaseEvent: "signal" });
    expect(state.phase).toBe("scanning"); // unchanged
  });
});

// ─── startHeartbeat (effectful adapter with injected deps) ─────────────────

describe("startHeartbeat", () => {
  function setup() {
    const writes: Array<{ phase: string; nowMs?: number }> = [];
    const errors: unknown[] = [];
    let tickCount = 0;
    const writer = async (
      _file: string,
      _pid: number,
      opts: { phase?: string; nowMs?: number },
    ) => {
      tickCount += 1;
      writes.push({ phase: opts.phase ?? "?", nowMs: opts.nowMs });
      return "updated" as const;
    };
    const timers: Array<() => void> = [];
    const scheduler = {
      setInterval: (cb: () => void, _ms: number) => {
        timers.push(cb);
        return timers.length - 1; // handle
      },
      clearInterval: (h: unknown) => {
        delete timers[h as number];
      },
    };
    return { writes, errors, writer, scheduler, timers, getTickCount: () => tickCount };
  }

  it("fires the first tick immediately with start_review (spawned→scanning)", async () => {
    const env = setup();
    let nowMs = 1000;
    const ctrl = startHeartbeat({
      pidsFile: "/tmp/pids/spec.json",
      pid: 4242,
      seedPhase: "spawned",
      now: () => nowMs,
      scheduler: env.scheduler,
      writer: env.writer,
      onError: (e) => env.errors.push(e),
    });
    // first tick is fire-and-forget; allow microtasks to flush
    await Promise.resolve();
    await Promise.resolve();
    expect(env.writes.length).toBe(1);
    expect(env.writes[0]!.phase).toBe("scanning");
    expect(ctrl.getPhase()).toBe("scanning");
    ctrl.stop();
  });

  it("scheduled ticks write heartbeatAt without changing phase", async () => {
    const env = setup();
    let nowMs = 2000;
    const ctrl = startHeartbeat({
      pidsFile: "/tmp/pids/spec.json",
      pid: 99,
      seedPhase: "spawned",
      now: () => nowMs,
      scheduler: env.scheduler,
      writer: env.writer,
    });
    await Promise.resolve();
    await Promise.resolve();
    // first tick
    expect(env.writes.length).toBe(1);

    // fire one scheduled tick
    nowMs = 7000;
    env.timers[0]!();
    await Promise.resolve();
    await Promise.resolve();
    expect(env.writes.length).toBe(2);
    expect(env.writes[1]!.phase).toBe("scanning");
    expect(ctrl.getPhase()).toBe("scanning");
    ctrl.stop();
  });

  it("swallows writer errors (REQ-CR: no crash on write failure)", async () => {
    let calls = 0;
    const errors: unknown[] = [];
    const failingWriter = async () => {
      calls += 1;
      throw new Error("disk full");
    };
    const scheduler = {
      setInterval: (cb: () => void) => {
        // stash so we can fire it
        (scheduler as unknown as { _cb: () => void })._cb = cb;
        return 0;
      },
      clearInterval: () => {},
    };
    const ctrl = startHeartbeat({
      pidsFile: "/tmp/x.json",
      pid: 1,
      seedPhase: "scanning",
      writer: failingWriter,
      scheduler: scheduler as unknown as {
        setInterval: (cb: () => void, ms: number) => unknown;
        clearInterval: (h: unknown) => void;
      },
      onError: (e) => errors.push(e),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1); // first tick fired
    expect(errors.length).toBe(1);
    expect((errors[0] as Error).message).toBe("disk full");
    // loop not stopped by a swallowed error
    expect(ctrl.getPhase()).toBe("scanning");
    ctrl.stop();
  });

  it("skips overlapping ticks via in-flight guard", async () => {
    let resolves: Array<() => void> = [];
    let writeCalls = 0;
    const slowWriter = async () => {
      writeCalls += 1;
      await new Promise<void>((res) => resolves.push(res));
      return "updated" as const;
    };
    const timers: Array<() => void> = [];
    const scheduler = {
      setInterval: (cb: () => void) => {
        timers.push(cb);
        return timers.length - 1;
      },
      clearInterval: () => {},
    };
    startHeartbeat({
      pidsFile: "/tmp/x.json",
      pid: 1,
      seedPhase: "scanning",
      writer: slowWriter,
      scheduler: scheduler as unknown as {
        setInterval: (cb: () => void, ms: number) => unknown;
        clearInterval: (h: unknown) => void;
      },
    });
    // first tick fire-and-forget (pending, not resolved)
    await Promise.resolve();
    // fire two scheduled ticks while the first write is still pending
    timers[0]!();
    timers[0]!();
    await Promise.resolve();
    // still only ONE write in flight
    expect(writeCalls).toBe(1);
    // resolve the in-flight write
    resolves.forEach((r) => r());
    resolves = [];
    await Promise.resolve();
    await Promise.resolve();
    // no new writes from the skipped ticks (they were dropped, not queued)
    expect(writeCalls).toBe(1);
  });

  it("stops the loop when the claim is reclaimed (not_owner/missing)", async () => {
    const env = setup();
    let call = 0;
    const reclaimedWriter = async () => {
      call += 1;
      return call === 1 ? ("updated" as const) : ("not_owner" as const);
    };
    const timers: Array<() => void> = [];
    const scheduler = {
      setInterval: (cb: () => void) => {
        timers.push(cb);
        return timers.length - 1;
      },
      clearInterval: () => {},
    };
    const ctrl = startHeartbeat({
      pidsFile: "/tmp/x.json",
      pid: 1,
      seedPhase: "scanning",
      writer: reclaimedWriter,
      scheduler: scheduler as unknown as {
        setInterval: (cb: () => void, ms: number) => unknown;
        clearInterval: (h: unknown) => void;
      },
      onError: (e) => env.errors.push(e),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(ctrl.getPhase()).toBe("scanning");
    // fire a scheduled tick → reclaims → loop halts
    timers[0]!();
    await Promise.resolve();
    await Promise.resolve();
    expect(env.errors.length).toBe(1);
    // further ticks are no-ops
    timers[0]!();
    await Promise.resolve();
    await Promise.resolve();
    expect(call).toBe(2); // not 3
  });
});

// ─── createBeforeExitHandler ───────────────────────────────────────────────

describe("createBeforeExitHandler", () => {
  it("writes phase done and never throws", async () => {
    const writes: string[] = [];
    const handler = createBeforeExitHandler(
      "/tmp/x.json",
      42,
      async (_f, _p, o) => {
        writes.push(o.phase ?? "?");
        return "updated";
      },
    );
    await handler();
    expect(writes).toEqual(["done"]);
  });

  it("swallows writer failure (REQ-CR non-throwing)", async () => {
    const errors: unknown[] = [];
    const handler = createBeforeExitHandler(
      "/tmp/x.json",
      42,
      async () => {
        throw new Error("boom");
      },
      (e) => errors.push(e),
    );
    await expect(handler()).resolves.toBeUndefined();
    expect(errors.length).toBe(1);
    expect((errors[0] as Error).message).toBe("boom");
  });

  it("swallows even logger failure", async () => {
    const handler = createBeforeExitHandler(
      "/tmp/x.json",
      42,
      async () => {
        throw new Error("boom");
      },
      () => {
        throw new Error("logger also broken");
      },
    );
    await expect(handler()).resolves.toBeUndefined();
  });
});

// ─── curatorSessionId pointer write-back (LD1) ─────────────────────────────
//
// RED PHASE: these tests are EXPECTED TO FAIL until the GREEN phase adds:
//   - `tickHeartbeat` accepting `curatorSessionId` in opts
//   - `TickResult.curatorSessionId` carrying it through
//   - `startHeartbeat` passing curatorSessionId to the writer (first tick only)
//
// See: flow/findings/curator-observability/2026-07-07-locked-decisions.yaml LD1.

describe("tickHeartbeat — curatorSessionId pointer (LD1)", () => {
  it("accepts curatorSessionId in opts and surfaces it in the TickResult", () => {
    const r = tickHeartbeat(
      { phase: "scanning" },
      { nowMs: 1_700_000_000_000, curatorSessionId: "ses_123" },
    );
    expect(r.heartbeatAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(r.phase).toBe("scanning");
    expect(r.curatorSessionId).toBe("ses_123");
  });

  it("returns curatorSessionId undefined when no id is known", () => {
    const r = tickHeartbeat({ phase: "scanning" }, { nowMs: 0 });
    expect(r.curatorSessionId).toBeUndefined();
  });

  it("carries curatorSessionId alongside a phase event", () => {
    const r = tickHeartbeat(
      { phase: "spawned" },
      { nowMs: 0, phaseEvent: "start_review", curatorSessionId: "ses_abc" },
    );
    expect(r.phase).toBe("scanning");
    expect(r.curatorSessionId).toBe("ses_abc");
  });
});

describe("startHeartbeat — curatorSessionId write-back (LD1)", () => {
  function setup() {
    const writes: Array<{ phase?: string; nowMs?: number; curatorSessionId?: string }> = [];
    const writer = async (
      _file: string,
      _pid: number,
      opts: { phase?: string; nowMs?: number; curatorSessionId?: string },
    ) => {
      writes.push({ ...opts });
      return "updated" as const;
    };
    const timers: Array<() => void> = [];
    const scheduler = {
      setInterval: (cb: () => void, _ms: number) => {
        timers.push(cb);
        return timers.length - 1;
      },
      clearInterval: (_h: unknown) => {},
    };
    return { writes, writer, scheduler, timers };
  }

  it("writes curatorSessionId on the first heartbeat tick", async () => {
    const env = setup();
    const ctrl = startHeartbeat({
      pidsFile: "/tmp/pids/spec.json",
      pid: 4242,
      seedPhase: "spawned",
      now: () => 1000,
      scheduler: env.scheduler,
      writer: env.writer,
      curatorSessionId: "ses_123",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(env.writes.length).toBeGreaterThanOrEqual(1);
    expect(env.writes[0]!.curatorSessionId).toBe("ses_123");
    ctrl.stop();
  });

  it("does NOT pass curatorSessionId when none was provided", async () => {
    const env = setup();
    const ctrl = startHeartbeat({
      pidsFile: "/tmp/pids/spec.json",
      pid: 4242,
      seedPhase: "spawned",
      now: () => 1000,
      scheduler: env.scheduler,
      writer: env.writer,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(env.writes.length).toBeGreaterThanOrEqual(1);
    expect(env.writes[0]!.curatorSessionId).toBeUndefined();
    ctrl.stop();
  });
});

// ─── Mutation survivor remediation (targeted kills) ─────────────────────────

describe("nextPhase — defensive fallback (mutation survivors L120)", () => {
  // L120:14 ConditionalExpression `true` (whole signal condition) and
  // L120:40 EqualityOperator `!==` (`current === "signaling"` → `!==`):
  // for any phase that is NOT spawned/scanning/signaling/done, the `signal`
  // event MUST fall through to the `: current` branch (return the unknown
  // phase unchanged), NOT jump to "signaling".
  it("returns the unknown phase unchanged on a 'signal' event (no jump to signaling)", () => {
    expect(nextPhase("bogus" as CuratorPhase, "signal")).toBe("bogus");
    expect(nextPhase("zzz" as CuratorPhase, "signal")).not.toBe("signaling");
  });
});

describe("startHeartbeat — interval computation (mutation survivors L231)", () => {
  // L231 LogicalOperator `&&` and ArithmeticOperator `/`: when intervalMs is
  // NOT supplied, the scheduler MUST receive `config.intervalSec * 1000`.
  it("derives the interval from config.intervalSec * 1000 when intervalMs is absent", () => {
    const seenMs: number[] = [];
    const scheduler = {
      setInterval: (_cb: () => void, ms: number) => {
        seenMs.push(ms);
        return 0;
      },
      clearInterval: () => {},
    };
    const ctrl = startHeartbeat({
      pidsFile: "/x",
      pid: 1,
      // NO intervalMs → exercises config.intervalSec * 1000
      config: { intervalSec: 7, staleSec: 30, deadSec: 120 },
      scheduler,
      writer: async () => "updated",
    });
    ctrl.stop();
    expect(seenMs).toContain(7000);
  });
});

describe("startHeartbeat — runTick return values + overlap (mutation survivors)", () => {
  function noopScheduler() {
    return {
      setInterval: () => 0,
      clearInterval: () => {},
    };
  }

  // L255 BooleanLiteral `true`→`false` (`return true` on success → `return false`).
  it("tick() resolves true when the writer returns 'updated'", async () => {
    const ctrl = startHeartbeat({
      pidsFile: "/x",
      pid: 1,
      seedPhase: "scanning",
      scheduler: noopScheduler(),
      writer: async () => "updated",
    });
    await Promise.resolve();
    await Promise.resolve();
    await expect(ctrl.tick()).resolves.toBe(true);
    ctrl.stop();
  });

  // L240 BooleanLiteral `false`→`true` (`if (stopped) return false` → `return true`).
  it("tick() resolves false after stop()", async () => {
    const ctrl = startHeartbeat({
      pidsFile: "/x",
      pid: 1,
      seedPhase: "scanning",
      scheduler: noopScheduler(),
      writer: async () => "updated",
    });
    await Promise.resolve();
    await Promise.resolve();
    ctrl.stop();
    await expect(ctrl.tick()).resolves.toBe(false);
  });

  // L241 BooleanLiteral `false`→`true` (`if (inFlight) return false` → `return true`).
  it("tick() resolves false while a previous tick is still in flight", async () => {
    let resolveFirst!: () => void;
    const first = new Promise<void>((r) => (resolveFirst = r));
    let calls = 0;
    const writer = async () => {
      calls += 1;
      if (calls === 1) await first; // block the first tick
      return "updated" as const;
    };
    const ctrl = startHeartbeat({
      pidsFile: "/x",
      pid: 1,
      seedPhase: "scanning",
      scheduler: noopScheduler(),
      writer,
    });
    await Promise.resolve();
    await Promise.resolve();
    const pending = ctrl.tick(); // calls=1, blocks on `first`
    await Promise.resolve();
    await Promise.resolve();
    // Overlapping tick while the first is in flight → must be skipped (false).
    await expect(ctrl.tick()).resolves.toBe(false);
    resolveFirst();
    await pending;
    ctrl.stop();
  });
});

describe("startHeartbeat — not_owner/missing halts the loop (mutation survivors)", () => {
  // L259 OptionalChaining (onError optional call), L261 ConditionalExpression
  // false / EqualityOperator `===` (handle check → clearInterval), L262
  // BooleanLiteral `false`→`true` (return false → return true).
  it("clears the interval, calls onError, returns false, and stops on 'not_owner'", async () => {
    const cleared: unknown[] = [];
    const errors: unknown[] = [];
    const scheduler = {
      setInterval: () => "H1",
      clearInterval: (h: unknown) => {
        cleared.push(h);
      },
    };
    const ctrl = startHeartbeat({
      pidsFile: "/x",
      pid: 1,
      seedPhase: "scanning",
      scheduler,
      writer: async () => "not_owner",
      onError: (e) => errors.push(e),
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(cleared).toContain("H1");
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(/stopping loop/);
    await expect(ctrl.tick()).resolves.toBe(false);
  });

  // L259 OptionalChaining specifically: when onError is NOT provided, the
  // not_owner path must NOT throw and the loop still halts.
  it("does not throw on not_owner when onError is absent, and halts the loop", async () => {
    let calls = 0;
    const ctrl = startHeartbeat({
      pidsFile: "/x",
      pid: 1,
      seedPhase: "scanning",
      scheduler: { setInterval: () => "H", clearInterval: () => {} },
      writer: async () => {
        calls += 1;
        return "not_owner" as const;
      },
      // NOTE: no onError → exercises the optional-chaining short-circuit.
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    await expect(ctrl.tick()).resolves.toBe(false);
    expect(calls).toBe(1);
  });
});

describe("startHeartbeat — writer errors are swallowed (mutation survivors)", () => {
  // L265 OptionalChaining (onError optional call) + L266 BooleanLiteral
  // `false`→`true` (`return false` → `return true` in the catch).
  it("tick() resolves false (never rejects) when the writer throws", async () => {
    const ctrl = startHeartbeat({
      pidsFile: "/x",
      pid: 1,
      seedPhase: "scanning",
      scheduler: { setInterval: () => 0, clearInterval: () => {} },
      writer: async () => {
        throw new Error("disk full");
      },
      onError: () => {},
    });
    await Promise.resolve();
    await Promise.resolve();
    await expect(ctrl.tick()).resolves.toBe(false);
    ctrl.stop();
  });

  // L265 OptionalChaining specifically: when onError is NOT provided, a
  // throwing writer must still NOT reject the tick promise.
  it("tick() resolves false (never rejects) when the writer throws and onError is absent", async () => {
    const ctrl = startHeartbeat({
      pidsFile: "/x",
      pid: 1,
      seedPhase: "scanning",
      scheduler: { setInterval: () => 0, clearInterval: () => {} },
      writer: async () => {
        throw new Error("boom");
      },
      // no onError
    });
    await Promise.resolve();
    await Promise.resolve();
    await expect(ctrl.tick()).resolves.toBe(false);
    ctrl.stop();
  });
});

describe("startHeartbeat — stop() + undefined scheduler handle (mutation survivors)", () => {
  // L283 BlockStatement `{}` (stop body) + L284 BooleanLiteral `false`→`true`
  // (`stopped = true` → `stopped = false`).
  it("stop() prevents subsequent ticks from calling the writer", async () => {
    let calls = 0;
    const ctrl = startHeartbeat({
      pidsFile: "/x",
      pid: 1,
      seedPhase: "scanning",
      scheduler: { setInterval: () => 0, clearInterval: () => {} },
      writer: async () => {
        calls += 1;
        return "updated" as const;
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    const callsBefore = calls;
    ctrl.stop();
    await expect(ctrl.tick()).resolves.toBe(false);
    expect(calls).toBe(callsBefore);
  });

  // L285 ConditionalExpression false / EqualityOperator `===` (handle check
  // → clearInterval) in stop().
  it("stop() clears the interval handle returned by the scheduler", () => {
    const cleared: unknown[] = [];
    const ctrl = startHeartbeat({
      pidsFile: "/x",
      pid: 1,
      seedPhase: "scanning",
      scheduler: {
        setInterval: () => "HANDLE-XYZ",
        clearInterval: (h) => cleared.push(h),
      },
      writer: async () => "updated",
    });
    ctrl.stop();
    expect(cleared).toContain("HANDLE-XYZ");
  });

  // L261:true + L285:true (ConditionalExpression `true` — always clear even
  // when handle is undefined).
  it("does not call clearInterval when the scheduler handle is undefined", async () => {
    const cleared: unknown[] = [];
    const ctrl = startHeartbeat({
      pidsFile: "/x",
      pid: 1,
      seedPhase: "scanning",
      scheduler: {
        setInterval: () => undefined,
        clearInterval: (h) => cleared.push(h),
      },
      writer: async () => "not_owner",
      onError: () => {},
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(cleared).toHaveLength(0);
    ctrl.stop();
    expect(cleared).toHaveLength(0);
  });
});

describe("createBeforeExitHandler — error swallowing (mutation survivor L320)", () => {
  // L320 OptionalChaining (`onError?.(err)` → `onError(err)`): when onError is
  // NOT provided AND the writer throws, the handler MUST still resolve.
  it("resolves (never rejects) when the writer throws and onError is absent", async () => {
    const handler = createBeforeExitHandler("/x", 1, async () => {
      throw new Error("fail");
    });
    await expect(handler()).resolves.toBeUndefined();
  });

  it("invokes onError when the writer throws and onError is provided", async () => {
    const errors: unknown[] = [];
    const handler = createBeforeExitHandler(
      "/x",
      1,
      async () => {
        throw new Error("fail2");
      },
      (e) => errors.push(e),
    );
    await handler();
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("fail2");
  });

  it("resolves (never rejects) when onError itself throws", async () => {
    const handler = createBeforeExitHandler(
      "/x",
      1,
      async () => {
        throw new Error("writer");
      },
      () => {
        throw new Error("logger");
      },
    );
    await expect(handler()).resolves.toBeUndefined();
  });
});
