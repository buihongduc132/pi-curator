/**
 * index.survivors5.test.ts — mutation survivor kills for src/main/index.ts.
 *
 * Strategy: the bulk of survivors are ObjectLiteral→`{}` on the OTel structured
 * logger attribute objects. These are killed by injecting a mock logger via
 * `deps.logger` and asserting the EXACT attribute keys/values passed to each
 * `log.<level>(msg, attrs)` call. The curatorMainExtension path additionally
 * mocks `createCuratorLogger` so we can assert `persistentAttrs` + the
 * turn-scoped log records (turn_end fired / pi-intercom missing / crash).
 *
 * Killable mutants targeted (see PR report for the full map):
 *   - buildChildEnv: L194 cond→true (empty name), L200 cond→true (no traceId)
 *   - handleTurnEnd default-logger persistentAttrs: L348 obj, L349 ??→&&
 *   - log attribute objects: L372, L389, L393 (??→&&), L397, L413, L422, L425,
 *     L443, L452, L456 (?.→.), L460, L465, L484, L487, L511, L529, L550
 *   - curatorMainExtension: L587 ??→&&, L588 ??→&&, L592 obj + ??→&&, L603 obj,
 *     L614 obj, L633 obj
 *
 * Equivalent / instrumentation-quirk mutants (documented, not targeted):
 *   - L126 `parent===dir` break→false (bounded loop, redundant root re-check)
 *   - L149/L157 safeNotify/safeSetStatus OptionalChaining x6 (try/catch swallow)
 *   - L168 `if(!goalFile)`→false (readFileSync(undefined) throws→catch→"")
 *   - L171 readGoalContents catch→{} (returns null vs undef; buildSpawnArgs
 *     destructures `goalContents = ""` so both collapse to "")
 *   - L194 `length>=0`, L200 `length>=0`/cond (truthy string always length>0)
 *   - L215 `.slice(0,32)` (randomUUID sans hyphens is already 32 chars)
 *   - L285 writeForkFile catch→{} (returns null vs undef; caller `!forkPath`)
 *   - L560 readPidEntries `{checkPid:true}`→{} (classifyLiveness uses
 *     `checkPid !== false` so undefined≡true)
 *   - L638 _ctx crash-notify OptionalChaining x3 (inner try/catch swallows)
 *
 * No process.chdir(); HOME + projectRoot isolated in tmpdirs.
 */
// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const {
  spawnMock,
  createCuratorLoggerMock,
  acquireMock,
  teamActual,
  loggerInstances,
  getCachedConfigMock,
  configActual,
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  createCuratorLoggerMock: vi.fn(),
  acquireMock: vi.fn(),
  teamActual: {} as any,
  loggerInstances: [] as any[],
  getCachedConfigMock: vi.fn(),
  configActual: {} as any,
}));

function makeMockLogger(): any {
  const log: any = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  log.child = vi.fn(() => log);
  return log;
}

vi.mock("../util/logger.js", () => ({
  createCuratorLogger: (opts: any) => {
    const log = makeMockLogger();
    log.__opts = opts;
    loggerInstances.push(log);
    createCuratorLoggerMock(opts);
    return log;
  },
}));

vi.mock("../util/team-attach-claim.js", async (importActual) => {
  const actual: any = await importActual();
  Object.assign(teamActual, actual);
  return { ...actual, acquireCuratorClaim: acquireMock };
});

vi.mock("../util/config.js", async (importActual) => {
  const actual: any = await importActual();
  Object.assign(configActual, actual);
  return { ...actual, getCachedConfig: getCachedConfigMock };
});

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import curatorMainExtensionDefault, {
  handleTurnEnd,
  buildChildEnv,
  __setIntercomResolverForTest,
  MAIN_EXTENSION_LOADED_FLAG,
} from "./index.js";
import { clearConfigCache } from "../util/config.js";
import { curatorClaimFile, defaultPidRoot } from "../util/team-attach-claim.js";

const REAL_ENV = { ...process.env };

// ─── fixtures ────────────────────────────────────────────────────────────────

const HEADER = (id = "ses-main") =>
  JSON.stringify({ type: "session", version: 1, id, cwd: "/tmp" });
