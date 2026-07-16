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
import { handleTurnEnd, buildChildEnv, processRestartMarkers, MAIN_EXTENSION_LOADED_FLAG } from "./index.js";
import { clearConfigCache } from "../util/config.js";
import { readCuratorClaim, curatorClaimFile, defaultPidRoot } from "../util/team-attach-claim.js";

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
