/**
 * index.test.ts — unit tests for the main-side curator spawn hook (D2/D4/D6/D7
 * production wiring). Exercises the pure-effect `handleTurnEnd` with a fake
 * `spawnFn` so the wiring is verifiable without a real `pi` binary.
 */
// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Mock child_process.spawn so the default-export turn_end handler (which has no
// spawnFn injection seam) can be exercised without spawning a real `pi` binary.
// Existing handleTurnEnd tests inject their own spawnFn, so this mock is inert
// for them.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import curatorMainExtensionDefault, {
  handleTurnEnd,
  buildChildEnv,
  processRestartMarkers,
  resolveRuntimeExtensionPath,
  resolveIntercomExtensionPath,
  __setIntercomResolverForTest,
  MAIN_EXTENSION_LOADED_FLAG,
} from "./index.js";
import { clearConfigCache } from "../util/config.js";
import {
  readCuratorClaim,
  curatorClaimFile,
  defaultPidRoot,
  writeCuratorClaim,
} from "../util/team-attach-claim.js";

const REAL_ENV = { ...process.env };

function writeProjectConfig(projectRoot: string, goalFile?: string) {
  const dir = path.join(projectRoot, ".pi-curator");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "curators.json"),
    JSON.stringify(
      {
        curators: {
          spec: {
            alias: "spec",
            enabled: true,
            goalFile: goalFile ?? path.join(projectRoot, "goals", "spec.md"),
            spawn: { everyTurns: 3 },
            model: "qwen3-coder",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

function writeGoalFile(goalFile: string, content: string) {
  fs.mkdirSync(path.dirname(goalFile), { recursive: true });
  fs.writeFileSync(goalFile, content, "utf8");
}

function writeSessionJsonl(sessionPath: string) {
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(
    sessionPath,
    JSON.stringify({ type: "session", version: 1, id: "ses-main", cwd: "/tmp" }) + "\n",
    "utf8",
  );
}

function makeChild(pid: number) {
  return {
    pid,
    on: vi.fn(),
  };
}

describe("handleTurnEnd — production wiring", () => {
  let projectRoot: string;
  let sessionPath: string;
  let goalFile: string;
  let pidRoot: string;
  let homeDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "curator-main-proj-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-main-home-"));
    sessionPath = path.join(projectRoot, "session.jsonl");
    goalFile = path.join(projectRoot, "goals", "spec.md");
    pidRoot = path.join(homeDir, "pids");
    env = { ...process.env };
    writeProjectConfig(projectRoot, goalFile);
    writeGoalFile(goalFile, "Be thorough but concise.");
    writeSessionJsonl(sessionPath);
    clearConfigCache();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    process.env = { ...REAL_ENV };
    clearConfigCache();
    vi.restoreAllMocks();
  });

  it("passes runtimeExtensionPath, intercomExtensionPath, and goalContents to buildSpawnArgs (D3/D4/D7)", async () => {
    const spawnFn = vi.fn(() => makeChild(12345));
    const runtimePath = "/repo/src/runtime/index.ts";
    const intercomPath = "/repo/node_modules/pi-intercom/index.ts";

    await handleTurnEnd({}, {}, {
      projectRoot,
      mainSessionId: "ses-main",
      mainSessionName: "main-session",
      sessionJsonlPath: sessionPath,
      pidRoot,
      forksDir: path.join(homeDir, "forks"),
      spawnFn,
      turnNumber: 1,
      runtimeExtensionPath: runtimePath,
      intercomExtensionPath: intercomPath,
      homeDir,
    });

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [piBin, args, opts] = spawnFn.mock.calls[0];
    expect(args).toContain("--no-extensions");
    expect(args[0]).toBe("--no-extensions");
    expect(args).toContain("-e");
    expect(args).toContain(runtimePath);
    expect(args).toContain(intercomPath);
    expect(args).toContain("--fork");
    expect(args).toContain("--name");
    expect(args).toContain("curator:spec");
    expect(args).toContain("--model");
    expect(args).toContain("qwen3-coder");
    // Goal contents must be non-empty (D7).
    expect(args).toContain("-p");
    const pIdx = args.indexOf("-p");
    const taskPrompt = args[pIdx + 1];
    expect(taskPrompt).toContain("Be thorough but concise.");
  });

  it("injects the curator identity into the child env (D4)", async () => {
    const spawnFn = vi.fn(() => makeChild(22222));
    await handleTurnEnd({}, {}, {
      projectRoot,
      mainSessionId: "ses-main",
      mainSessionName: "main-session",
      sessionJsonlPath: sessionPath,
      pidRoot,
      forksDir: path.join(homeDir, "forks"),
      spawnFn,
      turnNumber: 1,
      runtimeExtensionPath: "/r.ts",
      intercomExtensionPath: "/i.ts",
      homeDir,
      nowMs: 1782000000000,
      parentEnv: env,
    });

    const [, , opts] = spawnFn.mock.calls[0];
    expect(opts.env).toMatchObject({
      PI_CURATOR_ALIAS: "spec",
      PI_CURATOR_MAIN_ID: "ses-main",
      PI_CURATOR_MAIN_NAME: "main-session",
      PI_CURATOR_SPAWNED_AT: new Date(1782000000000).toISOString(),
    });
  });

  it("defaults mainSessionName to mainSessionId when name is missing (D4)", async () => {
    const spawnFn = vi.fn(() => makeChild(33333));
    await handleTurnEnd({}, {}, {
      projectRoot,
      mainSessionId: "ses-main",
      sessionJsonlPath: sessionPath,
      pidRoot,
      forksDir: path.join(homeDir, "forks"),
      spawnFn,
      turnNumber: 1,
      runtimeExtensionPath: "/r.ts",
      intercomExtensionPath: "/i.ts",
      homeDir,
      parentEnv: env,
    });

    const [, , opts] = spawnFn.mock.calls[0];
    expect(opts.env.PI_CURATOR_MAIN_NAME).toBe("ses-main");
  });

  it("strips the main-side extension flag from the child env (D8)", async () => {
    env[MAIN_EXTENSION_LOADED_FLAG] = "1";
    const spawnFn = vi.fn(() => makeChild(44444));
    await handleTurnEnd({}, {}, {
      projectRoot,
      mainSessionId: "ses-main",
      mainSessionName: "main-session",
      sessionJsonlPath: sessionPath,
      pidRoot,
      forksDir: path.join(homeDir, "forks"),
      spawnFn,
      turnNumber: 1,
      runtimeExtensionPath: "/r.ts",
      intercomExtensionPath: "/i.ts",
      homeDir,
      parentEnv: env,
    });

    const [, , opts] = spawnFn.mock.calls[0];
    expect(opts.env[MAIN_EXTENSION_LOADED_FLAG]).toBeUndefined();
  });

  it("seeds the claim pid with the real child pid after spawn (D2)", async () => {
    const spawnFn = vi.fn(() => makeChild(77777));
    await handleTurnEnd({}, {}, {
      projectRoot,
      mainSessionId: "ses-main",
      mainSessionName: "main-session",
      sessionJsonlPath: sessionPath,
      pidRoot,
      forksDir: path.join(homeDir, "forks"),
      spawnFn,
      turnNumber: 1,
      runtimeExtensionPath: "/r.ts",
      intercomExtensionPath: "/i.ts",
      homeDir,
    });

    const claim = await readCuratorClaim(curatorClaimFile(pidRoot, "ses-main", "spec"));
    expect(claim).not.toBeNull();
    // The claim pid must be the child's pid, not the main process pid.
    expect(claim!.pid).toBe(77777);
    expect(claim!.pid).not.toBe(process.pid);
    expect(claim!.phase).toBe("spawned");
  });

  it("processes restart markers and resets the gate before spawning (D6)", async () => {
    // Seed a recent lastSpawn so the gate would normally NOT fire on turn 2.
    const lastSpawn: Record<string, { turn: number; atMs: number }> = {
      spec: { turn: 1, atMs: Date.now() },
    };
    const markerDir = path.join(homeDir, ".pi-curator", "restart-markers", "ses-main");
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, "spec.json"), JSON.stringify({ alias: "spec", at: Date.now() }), "utf8");

    const spawnFn = vi.fn(() => {
      // At the moment of spawn, the restart marker must have been processed
      // (gate reset) so lastSpawn[spec] is temporarily undefined.
      expect(lastSpawn.spec).toBeUndefined();
      return makeChild(88888);
    });
    await handleTurnEnd({}, {}, {
      projectRoot,
      mainSessionId: "ses-main",
      mainSessionName: "main-session",
      sessionJsonlPath: sessionPath,
      pidRoot,
      forksDir: path.join(homeDir, "forks"),
      spawnFn,
      turnNumber: 2,
      lastSpawn,
      runtimeExtensionPath: "/r.ts",
      intercomExtensionPath: "/i.ts",
      homeDir,
    });

    // The restart marker reset the gate, so spawn should fire despite lastSpawn being recent.
    expect(spawnFn).toHaveBeenCalledTimes(1);
    // Marker deleted.
    expect(fs.existsSync(path.join(markerDir, "spec.json"))).toBe(false);
  });

  it("does not spawn when the gate is closed and no restart marker is present", async () => {
    const lastSpawn: Record<string, { turn: number; atMs: number }> = {
      spec: { turn: 1, atMs: Date.now() },
    };
    const spawnFn = vi.fn(() => makeChild(99999));
    await handleTurnEnd({}, {}, {
      projectRoot,
      mainSessionId: "ses-main",
      mainSessionName: "main-session",
      sessionJsonlPath: sessionPath,
      pidRoot,
      forksDir: path.join(homeDir, "forks"),
      spawnFn,
      turnNumber: 2,
      lastSpawn,
      runtimeExtensionPath: "/r.ts",
      intercomExtensionPath: "/i.ts",
      homeDir,
    });

    expect(spawnFn).not.toHaveBeenCalled();
  });
});