const MSG = (id: string, parentId: string | null, role: string, content: unknown[]) =>
  JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00Z",
    message: { role, content },
  });
const TEXT = (t: string) => ({ type: "text", text: t });

function writeProjectConfig(projectRoot: string, overrides: Record<string, unknown> = {}) {
  fs.mkdirSync(path.join(projectRoot, ".pi-curator"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, ".pi-curator", "curators.json"),
    JSON.stringify(
      {
        curators: {
          spec: {
            alias: "spec",
            enabled: true,
            goalFile: path.join(projectRoot, "goals", "spec.md"),
            spawn: { everyTurns: 1 },
            model: "qwen3-coder",
            ...overrides,
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}
function writeGoal(goalFile: string, content = "goal.") {
  fs.mkdirSync(path.dirname(goalFile), { recursive: true });
  fs.writeFileSync(goalFile, content, "utf8");
}
function writeSession(sessionPath: string) {
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(
    sessionPath,
    [HEADER("ses-x"), MSG("e1", "ses-x", "user", [TEXT("hi")])].join("\n"),
    "utf8",
  );
}

beforeEach(() => {
  spawnMock.mockReset();
  createCuratorLoggerMock.mockReset();
  acquireMock.mockReset();
  acquireMock.mockImplementation((...a: any[]) => teamActual.acquireCuratorClaim(...a));
  getCachedConfigMock.mockReset();
  getCachedConfigMock.mockImplementation((...a: any[]) => configActual.getCachedConfig(...a));
  loggerInstances.length = 0;
});
afterEach(() => {
  process.env = { ...REAL_ENV };
  clearConfigCache();
  __setIntercomResolverForTest(undefined);
  vi.restoreAllMocks();
});

// ─── buildChildEnv edges ─────────────────────────────────────────────────────

describe("buildChildEnv — empty mainSessionName (L194)", () => {
  it("falls back to mainSessionId when mainSessionName is empty (kills cond→true)", () => {
    // Mutant `? true :` always uses mainSessionName; with "" the env would be
    // empty instead of the mainSessionId fallback.
    const env = buildChildEnv("spec", "ses-id", "", 1_700_000_000_000, {}, undefined);
    expect(env.PI_CURATOR_MAIN_NAME).toBe("ses-id");
  });

  it("uses mainSessionName when provided non-empty", () => {
    const env = buildChildEnv("spec", "ses-id", "myname", 1_700_000_000_000, {}, undefined);
    expect(env.PI_CURATOR_MAIN_NAME).toBe("myname");
  });
});

describe("buildChildEnv — undefined traceId (L200)", () => {
  it("does NOT set PI_CURATOR_TRACE_ID when traceId is undefined (kills cond→true)", () => {
    // Mutant `if (true)` would assign env.PI_CURATOR_TRACE_ID = undefined,
    // creating an own property. Original omits the key entirely.
    const env = buildChildEnv("spec", "ses-id", "n", 1_700_000_000_000, {}, undefined);
    expect(Object.prototype.hasOwnProperty.call(env, "PI_CURATOR_TRACE_ID")).toBe(false);
  });

  it("sets PI_CURATOR_TRACE_ID when traceId provided", () => {
    const env = buildChildEnv("spec", "ses-id", "n", 1_700_000_000_000, {}, "abc123");
    expect(env.PI_CURATOR_TRACE_ID).toBe("abc123");
  });
});

// ─── handleTurnEnd default-logger persistentAttrs (L348/L349) ───────────────

describe("handleTurnEnd — default logger persistentAttrs (L348/L349)", () => {
  let projectRoot: string;
  let homeDir: string;
  let sessionPath: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "idx-pa-proj-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "idx-pa-home-"));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    sessionPath = path.join(projectRoot, "session.jsonl");
    writeProjectConfig(projectRoot, { spawn: { everyTurns: 99 } }); // gate closed
    writeGoal(path.join(projectRoot, "goals", "spec.md"));
    writeSession(sessionPath);
    clearConfigCache();
  });
  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("creates default logger with BOTH persistentAttrs keys (kills L348 obj→{})", async () => {
    // No deps.logger → default createCuratorLogger branch. Mutant {} would
    // drop both session.name + config.projectRoot.
    await handleTurnEnd({}, {}, {
      projectRoot,
      mainSessionId: "ses-pa",
      mainSessionName: "sessionName1",
      sessionJsonlPath: sessionPath,
      forksDir: path.join(homeDir, "forks"),
      pidRoot: path.join(homeDir, "pids"),
      runtimeExtensionPath: "/fake/rt.ts",
      intercomExtensionPath: "/fake/ic.ts",
      turnNumber: 1,
    });
    expect(loggerInstances.length).toBeGreaterThan(0);
    const opts = loggerInstances[loggerInstances.length - 1].__opts;
    expect(opts.persistentAttrs["session.name"]).toBe("sessionName1");
    expect(opts.persistentAttrs["config.projectRoot"]).toBe(projectRoot);
  });

  it("persistentAttrs session.name falls back to mainSessionId when name undefined (kills L349 ??→&&)", async () => {
    // Mutant `mainSessionName && mainSessionId` with undefined name → undefined
    // (not mainSessionId). Original ?? → mainSessionId.
    await handleTurnEnd({}, {}, {
      projectRoot,
      mainSessionId: "ses-pa2",
      mainSessionName: undefined,
      sessionJsonlPath: sessionPath,
      forksDir: path.join(homeDir, "forks"),
      pidRoot: path.join(homeDir, "pids"),
      runtimeExtensionPath: "/fake/rt.ts",
      intercomExtensionPath: "/fake/ic.ts",
      turnNumber: 1,
    });
    const opts = loggerInstances[loggerInstances.length - 1].__opts;
    expect(opts.persistentAttrs["session.name"]).toBe("ses-pa2");
  });
});

// ─── handleTurnEnd injected-logger attribute objects ────────────────────────

function findCall(mock: any, msg: string): any[] | undefined {
  return mock.mock.calls.find((c: any[]) => c[0] === msg);
}

describe("handleTurnEnd — log attribute objects (config/gate/fork/claim/argv/spawn)", () => {
  let projectRoot: string;
  let homeDir: string;
  let sessionPath: string;
  let log: any;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "idx-attr-proj-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "idx-attr-home-"));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    sessionPath = path.join(projectRoot, "session.jsonl");
    writeProjectConfig(projectRoot);
    writeGoal(path.join(projectRoot, "goals", "spec.md"));
    writeSession(sessionPath);
    clearConfigCache();
    log = makeMockLogger();
  });
  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("happy path: emits structured attrs for gate/fork/claim/argv/seed (L397/L425/L460/L465/L484/L529)", async () => {
    spawnMock.mockImplementation(() => ({ pid: 4242, on: vi.fn() }));
    await handleTurnEnd({}, {}, {
      projectRoot,
      mainSessionId: "ses-h",
      mainSessionName: "happy",
      sessionJsonlPath: sessionPath,
      forksDir: path.join(homeDir, "forks"),
      pidRoot: path.join(homeDir, "pids"),
      runtimeExtensionPath: "/fake/rt.ts",
      intercomExtensionPath: "/fake/ic.ts",
      turnNumber: 1,
      logger: log,
    });

    const gateOpen = findCall(log.info, "gate open");
    expect(gateOpen).toBeTruthy();
    expect(gateOpen[1]).toMatchObject({ "persona.alias": "spec", turn: 1 });
    expect(gateOpen[1]).toHaveProperty("turnsSince");
    expect(gateOpen[1]).toHaveProperty("minsSince");

    const forkWritten = findCall(log.info, "fork written");
    expect(forkWritten).toBeTruthy();
    expect(forkWritten[1]).toMatchObject({ "persona.alias": "spec" });
    expect(forkWritten[1]).toHaveProperty("inputBytes");
    expect(typeof forkWritten[1].inputBytes).toBe("number");
    expect(forkWritten[1]).toHaveProperty("forkPath");

    const acquired = findCall(log.info, "claim acquired");
    expect(acquired).toBeTruthy();
    expect(acquired[1]).toHaveProperty("persona.alias", "spec");
    expect(acquired[1]).toHaveProperty("claimPath");

    const trace = findCall(log.info, "trace started");
    expect(trace).toBeTruthy();
    expect(trace[1]).toHaveProperty("traceId");
    expect(typeof trace[1].traceId).toBe("string");

    const argvBuilt = findCall(log.info, "argv built");
    expect(argvBuilt).toBeTruthy();
    expect(argvBuilt[1]).toHaveProperty("argvLen");
    expect(typeof argvBuilt[1].argvLen).toBe("number");

    const seeded = findCall(log.info, "claim pid seeded");
    expect(seeded).toBeTruthy();
    expect(seeded[1]).toMatchObject({ childPid: 4242 });
    expect(seeded[1]).toHaveProperty("claimPath");
  });

  it("gate closed: debug attrs include the real gate reason (kills L389 obj + L393 ??→&&)", async () => {
    // A recent spawn (turn 1) with everyTurns:99 → turnsSince=0 < 99 → closed.
    // evaluateSpawnGate always returns a truthy reason string, so
    // `gate.reason ?? "closed"` yields the reason. Mutant `gate.reason &&
    // "closed"` collapses it to "closed".
    writeProjectConfig(projectRoot, { spawn: { everyTurns: 99 } });
    clearConfigCache();
    await handleTurnEnd({}, {}, {
      projectRoot,
      mainSessionId: "ses-gc",
      sessionJsonlPath: sessionPath,
      forksDir: path.join(homeDir, "forks"),
      pidRoot: path.join(homeDir, "pids"),
      runtimeExtensionPath: "/fake/rt.ts",
      intercomExtensionPath: "/fake/ic.ts",
      turnNumber: 1,
      lastSpawn: { spec: { turn: 1, atMs: Date.now() } },
      logger: log,
    });
    const closed = findCall(log.debug, "gate closed");
    expect(closed).toBeTruthy();
    expect(closed[1]).toMatchObject({ "persona.alias": "spec", turnsSince: expect.any(Number), minsSince: expect.any(Number) });
    // The real reason is a descriptive string, NOT the literal "closed".
    expect(closed[1].reason).not.toBe("closed");
    expect(String(closed[1].reason)).toContain("spec");
  });

  it("config load failure: error attrs (kills L372 obj)", async () => {
    // getCachedConfig never throws in practice (REQ-CF-09); force it via mock.
    getCachedConfigMock.mockImplementation(() => {
      throw new Error("config boom");
    });
    await handleTurnEnd({}, {}, {
      projectRoot,
      mainSessionId: "ses-cf",
      sessionJsonlPath: sessionPath,
      forksDir: path.join(homeDir, "forks"),
      pidRoot: path.join(homeDir, "pids"),
      runtimeExtensionPath: "/fake/rt.ts",
      intercomExtensionPath: "/fake/ic.ts",
      turnNumber: 1,
      logger: log,
    });
    const err = findCall(log.error, "config load failed");
    expect(err).toBeTruthy();
    expect(err[1]).toMatchObject({ "persona.alias": "*" });
    expect(typeof err[1].error).toBe("string");
  });

  it("session jsonl read failure: error attrs (kills L413 obj)", async () => {
    await handleTurnEnd({}, {}, {
      projectRoot,
      mainSessionId: "ses-sj",
      sessionJsonlPath: path.join(projectRoot, "does-not-exist.jsonl"),
      forksDir: path.join(homeDir, "forks"),
      pidRoot: path.join(homeDir, "pids"),
      runtimeExtensionPath: "/fake/rt.ts",
      intercomExtensionPath: "/fake/ic.ts",
      turnNumber: 1,
      logger: log,
    });
    const err = findCall(log.error, "session jsonl read failed");
    expect(err).toBeTruthy();
    expect(err[1]).toMatchObject({ "persona.alias": "spec" });
    expect(err[1]).toHaveProperty("path");
  });

  it("claim acquire throws: error attrs (kills L443 obj)", async () => {
    spawnMock.mockImplementation(() => ({ pid: 99, on: vi.fn() }));
    acquireMock.mockImplementation(async () => {
      throw new Error("acquire boom");
    });
    await handleTurnEnd({}, {}, {
      projectRoot,
      mainSessionId: "ses-at",
      sessionJsonlPath: sessionPath,
      forksDir: path.join(homeDir, "forks"),
      pidRoot: path.join(homeDir, "pids"),
      runtimeExtensionPath: "/fake/rt.ts",
      intercomExtensionPath: "/fake/ic.ts",
      turnNumber: 1,
      logger: log,
    });
    const err = findCall(log.error, "claim acquire threw");
    expect(err).toBeTruthy();
    expect(err[1]).toMatchObject({ "persona.alias": "spec" });
    expect(err[1]).toHaveProperty("claimPath");
    expect(err[1]).toHaveProperty("error", "acquire boom");
  });

  it("claim slot held with a claim: warn attrs include heldPid (kills L452 obj + L456 ?.→.)", async () => {
    // Pre-write a fresh claim with a live pid so acquire returns ok:false with
    // a populated claim. heldPid = acquireResult.claim?.pid must be the number.
    const pidRoot = path.join(homeDir, "pids");
    const claimPath = curatorClaimFile(pidRoot, "ses-sh", "spec");
    await teamActual.writeCuratorClaim(claimPath, {
      pid: process.pid,
      mainSessionId: "ses-sh",
      curator: "spec",
      spawnedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      phase: "scanning",
    });
    await handleTurnEnd({}, {}, {
      projectRoot,
      mainSessionId: "ses-sh",
      sessionJsonlPath: sessionPath,
      forksDir: path.join(homeDir, "forks"),
      pidRoot,
      runtimeExtensionPath: "/fake/rt.ts",
      intercomExtensionPath: "/fake/ic.ts",
      turnNumber: 1,
      logger: log,
    });
    const held = findCall(log.warn, "claim slot held");
    expect(held).toBeTruthy();
    expect(held[1]).toMatchObject({ "persona.alias": "spec" });
    expect(held[1]).toHaveProperty("claimPath");
    expect(held[1]).toHaveProperty("reason");
    expect(held[1].heldPid).toBe(process.pid);
  });

  it("claim slot held WITHOUT a claim: does NOT crash; warn attrs heldPid undefined (kills L456 ?.→.)", async () => {
    // acquireCuratorClaim always returns claim when ok:false, so to exercise
    // `claim?.pid` vs `claim.pid` we force ok:false with no claim via the mock.
    acquireMock.mockResolvedValue({ ok: false, reason: "claimed_by_other" });
    await handleTurnEnd({}, {}, {
      projectRoot,
      mainSessionId: "ses-nc",
      sessionJsonlPath: sessionPath,
      forksDir: path.join(homeDir, "forks"),
      pidRoot: path.join(homeDir, "pids"),
      runtimeExtensionPath: "/fake/rt.ts",
      intercomExtensionPath: "/fake/ic.ts",
      turnNumber: 1,
      logger: log,
    });
    // Mutant `acquireResult.claim.pid` would throw TypeError (uncaught by the
    // local try) → propagate → no warn call. Original calls warn with heldPid undefined.
    const held = findCall(log.warn, "claim slot held");
    expect(held).toBeTruthy();
    expect(held[1].heldPid).toBeUndefined();
  });

  it("argv build failure: error attrs (kills L487 obj)", async () => {
    // Empty runtimeExtensionPath makes buildSpawnArgs throw.
    spawnMock.mockImplementation(() => ({ pid: 1, on: vi.fn() }));
    await handleTurnEnd({}, {}, {
      projectRoot,
      mainSessionId: "ses-ab",
      sessionJsonlPath: sessionPath,
      forksDir: path.join(homeDir, "forks"),
      pidRoot: path.join(homeDir, "pids"),
      runtimeExtensionPath: "",
      intercomExtensionPath: "/fake/ic.ts",
      turnNumber: 1,
      logger: log,
    });
    const err = findCall(log.error, "argv build failed");
    expect(err).toBeTruthy();
    expect(err[1]).toMatchObject({ "persona.alias": "spec" });
    expect(typeof err[1].error).toBe("string");
  });

  it("spawn failure: error attrs (kills L511 obj)", async () => {
    spawnMock.mockImplementation(() => {
      throw new Error("spawn boom");
    });
    await handleTurnEnd({}, {}, {
      projectRoot,
      mainSessionId: "ses-sf",
      sessionJsonlPath: sessionPath,
      forksDir: path.join(homeDir, "forks"),
      pidRoot: path.join(homeDir, "pids"),
      runtimeExtensionPath: "/fake/rt.ts",
      intercomExtensionPath: "/fake/ic.ts",
      turnNumber: 1,
      logger: log,
    });
    const err = findCall(log.error, "spawn failed");
    expect(err).toBeTruthy();
    expect(err[1]).toMatchObject({ "persona.alias": "spec" });
    expect(err[1]).toHaveProperty("error", "spawn boom");
  });

  it("child 'error' event: error attrs (kills L550 obj)", async () => {
    let onHandlers: Record<string, Function> = {};
    spawnMock.mockImplementation(() => ({
      pid: 7777,
      on: vi.fn((evt: string, cb: Function) => {
        onHandlers[evt] = cb;
      }),
    }));
    await handleTurnEnd({}, {}, {
      projectRoot,
      mainSessionId: "ses-ce",
      sessionJsonlPath: sessionPath,
      forksDir: path.join(homeDir, "forks"),
      pidRoot: path.join(homeDir, "pids"),
      runtimeExtensionPath: "/fake/rt.ts",
      intercomExtensionPath: "/fake/ic.ts",
      turnNumber: 1,
      logger: log,
    });
    expect(onHandlers.error).toBeTruthy();
    onHandlers.error(new Error("child died"));
    const err = findCall(log.error, "child process error");
    expect(err).toBeTruthy();
    expect(err[1]).toMatchObject({ "persona.alias": "spec", error: "child died" });
  });
});

// ─── curatorMainExtension — outer logger + ctx fallback chains ──────────────

describe("curatorMainExtension — turn-scoped logger records (L603/L614/L633)", () => {
  let projectRoot: string;
  let homeDir: string;
  let sessionPath: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "idx-me-proj-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "idx-me-home-"));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    delete process.env.PI_INTERCOM_EXTENSION_PATH;
    sessionPath = path.join(projectRoot, "session.jsonl");
    writeProjectConfig(projectRoot);
    writeGoal(path.join(projectRoot, "goals", "spec.md"));
    writeSession(sessionPath);
    clearConfigCache();
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => ({ pid: 555, on: vi.fn() }));
  });
  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  function captureHandler(ctx?: any) {
    const holder: { fn?: Function } = {};
    const pi = {
      on: vi.fn((evt: string, fn: Function) => {
        if (evt === "turn_end") holder.fn = fn;
      }),
    };
    curatorMainExtensionDefault(pi as any, ctx);
    return holder;
  }

  it("fires 'turn_end fired' with turn + cwd attrs (kills L603 obj)", async () => {
    process.env.PI_INTERCOM_EXTENSION_PATH = "/fake/ic.ts";
    const holder = captureHandler({ ui: { notify: vi.fn() } });
    await holder.fn!(
      {},
      { cwd: projectRoot, sessionId: "ses-me", sessionFile: sessionPath, ui: { notify: vi.fn() } },
    );
    const outerLog = loggerInstances[loggerInstances.length - 1];
    const fired = findCall(outerLog.info, "turn_end fired");
    expect(fired).toBeTruthy();
    expect(fired[1]).toMatchObject({ turn: 1, cwd: projectRoot });
  });

  it("missing intercom path: error attrs include turn (kills L614 obj)", async () => {
    __setIntercomResolverForTest(() => undefined);
    const notify = vi.fn();
    const holder = captureHandler({ ui: { notify } });
    await holder.fn!(
      {},
      { cwd: projectRoot, sessionId: "ses-me2", sessionFile: sessionPath, ui: { notify } },
    );
    const outerLog = loggerInstances[loggerInstances.length - 1];
    const err = findCall(outerLog.error, "pi-intercom extension path not found; curator spawn skipped");
    expect(err).toBeTruthy();
    expect(err[1]).toHaveProperty("turn", 1);
  });

  it("handler crash: error attrs include error + turn (kills L633 obj)", async () => {
    // Force the resolver to throw inside the try block → outer catch logs crash.
    __setIntercomResolverForTest(() => {
      throw new Error("resolver boom");
    });
    const notify = vi.fn();
    const holder = captureHandler({ ui: { notify } });
    await holder.fn!(
      {},
      { cwd: projectRoot, sessionId: "ses-me3", sessionFile: sessionPath, ui: { notify } },
    );
    const outerLog = loggerInstances[loggerInstances.length - 1];
    const crash = findCall(outerLog.error, "turn_end handler crashed");
    expect(crash).toBeTruthy();
    expect(crash[1]).toMatchObject({ error: "resolver boom", turn: 1 });
  });
});

