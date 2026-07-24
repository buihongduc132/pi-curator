/**
 * logging-verification.test.ts — GREEN verification that the runtime extension
 * emits OTel log records at EVERY instrumentation point required by
 * flow/plans/otel-logging/design.md.
 *
 * Status: GREEN — the runtime IS already wired (variable `rtLog`, not `log`).
 * The earlier "0 emits" callout was a grep artifact (the variable is named
 * `rtLog`, not `log`). This file DOCUMENTS + LOCKS the wiring so it cannot
 * silently regress.
 *
 * Approach: MOCK the logger module so every emit is captured, then assert
 * each design-mandated instrumentation point fires at the right level with
 * the required attributes, and that trace.id is inherited from the spawn env
 * (PI_CURATOR_TRACE_ID) via createCuratorLogger's `traceId` option.
 *
 * Instrumentation points asserted (per design.md "Runtime side"):
 *  - extension loaded (info)
 *  - identity loaded (info) — attrs: alias, mainId, mainName, curatorSessionId, traceId
 *  - identity env not set (warn)
 *  - pi-intercom not found (warn)
 *  - signal_main registered (info)
 *  - heartbeat started (info) — attrs: alias, phase, claimPath, heartbeatAt-equivalent
 *  - heartbeat write failed onError (warn)
 *  - beforeExit done (info) — attrs: alias, phase, result
 *  - runtime setup failed catch (error)
 *  - signal_main onLog routing (info/warn/error via child("signal_main"))
 *  - trace.id inherited from PI_CURATOR_TRACE_ID
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Mock the heartbeat loop BEFORE importing the entry (avoid real setInterval) ──
vi.mock("./heartbeat.js", () => ({
  startHeartbeat: vi.fn(() => ({
    stop: vi.fn(),
    tick: vi.fn(async () => true),
    getPhase: vi.fn(() => "scanning"),
  })),
  createBeforeExitHandler: vi.fn(() => vi.fn(async () => undefined)),
}));

// ── Mock the logger so every emit is captured into `captured` ──
type Captured = {
  scope: string;
  level: "trace" | "debug" | "info" | "warn" | "error";
  msg: string;
  attrs: Record<string, unknown>;
};
const captured: Captured[] = [];

function makeRecorder(scope: string, baseAttrs: Record<string, unknown>) {
  const mk = (level: Captured["level"]) =>
    vi.fn((msg: string, attrs?: Record<string, unknown>) => {
      captured.push({
        scope,
        level,
        msg,
        attrs: { ...baseAttrs, ...(attrs ?? {}) },
      });
    });
  return {
    trace: mk("trace"),
    debug: mk("debug"),
    info: mk("info"),
    warn: mk("warn"),
    error: mk("error"),
    child: vi.fn((childScope: string, extraAttrs?: Record<string, unknown>) =>
      makeRecorder(`${scope}.${childScope}`, { ...baseAttrs, ...(extraAttrs ?? {}) }),
    ),
  };
}

vi.mock("../util/logger.js", () => ({
  createCuratorLogger: vi.fn((opts: {
    sessionId?: string;
    scope?: string;
    traceId?: string;
    persistentAttrs?: Record<string, unknown>;
  }) => {
    const baseAttrs: Record<string, unknown> = {
      "session.id": opts.sessionId,
      "scope.name": opts.scope,
      ...(opts.persistentAttrs ?? {}),
    };
    if (opts.traceId) baseAttrs["trace.id"] = opts.traceId;
    return makeRecorder(opts.scope ?? "root", baseAttrs);
  }),
}));

import curatorRuntimeExtension, { ENV } from "./index.js";
import { createCuratorLogger } from "../util/logger.js";
import { startHeartbeat, createBeforeExitHandler } from "./heartbeat.js";

// ── helpers ──
const REAL_ENV = { ...process.env };

function setCuratorEnv(identity: {
  curatorAlias?: string;
  mainSessionId?: string;
  mainSessionName?: string;
  spawnedAt?: string;
}): void {
  process.env[ENV.ALIAS] = identity.curatorAlias ?? "spec";
  process.env[ENV.MAIN_ID] = identity.mainSessionId ?? "main-abc";
  process.env[ENV.MAIN_NAME] = identity.mainSessionName ?? "main-session";
  process.env[ENV.SPAWNED_AT] = identity.spawnedAt ?? "2026-07-07T00:00:00.000Z";
}

function clearCuratorEnv(): void {
  delete process.env[ENV.ALIAS];
  delete process.env[ENV.MAIN_ID];
  delete process.env[ENV.MAIN_NAME];
  delete process.env[ENV.SPAWNED_AT];
  delete process.env.PI_CURATOR_TRACE_ID;
}

function makePi() {
  return { registerTool: vi.fn(() => undefined) };
}

function makeCtx(sessionId?: string) {
  return {
    sessionId,
    ui: { notify: vi.fn(() => undefined) },
    tools: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  captured.length = 0;
});

afterEach(() => {
  process.env = { ...REAL_ENV };
  vi.restoreAllMocks();
});

function findCaptured(pred: (c: Captured) => boolean): Captured | undefined {
  return captured.find(pred);
}

// ── createCuratorLogger wiring + trace propagation ───────────────────────────

describe("runtime logging — createCuratorLogger wiring", () => {
  it("constructs the runtime logger with scope 'curator.runtime' and the main session id", () => {
    setCuratorEnv({ mainSessionId: "main-xyz" });
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);

    curatorRuntimeExtension(makePi() as any, makeCtx("ses_c") as any);

    expect(createCuratorLogger).toHaveBeenCalledTimes(1);
    const opts = (createCuratorLogger as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(opts.scope).toBe("curator.runtime");
    expect(opts.sessionId).toBe("main-xyz");
    expect(opts.persistentAttrs).toHaveProperty("pid");

    onSpy.mockRestore();
  });

  it("inherits trace.id from PI_CURATOR_TRACE_ID env (design: distributed trace)", () => {
    setCuratorEnv({});
    process.env.PI_CURATOR_TRACE_ID = "0123456789abcdef0123456789abcdef";
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);

    curatorRuntimeExtension(makePi() as any, makeCtx("ses_t") as any);

    const opts = (createCuratorLogger as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(opts.traceId).toBe("0123456789abcdef0123456789abcdef");
    // Every captured record from the runtime logger carries the trace.id attr.
    const runtimeCalls = captured.filter((c) => c.scope === "curator.runtime");
    expect(runtimeCalls.length).toBeGreaterThan(0);
    for (const c of runtimeCalls) {
      expect(c.attrs["trace.id"]).toBe("0123456789abcdef0123456789abcdef");
    }

    onSpy.mockRestore();
  });

  it("passes undefined traceId when PI_CURATOR_TRACE_ID is absent (no false trace)", () => {
    setCuratorEnv({});
    delete process.env.PI_CURATOR_TRACE_ID;
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);

    curatorRuntimeExtension(makePi() as any, makeCtx("ses_nt") as any);

    const opts = (createCuratorLogger as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(opts.traceId).toBeUndefined();

    onSpy.mockRestore();
  });
});

// ── Instrumentation points (per design.md) ───────────────────────────────────

describe("runtime logging — extension load (info)", () => {
  it("emits 'runtime extension loaded' at INFO on scope curator.runtime", () => {
    setCuratorEnv({});
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);

    curatorRuntimeExtension(makePi() as any, makeCtx("ses_1") as any);

    const rec = findCaptured(
      (c) => c.scope === "curator.runtime" && c.msg === "runtime extension loaded",
    );
    expect(rec).toBeDefined();
    expect(rec!.level).toBe("info");

    onSpy.mockRestore();
  });
});

describe("runtime logging — identity loaded (info)", () => {
  it("emits 'identity loaded' with alias, session.id, session.name, curator.session.id", () => {
    setCuratorEnv({
      curatorAlias: "scold",
      mainSessionId: "main-1",
      mainSessionName: "main-name-1",
    });
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);

    curatorRuntimeExtension(makePi() as any, makeCtx("ses_curator_xyz") as any);

    const rec = findCaptured(
      (c) => c.scope === "curator.runtime" && c.msg === "identity loaded",
    );
    expect(rec).toBeDefined();
    expect(rec!.level).toBe("info");
    expect(rec!.attrs["persona.alias"]).toBe("scold");
    expect(rec!.attrs["session.id"]).toBe("main-1");
    expect(rec!.attrs["session.name"]).toBe("main-name-1");
    expect(rec!.attrs["curator.session.id"]).toBe("ses_curator_xyz");

    onSpy.mockRestore();
  });

  it("falls back to ctx.session.id for curator.session.id when ctx.sessionId absent", () => {
    setCuratorEnv({});
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    const ctx = { session: { id: "via_session_id" }, ui: { notify: vi.fn() }, tools: {} };

    curatorRuntimeExtension(makePi() as any, ctx as any);

    const rec = findCaptured((c) => c.msg === "identity loaded");
    expect(rec).toBeDefined();
    expect(rec!.attrs["curator.session.id"]).toBe("via_session_id");

    onSpy.mockRestore();
  });
});

describe("runtime logging — identity env not set (warn)", () => {
  it("emits 'identity env not set; signal_main not registered' at WARN when env absent", () => {
    clearCuratorEnv();
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);

    curatorRuntimeExtension(makePi() as any, makeCtx("ses_noid") as any);

    const rec = findCaptured((c) => c.msg === "identity env not set; signal_main not registered");
    expect(rec).toBeDefined();
    expect(rec!.level).toBe("warn");
    expect(rec!.scope).toBe("curator.runtime");

    onSpy.mockRestore();
  });
});

describe("runtime logging — pi-intercom not found (warn)", () => {
  it("emits 'pi-intercom not found; signal_main will use findings fallback' at WARN", () => {
    setCuratorEnv({});
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    // ctx with no intercom → fallback client → warn emitted.
    curatorRuntimeExtension(makePi() as any, makeCtx("ses_no_ic") as any);

    const rec = findCaptured(
      (c) => c.msg === "pi-intercom not found; signal_main will use findings fallback",
    );
    expect(rec).toBeDefined();
    expect(rec!.level).toBe("warn");

    onSpy.mockRestore();
  });

  it("does NOT emit the pi-intercom warning when ctx.tools.intercom.send exists", () => {
    setCuratorEnv({});
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    const ctx = {
      sessionId: "ses_ic_ok",
      ui: { notify: vi.fn() },
      tools: { intercom: { send: vi.fn(async () => undefined) } },
    };

    curatorRuntimeExtension(makePi() as any, ctx as any);

    const rec = findCaptured(
      (c) => c.msg === "pi-intercom not found; signal_main will use findings fallback",
    );
    expect(rec).toBeUndefined();

    onSpy.mockRestore();
  });
});

describe("runtime logging — signal_main registered (info)", () => {
  it("emits 'signal_main registered' with persona.alias and target", () => {
    setCuratorEnv({
      curatorAlias: "spec",
      mainSessionName: "main-target-9",
    });
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);

    curatorRuntimeExtension(makePi() as any, makeCtx("ses_reg") as any);

    const rec = findCaptured((c) => c.msg === "signal_main registered");
    expect(rec).toBeDefined();
    expect(rec!.level).toBe("info");
    expect(rec!.attrs["persona.alias"]).toBe("spec");
    expect(rec!.attrs["target"]).toBe("main-target-9");

    onSpy.mockRestore();
  });
});

describe("runtime logging — heartbeat started (info)", () => {
  it("emits 'heartbeat started' with persona.alias, curatorSessionId, pidsFile", () => {
    setCuratorEnv({ curatorAlias: "spec" });
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);

    curatorRuntimeExtension(makePi() as any, makeCtx("ses_hb") as any);

    const rec = findCaptured((c) => c.msg === "heartbeat started");
    expect(rec).toBeDefined();
    expect(rec!.level).toBe("info");
    expect(rec!.attrs["persona.alias"]).toBe("spec");
    expect(rec!.attrs["curatorSessionId"]).toBe("ses_hb");
    expect(typeof rec!.attrs["pidsFile"]).toBe("string");

    onSpy.mockRestore();
  });
});

describe("runtime logging — heartbeat onError → warn", () => {
  it("emits 'heartbeat write failed' at WARN with persona.alias + error when onError fires", () => {
    setCuratorEnv({ curatorAlias: "spec" });
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);

    curatorRuntimeExtension(makePi() as any, makeCtx("ses_err") as any);

    const opts = (startHeartbeat as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    opts.onError(new Error("disk full"));

    const rec = findCaptured((c) => c.msg === "heartbeat write failed");
    expect(rec).toBeDefined();
    expect(rec!.level).toBe("warn");
    expect(rec!.attrs["persona.alias"]).toBe("spec");
    expect(rec!.attrs["error"]).toBe("disk full");

    onSpy.mockRestore();
  });
});

describe("runtime logging — beforeExit done (info)", () => {
  it("emits 'curator done (beforeExit)' at INFO with persona.alias + phase=done when beforeExit fires", async () => {
    setCuratorEnv({ curatorAlias: "spec" });
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);

    curatorRuntimeExtension(makePi() as any, makeCtx("ses_done") as any);

    const registered = onSpy.mock.calls.find((c) => c[0] === "beforeExit");
    expect(registered).toBeDefined();
    await registered![1]();

    const rec = findCaptured((c) => c.msg === "curator done (beforeExit)");
    expect(rec).toBeDefined();
    expect(rec!.level).toBe("info");
    expect(rec!.attrs["persona.alias"]).toBe("spec");
    expect(rec!.attrs["phase"]).toBe("done");

    onSpy.mockRestore();
  });
});

describe("runtime logging — setup failed catch (error)", () => {
  it("emits 'runtime setup failed' at ERROR with error when registerTool throws", () => {
    setCuratorEnv({});
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    const pi = { registerTool: vi.fn(() => { throw new Error("nope"); }) };

    curatorRuntimeExtension(pi as any, makeCtx("ses_fail") as any);

    const rec = findCaptured((c) => c.msg === "runtime setup failed");
    expect(rec).toBeDefined();
    expect(rec!.level).toBe("error");
    expect(rec!.attrs["error"]).toBe("nope");

    onSpy.mockRestore();
  });
});

// ── signal_main onLog routing ────────────────────────────────────────────────
//
// The runtime wires an `onLog(level,msg,attrs)` callback into createSignalMainTool
// that creates a child logger `rtLog.child("signal_main", {persona.alias})` and
// routes info/warn/error. When signal_main.execute succeeds via intercom, the
// tool calls onLog("info", "signal sent via intercom", {kind}). This proves the
// child routing + persona.alias propagation on the signal_main scope.

describe("runtime logging — signal_main onLog routing (child scope)", () => {
  it("routes a successful intercom send to child('signal_main').info with kind + persona.alias", async () => {
    setCuratorEnv({ curatorAlias: "spec" });
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    const pi = makePi();
    const intercomSend = vi.fn(async () => undefined);
    curatorRuntimeExtension(pi as any, {
      sessionId: "ses_route",
      ui: { notify: vi.fn() },
      tools: { intercom: { send: intercomSend } },
    } as any);

    const tool = pi.registerTool.mock.calls[0][0];
    await tool.execute({ kind: "append", message: "hi" });

    const rec = findCaptured(
      (c) => c.scope === "curator.runtime.signal_main" && c.msg === "signal sent via intercom",
    );
    expect(rec).toBeDefined();
    expect(rec!.level).toBe("info");
    expect(rec!.attrs["persona.alias"]).toBe("spec");
    expect(rec!.attrs["kind"]).toBe("append");

    onSpy.mockRestore();
  });

  it("routes a broker-rejection (after retry) to child('signal_main').error", async () => {
    setCuratorEnv({ curatorAlias: "spec" });
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    const pi = makePi();
    // intercom rejects twice → after-retry error path.
    const intercomSend = vi.fn(async () => Promise.reject(new Error("broker down")));
    curatorRuntimeExtension(pi as any, {
      sessionId: "ses_route2",
      ui: { notify: vi.fn() },
      tools: { intercom: { send: intercomSend } },
    } as any);

    const tool = pi.registerTool.mock.calls[0][0];
    await tool.execute({ kind: "steer", message: "watch budget" });

    const rec = findCaptured(
      (c) => c.scope === "curator.runtime.signal_main" && c.msg === "intercom send failed after retry",
    );
    expect(rec).toBeDefined();
    expect(rec!.level).toBe("error");
    expect(rec!.attrs["persona.alias"]).toBe("spec");
    expect(rec!.attrs["error"]).toBe("broker down");

    onSpy.mockRestore();
  });
});

// ── Coverage summary guard (regression net) ──────────────────────────────────

describe("runtime logging — full instrumentation coverage (regression net)", () => {
  it("a normal spawn emits the core lifecycle sequence: loaded → identity loaded → signal_main registered → heartbeat started", () => {
    setCuratorEnv({ curatorAlias: "spec", mainSessionName: "main-n" });
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);

    curatorRuntimeExtension(makePi() as any, makeCtx("ses_full") as any);

    const msgs = captured
      .filter((c) => c.scope === "curator.runtime")
      .map((c) => c.msg);
    expect(msgs).toContain("runtime extension loaded");
    expect(msgs).toContain("identity loaded");
    expect(msgs).toContain("signal_main registered");
    expect(msgs).toContain("heartbeat started");

    onSpy.mockRestore();
  });
});
