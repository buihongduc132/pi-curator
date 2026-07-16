/**
 * runtime/index.test.ts — INTEGRATION test for the curator-runtime extension
 * entry (`runtime/index.ts`).
 *
 * This is NOT a unit test of `startHeartbeat` (that lives in
 * `heartbeat.test.ts`). It exercises the REAL `curatorRuntimeExtension(pi, ctx)`
 * entry — the function pi loads as the extension default export — and verifies
 * the production wiring:
 *
 *   - `startHeartbeat` is actually CALLED when the extension loads (regression
 *     guard for the dead-code gap where the entry never started the loop).
 *   - `curatorSessionId` (LD1 pointer) is threaded from the pi context into
 *     the heartbeat call so the claim file actually records it.
 *   - The terminal `beforeExit` handler (`phase: "done"`) is registered.
 *   - When the curator identity env vars are absent, the heartbeat is NOT
 *     started (manual/test session — no main to report to).
 *
 * The fs/heartbeat internals are mocked so no real setInterval loop or claim
 * write fires — we assert on the WIRING (the call shape), not the effects.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Mock the heartbeat internals BEFORE importing the entry ──────────────
// The entry imports { startHeartbeat, createBeforeExitHandler } from
// "./heartbeat.js"; vi.mock replaces that module so the real setInterval loop
// never starts in-process and we can assert on the call shape.
vi.mock("./heartbeat.js", () => ({
  startHeartbeat: vi.fn(() => ({
    stop: vi.fn(),
    tick: vi.fn(async () => true),
    getPhase: vi.fn(() => "scanning"),
  })),
  createBeforeExitHandler: vi.fn(() => vi.fn(async () => undefined)),
}));

import curatorRuntimeExtension, {
  ENV,
  MAIN_EXTENSION_LOADED_FLAG,
  isMainExtensionLoaded,
  readCuratorIdentity,
  defaultFindingsDir,
} from "./index.js";
import {
  startHeartbeat,
  createBeforeExitHandler,
} from "./heartbeat.js";
import { curatorClaimFile, defaultPidRoot } from "../util/team-attach-claim.js";

// ── Helpers ──────────────────────────────────────────────────────────────

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
}

function makePi() {
  return { registerTool: vi.fn(() => undefined) };
}

function makeCtx(sessionId?: string) {
  return {
    sessionId,
    ui: { notify: vi.fn(() => undefined) },
    tools: {}, // no intercom → tool still registers with fallback client
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  // Restore env exactly (don't leak curator identity into other suites).
  process.env = { ...REAL_ENV };
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────

describe("curatorRuntimeExtension — heartbeat production wiring", () => {
  it("calls startHeartbeat with curatorSessionId from ctx.sessionId (LD1)", () => {
    setCuratorEnv({});
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);

    curatorRuntimeExtension(makePi() as any, makeCtx("ses_curator_xyz") as any);

    expect(startHeartbeat).toHaveBeenCalledTimes(1);
    const opts = (startHeartbeat as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(opts.curatorSessionId).toBe("ses_curator_xyz");
    expect(opts.pid).toBe(process.pid);

    onSpy.mockRestore();
  });

  it("builds the claim file path as pids/<mainSessionId>/<curator>.json", () => {
    setCuratorEnv({
      curatorAlias: "scold",
      mainSessionId: "main-xyz",
      mainSessionName: "main-name",
    });
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);

    curatorRuntimeExtension(makePi() as any, makeCtx("ses_1") as any);

    const opts = (startHeartbeat as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const expected = curatorClaimFile(
      defaultPidRoot(),
      "main-xyz",
      "scold",
    );
    expect(opts.pidsFile).toBe(expected);
    // Sanity: the path resolves under ~/.pi-curator/pids/main-xyz/scold.json
    const rel = path.relative(path.join(os.homedir(), ".pi-curator", "pids"), opts.pidsFile);
    expect(rel).toBe(path.join("main-xyz", "scold.json"));

    onSpy.mockRestore();
  });

  it("falls back to ctx.session.id when ctx.sessionId is absent", () => {
    setCuratorEnv({});
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    const ctx = { session: { id: "ses_via_session_id" }, ui: { notify: vi.fn() }, tools: {} };

    curatorRuntimeExtension(makePi() as any, ctx as any);

    const opts = (startHeartbeat as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(opts.curatorSessionId).toBe("ses_via_session_id");

    onSpy.mockRestore();
  });

  it("registers the beforeExit done-write handler", () => {
    setCuratorEnv({});
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);

    curatorRuntimeExtension(makePi() as any, makeCtx("ses_x") as any);

    // createBeforeExitHandler called with the claim file + curator pid
    expect(createBeforeExitHandler).toHaveBeenCalledTimes(1);
    const [pidsFile, pid] = (createBeforeExitHandler as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(pidsFile).toContain(path.join("pids", "main-abc", "spec.json"));
    expect(pid).toBe(process.pid);
    // the handler is registered on process "beforeExit"
    expect(onSpy).toHaveBeenCalledWith("beforeExit", expect.any(Function));

    onSpy.mockRestore();
  });

  it("does NOT start the heartbeat when curator identity env is absent", () => {
    clearCuratorEnv();
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);

    curatorRuntimeExtension(makePi() as any, makeCtx("ses_noop") as any);

    expect(startHeartbeat).not.toHaveBeenCalled();
    expect(createBeforeExitHandler).not.toHaveBeenCalled();
    expect(onSpy).not.toHaveBeenCalled();

    onSpy.mockRestore();
  });
});

// ─── REQ-CR-06 defensive check: warn if main-side extension is loaded ────────

describe("curatorRuntimeExtension — REQ-CR-06 defensive check (D8)", () => {
  it("warns when the main-side extension env flag is present", () => {
    const prev = process.env[MAIN_EXTENSION_LOADED_FLAG];
    process.env[MAIN_EXTENSION_LOADED_FLAG] = "1";
    try {
      setCuratorEnv({});
      const notify = vi.fn();
      const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);

      curatorRuntimeExtension(makePi() as any, {
        ...makeCtx("ses_d8"),
        ui: { notify },
      } as any);

      expect(notify).toHaveBeenCalledWith(
        expect.stringMatching(/main-side pi-curator extension detected/),
        "warn",
      );

      onSpy.mockRestore();
    } finally {
      if (prev === undefined) delete process.env[MAIN_EXTENSION_LOADED_FLAG];
      else process.env[MAIN_EXTENSION_LOADED_FLAG] = prev;
    }
  });

  it("does NOT warn when the flag is absent (normal operation)", () => {
    const prev = process.env[MAIN_EXTENSION_LOADED_FLAG];
    delete process.env[MAIN_EXTENSION_LOADED_FLAG];
    try {
      setCuratorEnv({});
      const notify = vi.fn();
      const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);

      curatorRuntimeExtension(makePi() as any, {
        ...makeCtx("ses_normal"),
        ui: { notify },
      } as any);

      // The REQ-CR-06 main-side warning MUST NOT fire in normal operation.
      // (Other unrelated warnings, e.g. pi-intercom absent, may fire.)
      const mainSideWarnings = notify.mock.calls.filter(
        (c) => typeof c[0] === "string" && /main-side pi-curator extension detected/.test(c[0]),
      );
      expect(mainSideWarnings).toHaveLength(0);

      onSpy.mockRestore();
    } finally {
      if (prev !== undefined) process.env[MAIN_EXTENSION_LOADED_FLAG] = prev;
    }
  });
});

// ─── Mutation survivor remediation ──────────────────────────────────────

describe("isMainExtensionLoaded — heuristic surface", () => {
  afterEach(() => {
    delete process.env[MAIN_EXTENSION_LOADED_FLAG];
  });

  it("returns true when env flag is '1'", () => {
    process.env[MAIN_EXTENSION_LOADED_FLAG] = "1";
    expect(isMainExtensionLoaded({}, {})).toBe(true);
  });

  it("returns true when env flag is 'true'", () => {
    process.env[MAIN_EXTENSION_LOADED_FLAG] = "true";
    expect(isMainExtensionLoaded({}, {})).toBe(true);
  });

  it("returns false when env flag is absent and no extension surface matches", () => {
    delete process.env[MAIN_EXTENSION_LOADED_FLAG];
    expect(isMainExtensionLoaded({}, {})).toBe(false);
  });

  it("returns true when ctx.extensions contains a curator-main string", () => {
    delete process.env[MAIN_EXTENSION_LOADED_FLAG];
    expect(
      isMainExtensionLoaded({}, { extensions: ["pi-curator-main"] }),
    ).toBe(true);
  });

  it("returns true when ctx.extensions contains a pi-curator string", () => {
    delete process.env[MAIN_EXTENSION_LOADED_FLAG];
    expect(
      isMainExtensionLoaded({}, { extensions: ["some-pi-curator-thing"] }),
    ).toBe(true);
  });

  it("returns false when ctx.extensions is an array of non-matching strings", () => {
    delete process.env[MAIN_EXTENSION_LOADED_FLAG];
    expect(
      isMainExtensionLoaded({}, { extensions: ["unrelated", "other"] }),
    ).toBe(false);
  });

  it("returns false when ctx.extensions is not an array", () => {
    delete process.env[MAIN_EXTENSION_LOADED_FLAG];
    expect(isMainExtensionLoaded({}, { extensions: "pi-curator" })).toBe(false);
  });

  it("returns true when pi.extensions contains a curator-main string", () => {
    delete process.env[MAIN_EXTENSION_LOADED_FLAG];
    expect(
      isMainExtensionLoaded({ extensions: ["curator-main"] } as any, {}),
    ).toBe(true);
  });

  it("returns false when pi.extensions is an array of non-matching strings", () => {
    delete process.env[MAIN_EXTENSION_LOADED_FLAG];
    expect(
      isMainExtensionLoaded({ extensions: ["nope"] } as any, {}),
    ).toBe(false);
  });

  it("never throws when ctx.extensions getter throws (exception safety)", () => {
    delete process.env[MAIN_EXTENSION_LOADED_FLAG];
    const throwingCtx = {
      get extensions() {
        throw new Error("boom");
      },
    };
    expect(() => isMainExtensionLoaded({}, throwingCtx)).not.toThrow();
    expect(isMainExtensionLoaded({}, throwingCtx)).toBe(false);
  });
});

describe("readCuratorIdentity — env completeness", () => {
  afterEach(() => {
    clearCuratorEnv();
  });

  it("returns the identity when all four env vars are present", () => {
    setCuratorEnv({});
    const id = readCuratorIdentity();
    expect(id).toEqual({
      curatorAlias: "spec",
      mainSessionId: "main-abc",
      mainSessionName: "main-session",
      spawnedAt: "2026-07-07T00:00:00.000Z",
    });
  });

  it("returns null when ALIAS is missing", () => {
    setCuratorEnv({});
    delete process.env[ENV.ALIAS];
    expect(readCuratorIdentity()).toBeNull();
  });

  it("returns null when MAIN_ID is missing", () => {
    setCuratorEnv({});
    delete process.env[ENV.MAIN_ID];
    expect(readCuratorIdentity()).toBeNull();
  });

  it("returns null when MAIN_NAME is missing", () => {
    setCuratorEnv({});
    delete process.env[ENV.MAIN_NAME];
    expect(readCuratorIdentity()).toBeNull();
  });

  it("returns null when SPAWNED_AT is missing", () => {
    setCuratorEnv({});
    delete process.env[ENV.SPAWNED_AT];
    expect(readCuratorIdentity()).toBeNull();
  });
});

describe("defaultFindingsDir", () => {
  it("places findings under <home>/.pi-curator/findings/<mainSessionId>", () => {
    expect(defaultFindingsDir("ses-1", "/home/u")).toBe(
      "/home/u/.pi-curator/findings/ses-1",
    );
  });
});

describe("curatorRuntimeExtension — wiring effects (mutation survivors)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    process.env = { ...REAL_ENV };
    vi.restoreAllMocks();
  });

  function baseEnv() {
    setCuratorEnv({});
  }

  it("registers the signal_main tool via pi.registerTool", () => {
    baseEnv();
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    const pi = makePi();
    curatorRuntimeExtension(pi as any, makeCtx("ses_x") as any);
    expect(pi.registerTool).toHaveBeenCalledTimes(1);
    const tool = pi.registerTool.mock.calls[0][0];
    expect(tool.name).toBe("signal_main");
    onSpy.mockRestore();
  });

  it("notifies 'signal_main registered' with the target main session name", () => {
    baseEnv();
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    const notify = vi.fn();
    curatorRuntimeExtension(makePi() as any, {
      ...makeCtx("ses_x"),
      ui: { notify },
    } as any);
    const registered = notify.mock.calls.find(
      (c) => typeof c[0] === "string" && /signal_main registered/.test(c[0]),
    );
    expect(registered).toBeTruthy();
    expect(registered![0]).toContain("main-session");
    expect(registered![1]).toBe("info");
    onSpy.mockRestore();
  });

  it("notifies 'heartbeat started' including the curator session id", () => {
    baseEnv();
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    const notify = vi.fn();
    curatorRuntimeExtension(makePi() as any, {
      ...makeCtx("ses_hb"),
      ui: { notify },
    } as any);
    const hb = notify.mock.calls.find(
      (c) => typeof c[0] === "string" && /heartbeat started/.test(c[0]),
    );
    expect(hb).toBeTruthy();
    expect(hb![0]).toContain("ses_hb");
    expect(hb![1]).toBe("info");
    onSpy.mockRestore();
  });

  it("invokes the heartbeat onError hook into a UI warn notify", () => {
    baseEnv();
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    const notify = vi.fn();
    curatorRuntimeExtension(makePi() as any, {
      ...makeCtx("ses_err"),
      ui: { notify },
    } as any);
    const opts = (startHeartbeat as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    opts.onError(new Error("disk full"));
    const warn = notify.mock.calls.find(
      (c) => typeof c[0] === "string" && /heartbeat write failed/.test(c[0]),
    );
    expect(warn).toBeTruthy();
    expect(warn![0]).toContain("disk full");
    expect(warn![1]).toBe("warn");
    onSpy.mockRestore();
  });

  it("invokes the beforeExit writeDone handler when beforeExit fires", async () => {
    baseEnv();
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    curatorRuntimeExtension(makePi() as any, makeCtx("ses_done") as any);
    const writeDone = (createBeforeExitHandler as ReturnType<typeof vi.fn>)
      .mock.results[0]!.value as () => Promise<unknown>;
    const registered = onSpy.mock.calls.find((c) => c[0] === "beforeExit");
    expect(registered).toBeTruthy();
    await registered![1]();
    expect(writeDone).toHaveBeenCalledTimes(1);
    onSpy.mockRestore();
  });

  it("does NOT warn about pi-intercom when ctx.tools.intercom.send is present", () => {
    baseEnv();
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    const notify = vi.fn();
    const ctx = {
      sessionId: "ses_ic",
      ui: { notify },
      tools: { intercom: { send: vi.fn(async () => undefined) } },
    };
    curatorRuntimeExtension(makePi() as any, ctx as any);
    const icWarn = notify.mock.calls.find(
      (c) => typeof c[0] === "string" && /pi-intercom not found/.test(c[0]),
    );
    expect(icWarn).toBeUndefined();
    onSpy.mockRestore();
  });

  it("warns about pi-intercom fallback when ctx.intercom lacks a send function", () => {
    baseEnv();
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    const notify = vi.fn();
    const ctx = {
      sessionId: "ses_ic2",
      ui: { notify },
      intercom: {}, // object present but no send()
    };
    curatorRuntimeExtension(makePi() as any, ctx as any);
    const icWarn = notify.mock.calls.find(
      (c) => typeof c[0] === "string" && /pi-intercom not found/.test(c[0]),
    );
    expect(icWarn).toBeTruthy();
    expect(icWarn![1]).toBe("warn");
    onSpy.mockRestore();
  });

  it("notifies 'identity env not set' and does not register the tool when env is absent", () => {
    clearCuratorEnv();
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    const notify = vi.fn();
    const pi = makePi();
    curatorRuntimeExtension(pi as any, {
      sessionId: "ses_noid",
      ui: { notify },
    } as any);
    const idNotify = notify.mock.calls.find(
      (c) => typeof c[0] === "string" && /identity env not set/.test(c[0]),
    );
    expect(idNotify).toBeTruthy();
    expect(idNotify![1]).toBe("info");
    expect(pi.registerTool).not.toHaveBeenCalled();
    onSpy.mockRestore();
  });

  it("never throws when ctx is undefined and identity env is set (OptionalChaining safety)", () => {
    baseEnv();
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    expect(() => curatorRuntimeExtension(makePi() as any, undefined)).not.toThrow();
    // Heartbeat still starts using the ctx.sessionId ?? ctx.session.id fallback.
    expect(startHeartbeat).toHaveBeenCalledTimes(1);
    const opts = (startHeartbeat as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(opts.curatorSessionId).toBeUndefined();
    onSpy.mockRestore();
  });

  it("never throws when ctx is undefined and the main-side flag is set (warn path safety)", () => {
    baseEnv();
    process.env[MAIN_EXTENSION_LOADED_FLAG] = "1";
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    expect(() => curatorRuntimeExtension(makePi() as any, undefined)).not.toThrow();
    onSpy.mockRestore();
  });

  it("surfaces a setup failure via UI error notify when registerTool throws", () => {
    baseEnv();
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    const notify = vi.fn();
    const pi = { registerTool: vi.fn(() => { throw new Error("nope"); }) };
    curatorRuntimeExtension(pi as any, { sessionId: "ses_t", ui: { notify } } as any);
    const errNotify = notify.mock.calls.find(
      (c) => typeof c[0] === "string" && /setup failed/.test(c[0]),
    );
    expect(errNotify).toBeTruthy();
    expect(errNotify![0]).toContain("nope");
    expect(errNotify![1]).toBe("error");
    onSpy.mockRestore();
  });
});

describe("curatorRuntimeExtension — signal_main tool fallback execution", () => {
  let tmpHome: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "curator-rt-home-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    setCuratorEnv({});
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.env = { ...REAL_ENV };
    vi.restoreAllMocks();
  });

  it("writes a fallback findings file when the intercom client rejects (REQ-SG-08)", async () => {
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    const pi = makePi();
    // ctx has NO intercom → tool uses the reject-fallback client.
    curatorRuntimeExtension(pi as any, makeCtx("ses_fb") as any);

    expect(pi.registerTool).toHaveBeenCalledTimes(1);
    const tool = pi.registerTool.mock.calls[0][0];
    const result = await tool.execute({ kind: "steer", message: "watch budget" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.via).toBe("fallback-file");
      expect(fs.existsSync(result.path)).toBe(true);
      // The fallback path lands under <tmpHome>/.pi-curator/findings/main-abc/.
      expect(result.path).toContain(path.join("findings", "main-abc"));
    }
    onSpy.mockRestore();
  });
});

// ─── Mutation survivor remediation (targeted kills) ─────────────────────────
//
// These tests target specific Survived mutants. The notify OptionalChaining
// mutants require a DEFICIENT ctx (no `ui`, or `ui` without `notify`) so the
// short-circuit differs from the mutated eager access.

describe("isMainExtensionLoaded — heuristic surface (mutation survivors)", () => {
  beforeEach(() => {
    delete process.env[MAIN_EXTENSION_LOADED_FLAG];
  });
  afterEach(() => {
    delete process.env[MAIN_EXTENSION_LOADED_FLAG];
  });

  // L95 OptionalChaining (`(ctx as any)?.extensions` → `(ctx as any).extensions`):
  // when ctx is nullish but pi.extensions matches, the function MUST still
  // return true (via the pi surface). Under the mutant the null ctx throws
  // inside the try and the whole heuristic returns false.
  it("returns true via pi.extensions even when ctx is null", () => {
    expect(isMainExtensionLoaded({ extensions: ["curator-main"] } as any, null)).toBe(true);
    expect(isMainExtensionLoaded({ extensions: ["pi-curator"] } as any, undefined)).toBe(true);
  });

  // L96 MethodExpression `.some`→`.every`: a MIXED ctx.extensions array
  // (one matching + one non-matching) must still be detected.
  it("detects a curator entry in a mixed ctx.extensions array", () => {
    expect(
      isMainExtensionLoaded({}, { extensions: ["pi-curator", "unrelated"] }),
    ).toBe(true);
  });

  // L96 ConditionalExpression `true` (the some predicate → true): a
  // ctx.extensions array with NO curator match must NOT be reported as loaded.
  it("returns false for a ctx.extensions array with no curator match", () => {
    expect(isMainExtensionLoaded({}, { extensions: ["unrelated", "other"] })).toBe(false);
  });

  // L100 MethodExpression `.some`→`.every` + L100 ConditionalExpression `true`:
  // symmetric coverage for the pi.extensions surface.
  it("detects a curator entry in a mixed pi.extensions array", () => {
    expect(
      isMainExtensionLoaded({ extensions: ["curator-main", "x"] } as any, {}),
    ).toBe(true);
  });

  it("returns false for a pi.extensions array with no curator match", () => {
    expect(isMainExtensionLoaded({ extensions: ["x", "y"] } as any, {})).toBe(false);
  });

  // L96 / L100 ConditionalExpression survivors: the `.some` predicate
  // `typeof e === "string" && /pi-curator|curator-main/i.test(e)` — a mutant
  // that drops the `typeof e === "string"` guard would let a NON-STRING entry
  // whose toString() matches the regex be reported as a curator extension. A
  // non-string entry that stringifies to a curator name MUST be rejected.
  it("rejects a non-string ctx.extensions entry even if it stringifies to curator", () => {
    const sneaky = { toString: () => "curator-main" };
    expect(isMainExtensionLoaded({}, { extensions: [sneaky] })).toBe(false);
  });

  it("rejects a non-string pi.extensions entry even if it stringifies to curator", () => {
    const sneaky = { toString: () => "pi-curator" };
    expect(isMainExtensionLoaded({ extensions: [sneaky] } as any, {})).toBe(false);
  });
});

describe("curatorRuntimeExtension — intercom client wiring (mutation survivors L147/L201)", () => {
  let tmpHome: string;
  beforeEach(() => {
    vi.clearAllMocks();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "curator-rt-ic-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    setCuratorEnv({});
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.env = { ...REAL_ENV };
    vi.restoreAllMocks();
  });

  // L147 ObjectLiteral `{}` (returns {} instead of {send}), L147 ArrowFunction
  // (`(p)=>undefined`, intercom.send never called), L201 LogicalOperator
  // (`??`→`&&`, a truthy real client is replaced by the reject object):
  // when a REAL intercom client is present, execute() MUST succeed via
  // intercom and MUST actually call intercom.send.
  it("routes execute through the real intercom client (via=intercom)", async () => {
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    const pi = makePi();
    const intercomSend = vi.fn(async () => undefined);
    curatorRuntimeExtension(pi as any, {
      sessionId: "ses_ic_real",
      ui: { notify: vi.fn() },
      tools: { intercom: { send: intercomSend } },
    } as any);
    const tool = pi.registerTool.mock.calls[0][0];
    const res = await tool.execute({ kind: "steer", message: "hi" });
    expect(res).toEqual({ ok: true, via: "intercom" });
    expect(intercomSend).toHaveBeenCalledTimes(1);
    onSpy.mockRestore();
  });
});

describe("curatorRuntimeExtension — REQ-CR-06 warn path safety (mutation survivor L168)", () => {
  afterEach(() => {
    process.env = { ...REAL_ENV };
    vi.restoreAllMocks();
  });

  // L168 OptionalChaining — the warn notify sits OUTSIDE the try/catch, so a
  // mutated eager access would throw out of the extension. With the main-side
  // flag set and a deficient ctx, the extension MUST NOT throw.
  it("does not throw on the warn path when ctx has no ui (flag set)", () => {
    process.env[MAIN_EXTENSION_LOADED_FLAG] = "1";
    setCuratorEnv({});
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    expect(() => curatorRuntimeExtension(makePi() as any, {} as any)).not.toThrow();
    onSpy.mockRestore();
  });

  it("does not throw on the warn path when ctx.ui lacks notify (flag set)", () => {
    process.env[MAIN_EXTENSION_LOADED_FLAG] = "1";
    setCuratorEnv({});
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    expect(() =>
      curatorRuntimeExtension(makePi() as any, { ui: {} } as any),
    ).not.toThrow();
    onSpy.mockRestore();
  });
});

describe("curatorRuntimeExtension — deficient ctx still wires the tool+heartbeat (L190/L210)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setCuratorEnv({});
  });
  afterEach(() => {
    process.env = { ...REAL_ENV };
    vi.restoreAllMocks();
  });

  // L190 (no-intercom warn) + L210 (signal_main registered warn): when ctx
  // has no `ui`, the optional-chained notifies MUST short-circuit and the
  // extension MUST still register the tool AND start the heartbeat.
  it("registers the tool and starts the heartbeat even when ctx has no ui", () => {
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    const pi = makePi();
    curatorRuntimeExtension(pi as any, {} as any);
    expect(pi.registerTool).toHaveBeenCalledTimes(1);
    expect(startHeartbeat).toHaveBeenCalledTimes(1);
    onSpy.mockRestore();
  });

  it("registers the tool and starts the heartbeat even when ctx.ui lacks notify", () => {
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    const pi = makePi();
    curatorRuntimeExtension(pi as any, { ui: {} } as any);
    expect(pi.registerTool).toHaveBeenCalledTimes(1);
    expect(startHeartbeat).toHaveBeenCalledTimes(1);
    onSpy.mockRestore();
  });
});

describe("curatorRuntimeExtension — heartbeat onError hook safety (mutation survivor L237)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setCuratorEnv({});
  });
  afterEach(() => {
    process.env = { ...REAL_ENV };
    vi.restoreAllMocks();
  });

  // L237 OptionalChaining inside the onError closure: the closure MUST NOT
  // throw when ctx is deficient (no ui / ui without notify / ctx undefined).
  it("onError does not throw when ctx has no ui", () => {
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    curatorRuntimeExtension(makePi() as any, {} as any);
    const opts = (startHeartbeat as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(() => opts.onError(new Error("e1"))).not.toThrow();
    onSpy.mockRestore();
  });

  it("onError does not throw when ctx.ui lacks notify", () => {
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    curatorRuntimeExtension(makePi() as any, { ui: {} } as any);
    const opts = (startHeartbeat as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(() => opts.onError(new Error("e2"))).not.toThrow();
    onSpy.mockRestore();
  });

  it("onError does not throw when ctx is undefined", () => {
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    curatorRuntimeExtension(makePi() as any, undefined);
    const opts = (startHeartbeat as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(() => opts.onError(new Error("e3"))).not.toThrow();
    onSpy.mockRestore();
  });
});

describe("curatorRuntimeExtension — registerTool optional + sessionId fallback (L209/L231)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setCuratorEnv({});
  });
  afterEach(() => {
    process.env = { ...REAL_ENV };
    vi.restoreAllMocks();
  });

  // L209 OptionalChaining (`pi.registerTool?.(tool)` → `pi.registerTool(tool)`):
  // when pi has NO registerTool method, the extension MUST still not throw and
  // MUST still start the heartbeat.
  it("does not throw and starts the heartbeat when pi lacks registerTool", () => {
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    curatorRuntimeExtension({} as any, makeCtx("ses_nort") as any);
    expect(startHeartbeat).toHaveBeenCalledTimes(1);
    onSpy.mockRestore();
  });

  // L231 OptionalChaining (`ctx?.session?.id` → `ctx?.session.id`): when ctx
  // has NEITHER sessionId NOR session, the curatorSessionId MUST resolve to
  // undefined (not throw) and the heartbeat MUST still start.
  it("starts the heartbeat with undefined curatorSessionId when ctx has no session", () => {
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    curatorRuntimeExtension(makePi() as any, { ui: { notify: vi.fn() }, tools: {} } as any);
    expect(startHeartbeat).toHaveBeenCalledTimes(1);
    const opts = (startHeartbeat as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(opts.curatorSessionId).toBeUndefined();
    onSpy.mockRestore();
  });
});

// ─── FINAL mutation survivor round — precise notify OptionalChaining kills ───
// The notify lines (`ctx?.ui?.notify?.(...)`) have THREE `?.` operators each.
// Killing all three per line requires TWO deficient-ctx shapes:
//   (a) ctx = { ui: {} }        → ui present, notify undefined (kills the
//                                `notify?.(` → `notify(` and `ui?.notify` →
//                                `ui.notify` mutants: calling undefined throws).
//   (b) ctx = undefined | null  → kills the `ctx?.ui` → `ctx.ui` mutant
//                                (reading `.ui` of nullish throws).
// Each pair below covers both shapes on the relevant code path.

describe("curatorRuntimeExtension — identity-absent notify OptionalChaining (L178)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCuratorEnv();
  });
  afterEach(() => {
    process.env = { ...REAL_ENV };
    vi.restoreAllMocks();
  });

  it("does not throw on the identity-absent notify when ctx.ui lacks notify", () => {
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    const pi = makePi();
    expect(() => curatorRuntimeExtension(pi as any, { ui: {} } as any)).not.toThrow();
    expect(pi.registerTool).not.toHaveBeenCalled();
    onSpy.mockRestore();
  });

  it("does not throw on the identity-absent notify when ctx is undefined", () => {
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    const pi = makePi();
    expect(() => curatorRuntimeExtension(pi as any, undefined)).not.toThrow();
    expect(pi.registerTool).not.toHaveBeenCalled();
    onSpy.mockRestore();
  });

  it("does not throw on the identity-absent notify when ctx is null", () => {
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    const pi = makePi();
    expect(() => curatorRuntimeExtension(pi as any, null as any)).not.toThrow();
    onSpy.mockRestore();
  });
});

describe("curatorRuntimeExtension — heartbeat-started notify OptionalChaining (L252)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setCuratorEnv({});
  });
  afterEach(() => {
    process.env = { ...REAL_ENV };
    vi.restoreAllMocks();
  });

  it("does not throw on the heartbeat notify when ctx.ui lacks notify", () => {
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    curatorRuntimeExtension(makePi() as any, { ui: {} } as any);
    expect(startHeartbeat).toHaveBeenCalledTimes(1);
    onSpy.mockRestore();
  });

  it("does not throw on the heartbeat notify when ctx is undefined", () => {
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    curatorRuntimeExtension(makePi() as any, undefined);
    expect(startHeartbeat).toHaveBeenCalledTimes(1);
    onSpy.mockRestore();
  });

  it("does not throw on the heartbeat notify when ctx is null", () => {
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    curatorRuntimeExtension(makePi() as any, null as any);
    expect(startHeartbeat).toHaveBeenCalledTimes(1);
    onSpy.mockRestore();
  });
});

describe("curatorRuntimeExtension — setup-failed notify OptionalChaining (L262)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setCuratorEnv({});
  });
  afterEach(() => {
    process.env = { ...REAL_ENV };
    vi.restoreAllMocks();
  });

  it("does not throw on the setup-failed notify when ctx.ui lacks notify", () => {
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    const pi = { registerTool: vi.fn(() => { throw new Error("boom"); }) };
    // registerTool throws → outer catch → setup-failed notify path.
    expect(() => curatorRuntimeExtension(pi as any, { ui: {} } as any)).not.toThrow();
    onSpy.mockRestore();
  });

  it("does not throw on the setup-failed notify when ctx is undefined", () => {
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    const pi = { registerTool: vi.fn(() => { throw new Error("boom"); }) };
    expect(() => curatorRuntimeExtension(pi as any, undefined)).not.toThrow();
    onSpy.mockRestore();
  });
});