describe("curatorMainExtension — outerLog persistentAttrs + ctx fallbacks (L587/L588/L592)", () => {
  let projectRoot: string;
  let homeDir: string;
  let sessionPath: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "idx-ctx-proj-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "idx-ctx-home-"));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    delete process.env.PI_INTERCOM_EXTENSION_PATH;
    sessionPath = path.join(projectRoot, "session.jsonl");
    writeProjectConfig(projectRoot);
    writeGoal(path.join(projectRoot, "goals", "spec.md"));
    writeSession(sessionPath);
    clearConfigCache();
    process.env.PI_INTERCOM_EXTENSION_PATH = "/fake/ic.ts";
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => ({ pid: 666, on: vi.fn() }));
  });
  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  function captureHandler(ctx?: any) {
    const holder: { fn?: Function } = {};
    const pi = {
      on: vi.fn((evt: string, fn: Function) => {
        if (evt === "turn_end") holder.fn = fn;
      }),
    };
    curatorMainExtensionDefault(pi as any, ctx);
    return holder;
  }

  it("ctx.session.id used when ctx.sessionId absent (kills L587 ??→&& + L592 obj)", async () => {
    // Mutant `ctx?.sessionId && ctx?.session?.id` with sessionId absent would
    // yield undefined (not session.id) → outerLog sessionId falls to pid-...
    const holder = captureHandler({ ui: { notify: vi.fn() } });
    await holder.fn!(
      {},
      {
        cwd: projectRoot,
        session: { id: "from-session-id", name: "from-session-name" },
        sessionFile: sessionPath,
        ui: { notify: vi.fn() },
      },
    );
    const opts = loggerInstances[loggerInstances.length - 1].__opts;
    expect(opts.sessionId).toBe("from-session-id");
    // persistentAttrs session.name must carry the session.name (kills L592 obj
    // + L588 ??→&& + L592 turnSessionName ?? turnSessionId → &&).
    expect(opts.persistentAttrs["session.name"]).toBe("from-session-name");
  });

  it("ctx.session.name used when ctx.sessionName absent (kills L588 ??→&&)", async () => {
    const holder = captureHandler({ ui: { notify: vi.fn() } });
    await holder.fn!(
      {},
      {
        cwd: projectRoot,
        sessionId: "sid-x",
        session: { name: "name-from-session" },
        sessionFile: sessionPath,
        ui: { notify: vi.fn() },
      },
    );
    const opts = loggerInstances[loggerInstances.length - 1].__opts;
    expect(opts.persistentAttrs["session.name"]).toBe("name-from-session");
  });

  it("session.name falls back to sessionId when session name absent (kills L592 ??→&&)", async () => {
    // Mutant `turnSessionName && turnSessionId` with name absent → undefined
    // instead of sessionId.
    const holder = captureHandler({ ui: { notify: vi.fn() } });
    await holder.fn!(
      {},
      { cwd: projectRoot, sessionId: "sid-only", sessionFile: sessionPath, ui: { notify: vi.fn() } },
    );
    const opts = loggerInstances[loggerInstances.length - 1].__opts;
    expect(opts.persistentAttrs["session.name"]).toBe("sid-only");
  });
});
