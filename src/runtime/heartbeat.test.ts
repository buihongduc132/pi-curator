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
