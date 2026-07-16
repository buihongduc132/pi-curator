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

import curatorRuntimeExtension, { ENV, MAIN_EXTENSION_LOADED_FLAG } from "./index.js";
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