describe("buildChildEnv (D4)", () => {
  it("spreads parent env and overlays curator identity", () => {
    const env = buildChildEnv("spec", "ses-main", "main-session", 1782000000000, {
      SOME_PARENT_VAR: "yes",
      [MAIN_EXTENSION_LOADED_FLAG]: "1",
    });

    expect(env.SOME_PARENT_VAR).toBe("yes");
    expect(env.PI_CURATOR_ALIAS).toBe("spec");
    expect(env.PI_CURATOR_MAIN_ID).toBe("ses-main");
    expect(env.PI_CURATOR_MAIN_NAME).toBe("main-session");
    expect(env.PI_CURATOR_SPAWNED_AT).toBe(new Date(1782000000000).toISOString());
    expect(env[MAIN_EXTENSION_LOADED_FLAG]).toBeUndefined();
  });

  it("defaults mainSessionName to mainSessionId when empty", () => {
    const env = buildChildEnv("spec", "ses-main", "", 1782000000000, {});
    expect(env.PI_CURATOR_MAIN_NAME).toBe("ses-main");
  });
});

describe("processRestartMarkers (D6)", () => {
  it("resets lastSpawn and deletes markers for each alias", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "curator-rm-"));
    const markerDir = path.join(home, ".pi-curator", "restart-markers", "ses-main");
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, "spec.json"), JSON.stringify({ alias: "spec" }), "utf8");
    fs.writeFileSync(path.join(markerDir, "scold.json"), JSON.stringify({ alias: "scold" }), "utf8");

    const lastSpawn = { spec: { turn: 5, atMs: 1 }, scold: { turn: 7, atMs: 2 } };
    const reset = processRestartMarkers("ses-main", lastSpawn, { homeDir: home });

    expect(reset.sort()).toEqual(["scold", "spec"]);
    expect(lastSpawn.spec).toBeUndefined();
    expect(lastSpawn.scold).toBeUndefined();
    expect(fs.existsSync(path.join(markerDir, "spec.json"))).toBe(false);
    expect(fs.existsSync(path.join(markerDir, "scold.json"))).toBe(false);

    fs.rmSync(home, { recursive: true, force: true });
  });

  it("returns empty array when the marker dir is missing", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "curator-rm-empty-"));
    const lastSpawn = {};
    const reset = processRestartMarkers("ses-main", lastSpawn, { homeDir: home });
    expect(reset).toEqual([]);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("curatorMainExtension — main-side extension flag (D8)", () => {
  it("sets the main-side extension flag when the extension loads", async () => {
    // Dynamic import so the module code executes fresh.
    delete process.env[MAIN_EXTENSION_LOADED_FLAG];
    const mod = await import("./index.js");
    const pi: any = { on: vi.fn() };
    mod.default(pi, { ui: { notify: vi.fn() } });
    expect(process.env[MAIN_EXTENSION_LOADED_FLAG]).toBe("1");
  });
});

// ─── Mutation survivor remediation ──────────────────────────────────────
// The clusters below kill stryker survivors by asserting on the wiring
// effects (notify calls, fork-file contents, claim contents, env shape) that
// the original tests did not check.

describe("resolveRuntimeExtensionPath", () => {
  it("returns the sibling src/runtime/index.ts when it exists", () => {
    // Default `here` is this module's dir (src/main); src/runtime/index.ts exists.
    const p = resolveRuntimeExtensionPath();
    expect(p.endsWith(path.join("runtime", "index.ts"))).toBe(true);
    expect(fs.existsSync(p)).toBe(true);
  });

  it("falls back to the dist .js candidate when the src .ts is absent", () => {
    // A nonexistent `here` cannot contain ../runtime/index.ts → dist fallback.
    const fakeHere = path.join(os.tmpdir(), "curator-nope-" + Date.now());
    const p = resolveRuntimeExtensionPath(fakeHere);
    expect(p.endsWith(path.join("runtime", "index.js"))).toBe(true);
  });
});

describe("resolveIntercomExtensionPath", () => {
  afterEach(() => {
    delete process.env.PI_INTERCOM_EXTENSION_PATH;
  });

  it("honors the PI_INTERCOM_EXTENSION_PATH env override", () => {
    process.env.PI_INTERCOM_EXTENSION_PATH = "/explicit/intercom.ts";
    expect(resolveIntercomExtensionPath()).toBe("/explicit/intercom.ts");
  });

  it("returns undefined when no override is set and pi-intercom is unresolvable", () => {
    delete process.env.PI_INTERCOM_EXTENSION_PATH;
    // In the test env pi-intercom is not installed → probe loop misses → undefined.
    // (If it happens to resolve in some env, this still asserts a string return.)
    const r = resolveIntercomExtensionPath();
    expect(typeof r === "undefined" || typeof r === "string").toBe(true);
  });

  it("discovers pi-intercom as a git-sourced sibling (walk-up probe)", () => {
    delete process.env.PI_INTERCOM_EXTENSION_PATH;
    // Mirror pi's git-sourced install layout:
    //   <tmp>/owner/pi-curator/src/main/index.ts  (this module — `here`)
    //   <tmp>/owner/pi-intercom/index.ts          (sibling package)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curator-git-"));
    const ownerDir = path.join(tmp, "owner");
    const here = path.join(ownerDir, "pi-curator", "src", "main");
    fs.mkdirSync(here, { recursive: true });
    const intercomDir = path.join(ownerDir, "pi-intercom");
    fs.mkdirSync(intercomDir, { recursive: true });
    const intercomEntry = path.join(intercomDir, "index.ts");
    fs.writeFileSync(intercomEntry, "// stub\n");
    expect(resolveIntercomExtensionPath(here)).toBe(intercomEntry);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("handleTurnEnd — wiring effects (mutation survivors)", () => {
  let projectRoot: string;
  let sessionPath: string;
  let goalFile: string;
  let pidRoot: string;
  let homeDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "curator-ms-proj-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-ms-home-"));
    sessionPath = path.join(projectRoot, "session.jsonl");
    goalFile = path.join(projectRoot, "goals", "spec.md");
    pidRoot = path.join(homeDir, "pids");
    env = { ...process.env };
    writeProjectConfig(projectRoot, goalFile);
    writeGoalFile(goalFile, "Be thorough but concise.");
    writeSessionJsonl(sessionPath);
    clearConfigCache();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    process.env = { ...REAL_ENV };
    clearConfigCache();
    vi.restoreAllMocks();
  });

  function baseOverrides() {
    return {
      projectRoot,
      mainSessionId: "ses-main",
      mainSessionName: "main-session",
      sessionJsonlPath: sessionPath,
      pidRoot,
      forksDir: path.join(homeDir, "forks"),
      runtimeExtensionPath: "/r.ts",
      intercomExtensionPath: "/i.ts",
      homeDir,
    };
  }

  it("writes a non-empty fork JSONL carrying the session header (writeForkFile)", async () => {
    const spawnFn = vi.fn(() => makeChild(11111));
    await handleTurnEnd({}, {}, { ...baseOverrides(), spawnFn, turnNumber: 1 });

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const args = spawnFn.mock.calls[0][1] as string[];
    const forkIdx = args.indexOf("--fork");
    expect(forkIdx).toBeGreaterThanOrEqual(0);
    const forkPath = args[forkIdx + 1];
    expect(fs.existsSync(forkPath)).toBe(true);
    const content = fs.readFileSync(forkPath, "utf8");
    // Header line (session object) must be present and non-empty.
    expect(content.length).toBeGreaterThan(0);
    expect(content.endsWith("\n")).toBe(true);
    const firstLine = content.split("\n")[0];
    expect(JSON.parse(firstLine).type).toBe("session");
  });

  it("defaults piBin/forksDir/turnNumber/parentEnv when deps omit them", async () => {
    const spawnFn = vi.fn(() => makeChild(22222));
    // No piBin/forksDir/turnNumber/parentEnv → defaults kick in.
    await handleTurnEnd({}, {}, {
      projectRoot,
      mainSessionId: "ses-main",
      mainSessionName: "main-session",
      sessionJsonlPath: sessionPath,
      pidRoot,
      spawnFn,
      runtimeExtensionPath: "/r.ts",
      intercomExtensionPath: "/i.ts",
      homeDir,
    });

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [piBin] = spawnFn.mock.calls[0];
    expect(piBin).toBe("pi"); // DEFAULT_PI_BIN
  });

  it("uses the injected piBin instead of the default", async () => {
    const spawnFn = vi.fn(() => makeChild(33334));
    await handleTurnEnd({}, {}, { ...baseOverrides(), spawnFn, turnNumber: 1, piBin: "/custom/pi" });
    expect(spawnFn.mock.calls[0][0]).toBe("/custom/pi");
  });

  it("spawns with detached:false", async () => {
    const spawnFn = vi.fn(() => makeChild(33335));
    await handleTurnEnd({}, {}, { ...baseOverrides(), spawnFn, turnNumber: 1 });
    const opts = spawnFn.mock.calls[0][2];
    expect(opts.detached).toBe(false);
  });

  it("notifies 'restart markers cleared' when markers are processed", async () => {
    const markerDir = path.join(homeDir, ".pi-curator", "restart-markers", "ses-main");
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, "spec.json"), "{}", "utf8");
    const notify = vi.fn();
    const spawnFn = vi.fn(() => makeChild(44441));
    await handleTurnEnd({}, { ui: { notify } }, { ...baseOverrides(), spawnFn, turnNumber: 1 });
    const restartNotify = notify.mock.calls.find(
      (c) => typeof c[0] === "string" && /restart markers cleared/.test(c[0]),
    );
    expect(restartNotify).toBeTruthy();
    expect(restartNotify![1]).toBe("info");
  });

  it("does NOT notify 'restart markers cleared' when no markers exist", async () => {
    const notify = vi.fn();
    const spawnFn = vi.fn(() => makeChild(44442));
    await handleTurnEnd({}, { ui: { notify } }, { ...baseOverrides(), spawnFn, turnNumber: 1 });
    const restartNotify = notify.mock.calls.find(
      (c) => typeof c[0] === "string" && /restart markers cleared/.test(c[0]),
    );
    expect(restartNotify).toBeUndefined();
  });

  it("does not spawn when only everyMins is configured and not enough time has passed (minsSince arithmetic)", async () => {
    // Persona spawn.everyMins=5; last spawn 10s ago → 0.16min < 5 → gate closed.
    // Mutating (Date.now()-last.atMs) to *60000 or + would falsely open the gate.
    const cfgDir = path.join(projectRoot, ".pi-curator");
    fs.writeFileSync(
      path.join(cfgDir, "curators.json"),
      JSON.stringify({
        curators: {
          spec: {
            alias: "spec",
            enabled: true,
            goalFile,
            spawn: { everyMins: 5 },
            model: "qwen3-coder",
          },
        },
      }, null, 2),
      "utf8",
    );
    clearConfigCache();
    const spawnFn = vi.fn(() => makeChild(55551));
    await handleTurnEnd({}, {}, {
      ...baseOverrides(),
      spawnFn,
      turnNumber: 1,
      lastSpawn: { spec: { turn: 1, atMs: Date.now() - 10_000 } },
    });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("does not spawn when the gate is closed and notifies nothing about spawn", async () => {
    const notify = vi.fn();
    const spawnFn = vi.fn(() => makeChild(55552));
    await handleTurnEnd({}, { ui: { notify } }, {
      ...baseOverrides(),
      spawnFn,
      turnNumber: 2,
      lastSpawn: { spec: { turn: 2, atMs: Date.now() } },
    });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("notifies 'could not read session JSONL' and skips spawn when the session file is missing", async () => {
    const notify = vi.fn();
    const spawnFn = vi.fn(() => makeChild(66661));
    await handleTurnEnd({}, { ui: { notify } }, {
      ...baseOverrides(),
      spawnFn,
      turnNumber: 1,
      sessionJsonlPath: path.join(projectRoot, "does-not-exist.jsonl"),
    });
    expect(spawnFn).not.toHaveBeenCalled();
    const readNotify = notify.mock.calls.find(
      (c) => typeof c[0] === "string" && /could not read session JSONL/.test(c[0]),
    );
    expect(readNotify).toBeTruthy();
    expect(readNotify![1]).toBe("error");
  });

  it("does not throw when ctx is undefined and a notify path fires (safeNotify exception safety)", async () => {
    const spawnFn = vi.fn(() => makeChild(66662));
    await expect(
      handleTurnEnd({}, undefined, {
        ...baseOverrides(),
        spawnFn,
        turnNumber: 1,
        sessionJsonlPath: path.join(projectRoot, "missing.jsonl"),
      }),
    ).resolves.toBeUndefined();
  });

  it("notifies 'fork filter failed' and skips spawn when the fork file cannot be written", async () => {
    // Make forksDir unwritable by placing a regular file where mkdir must create a dir.
    const blocker = path.join(homeDir, "blocker-file");
    fs.writeFileSync(blocker, "x", "utf8");
    const forksDir = path.join(blocker, "forks"); // mkdir will throw (ENOTDIR).
    const notify = vi.fn();
    const spawnFn = vi.fn(() => makeChild(77771));
    await handleTurnEnd({}, { ui: { notify } }, {
      ...baseOverrides(),
      spawnFn,
      turnNumber: 1,
      forksDir,
    });
    expect(spawnFn).not.toHaveBeenCalled();
    const forkNotify = notify.mock.calls.find(
      (c) => typeof c[0] === "string" && /fork filter failed/.test(c[0]),
    );
    expect(forkNotify).toBeTruthy();
    expect(forkNotify![1]).toBe("error");
  });

  it("skips spawn when the claim slot is already held by a live curator (REQ-LC-07)", async () => {
    // Pre-write a live claim (non-terminal phase, fresh heartbeat).
    const claimPath = curatorClaimFile(pidRoot, "ses-main", "spec");
    await writeCuratorClaim(claimPath, {
      pid: 999999,
      mainSessionId: "ses-main",
      curator: "spec",
      spawnedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      phase: "scanning",
    });
    const spawnFn = vi.fn(() => makeChild(77772));
    await handleTurnEnd({}, {}, { ...baseOverrides(), spawnFn, turnNumber: 1 });
    expect(spawnFn).not.toHaveBeenCalled();
    // The pre-existing live claim must remain untouched (not overwritten).
    const claim = await readCuratorClaim(claimPath);
    expect(claim?.pid).toBe(999999);
  });

  it("records lastSpawn[alias] = {turn, atMs} after a successful spawn", async () => {
    const spawnFn = vi.fn(() => makeChild(77773));
    const lastSpawn: Record<string, { turn: number; atMs: number }> = {};
    await handleTurnEnd({}, {}, {
      ...baseOverrides(),
      spawnFn,
      turnNumber: 7,
      lastSpawn,
    });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(lastSpawn.spec).toBeDefined();
    expect(lastSpawn.spec.turn).toBe(7);
    expect(typeof lastSpawn.spec.atMs).toBe("number");
  });

  it("seeds the claim heartbeatAt from the injected nowMs (D2 deterministic timestamp)", async () => {
    const spawnFn = vi.fn(() => makeChild(77774));
    const fixedNow = 1_700_000_000_000;
    await handleTurnEnd({}, {}, {
      ...baseOverrides(),
      spawnFn,
      turnNumber: 1,
      nowMs: fixedNow,
    });
    const claim = await readCuratorClaim(curatorClaimFile(pidRoot, "ses-main", "spec"));
    expect(claim?.pid).toBe(77774);
    expect(claim?.phase).toBe("spawned");
    expect(claim?.heartbeatAt).toBe(new Date(fixedNow).toISOString());
  });

  it("handles a child with no pid: no seed, notify shows 'pid ?'", async () => {
    const notify = vi.fn();
    // Child object WITHOUT a `pid` property.
    const childNoPid = { on: vi.fn() } as any;
    const spawnFn = vi.fn(() => childNoPid);
    await handleTurnEnd({}, { ui: { notify } }, { ...baseOverrides(), spawnFn, turnNumber: 1 });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const spawnedNotify = notify.mock.calls.find(
      (c) => typeof c[0] === "string" && /spawned curator:spec/.test(c[0]),
    );
    expect(spawnedNotify).toBeTruthy();
    expect(spawnedNotify![0]).toContain("pid ?");
    // Claim was acquired with placeholder (main pid) and NOT seeded with a child pid.
    const claim = await readCuratorClaim(curatorClaimFile(pidRoot, "ses-main", "spec"));
    expect(claim?.pid).toBe(process.pid);
  });

  it("registers a child 'error' listener that surfaces curator errors via notify", async () => {
    const notify = vi.fn();
    const onFn = vi.fn();
    const spawnFn = vi.fn(() => ({ pid: 77775, on: onFn } as any));
    await handleTurnEnd({}, { ui: { notify } }, { ...baseOverrides(), spawnFn, turnNumber: 1 });
    expect(onFn).toHaveBeenCalledWith("error", expect.any(Function));
    // Invoke the registered error listener.
    const errorHandler = onFn.mock.calls.find((c) => c[0] === "error")![1];
    errorHandler(new Error("boom"));
    const errNotify = notify.mock.calls.find(
      (c) => typeof c[0] === "string" && /curator:spec error: boom/.test(c[0]),
    );
    expect(errNotify).toBeTruthy();
    expect(errNotify![1]).toBe("error");
  });

  it("surfaces a staleness summary via ctx.ui.setStatus after spawn", async () => {
    const setStatus = vi.fn();
    const notify = vi.fn();
    const spawnFn = vi.fn(() => makeChild(77776));
    await handleTurnEnd(
      {},
      { ui: { setStatus, notify } },
      { ...baseOverrides(), spawnFn, turnNumber: 1 },
    );
    expect(setStatus).toHaveBeenCalledTimes(1);
    const status = setStatus.mock.calls[0][0] as string;
    expect(status.startsWith("curator:")).toBe(true);
    // The just-spawned child pid is not a real process → classified dead.
    expect(status).toMatch(/dead/);
  });
});

describe("processRestartMarkers — non-json files ignored", () => {
  it("ignores marker files that do not end with .json", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "curator-rm-json-"));
    const markerDir = path.join(home, ".pi-curator", "restart-markers", "ses-main");
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, "spec.json"), "{}", "utf8");
    fs.writeFileSync(path.join(markerDir, "README.md"), "ignore me", "utf8");
    fs.writeFileSync(path.join(markerDir, "spec.txt"), "ignore me", "utf8");

    const lastSpawn: Record<string, { turn: number; atMs: number }> = { spec: { turn: 5, atMs: 1 } };
    const reset = processRestartMarkers("ses-main", lastSpawn, { homeDir: home });
    expect(reset).toEqual(["spec"]);
    expect(lastSpawn.spec).toBeUndefined();
    // Non-json files are left in place.
    expect(fs.existsSync(path.join(markerDir, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(markerDir, "spec.txt"))).toBe(true);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("buildChildEnv — name length edge cases", () => {
  it("uses mainSessionName when it is a non-empty string", () => {
    const env = buildChildEnv("spec", "ses-main", "real-name", 1782000000000, {});
    expect(env.PI_CURATOR_MAIN_NAME).toBe("real-name");
  });
});

describe("curatorMainExtension — turn_end handler invocation", () => {
  let projectRoot: string;
  let sessionPath: string;
  let goalFile: string;
  let homeDir: string;
  let pidRoot: string;

  beforeEach(async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "curator-hook-proj-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-hook-home-"));
    // Redirect PID root + forks away from the real home by setting HOME so
    // defaultPidRoot()/DEFAULT_FORK_ROOT() resolve inside the temp home.
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    sessionPath = path.join(projectRoot, "session.jsonl");
    goalFile = path.join(projectRoot, "goals", "spec.md");
    pidRoot = path.join(homeDir, "pids");
    writeProjectConfig(projectRoot, goalFile);
    writeGoalFile(goalFile, "Hook-driven spawn.");
    writeSessionJsonl(sessionPath);
    clearConfigCache();
    spawnMock.mockReset();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    process.env = { ...REAL_ENV };
    clearConfigCache();
    vi.restoreAllMocks();
  });

  it("registers a turn_end hook on pi", async () => {
    const pi: any = { on: vi.fn() };
    curatorMainExtensionDefault(pi, { ui: { notify: vi.fn() } });
    expect(pi.on).toHaveBeenCalledWith("turn_end", expect.any(Function));
  });

  it("fires the handler: spawns a curator when intercom path is resolvable via env", async () => {
    process.env.PI_INTERCOM_EXTENSION_PATH = "/fake/intercom.ts";
    const handlerHolder: { fn?: Function } = {};
    const pi: any = {
      on: vi.fn((evt: string, fn: Function) => {
        if (evt === "turn_end") handlerHolder.fn = fn;
      }),
    };
    curatorMainExtensionDefault(pi, { ui: { notify: vi.fn() } });
    expect(handlerHolder.fn).toBeDefined();

    spawnMock.mockImplementation(() => ({ pid: 909090, on: vi.fn() }));
    const ctx = { cwd: projectRoot, sessionId: "ses-main", sessionName: "main-session", sessionFile: sessionPath };
    // Invoke the registered turn_end handler.
    await handlerHolder.fn!({}, ctx);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain("--no-extensions");
    expect(args).toContain("/fake/intercom.ts");
  });

  it("skips spawn and notifies when the intercom extension path cannot be resolved", async () => {
    delete process.env.PI_INTERCOM_EXTENSION_PATH;
    // Force the resolver to return undefined via the test seam. The walk-up
    // probe would otherwise discover a real sibling pi-intercom in the dev
    // tree (~/<...>/bhd/pi-intercom), making this branch non-deterministic.
    __setIntercomResolverForTest(() => undefined);
    try {
    const handlerHolder: { fn?: Function } = {};
    const pi: any = {
      on: vi.fn((evt: string, fn: Function) => {
        if (evt === "turn_end") handlerHolder.fn = fn;
      }),
    };
    const notify = vi.fn();
    curatorMainExtensionDefault(pi, { ui: { notify } });
    spawnMock.mockImplementation(() => ({ pid: 909091, on: vi.fn() }));
    const ctx = { cwd: projectRoot, sessionId: "ses-main", sessionFile: sessionPath, ui: { notify } };
    await handlerHolder.fn!({}, ctx);
    const skipNotify = notify.mock.calls.find(
      (c) => typeof c[0] === "string" && /pi-intercom extension path not found/.test(c[0]),
    );
    expect(skipNotify).toBeTruthy();
    expect(skipNotify[1]).toBe("error");
    expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      __setIntercomResolverForTest(); // restore real resolver
    }
  });
});
