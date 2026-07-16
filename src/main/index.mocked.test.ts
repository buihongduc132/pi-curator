/**
 * index.mocked.test.ts — covers index.ts branches unreachable with real fs:
 *
 *   1. handleTurnEnd config-load catch (getCachedConfig throws → "config load
 *      failed" notify + early return).
 *   2. curatorMainExtension outer REQ-LC-10 crash-catch: when an inner helper
 *      throws synchronously into the hook body, the catch fires a
 *      "turn_end handler crashed" notify.
 *
 * Uses vi.mock for the LOCAL modules ../util/config.js and ./spawn-gate.js
 * (local-module mocks ARE honored by stryker's vitest runner; built-in
 * node:module mocks are NOT, so intercom resolution is tested via the `here`
 * param in index.survivors2.test.ts instead).
 */
// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const mockState = vi.hoisted(() => ({
  configThrows: false,
  gateThrows: false,
}));

vi.mock("../util/config.js", async (importActual) => {
  const actual = (await importActual()) as any;
  return {
    ...actual,
    getCachedConfig: (opts: any) => {
      if (mockState.configThrows) throw new Error("config boom");
      return actual.getCachedConfig(opts);
    },
  };
});

vi.mock("./spawn-gate.js", async (importActual) => {
  const actual = (await importActual()) as any;
  return {
    ...actual,
    evaluateSpawnGate: (...args: unknown[]) => {
      if (mockState.gateThrows) throw new Error("gate boom");
      return (actual.evaluateSpawnGate as (...a: unknown[]) => unknown)(...args);
    },
  };
});

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const { handleTurnEnd, default: curatorMainExtension } = await import("./index.js");
const { clearConfigCache } = await import("../util/config.js");

const REAL_ENV = { ...process.env };

function writeProjectConfig(projectRoot: string) {
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
            goalFile: path.join(projectRoot, "goals", "spec.md"),
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

// ─── handleTurnEnd — config-load catch ──────────────────────────────────────

describe("handleTurnEnd — config load failure", () => {
  let projectRoot: string;
  let homeDir: string;
  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "curator-mock-proj-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-mock-home-"));
    writeProjectConfig(projectRoot);
    clearConfigCache();
    mockState.configThrows = false;
    mockState.gateThrows = false;
  });
  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    process.env = { ...REAL_ENV };
    clearConfigCache();
    mockState.configThrows = false;
    mockState.gateThrows = false;
    vi.restoreAllMocks();
  });

  it("notifies 'config load failed' and returns early when getCachedConfig throws", async () => {
    mockState.configThrows = true;
    const notify = vi.fn();
    const spawnFn = vi.fn();
    await handleTurnEnd({}, { ui: { notify } }, {
      projectRoot,
      mainSessionId: "ses",
      sessionJsonlPath: path.join(projectRoot, "s.jsonl"),
      pidRoot: path.join(homeDir, "pids"),
      forksDir: path.join(homeDir, "forks"),
      spawnFn,
      runtimeExtensionPath: "/r.ts",
      intercomExtensionPath: "/i.ts",
      homeDir,
      turnNumber: 1,
    });
    expect(spawnFn).not.toHaveBeenCalled();
    const m = notify.mock.calls.find((c) => /config load failed/.test(String(c[0])));
    expect(m).toBeTruthy();
    expect(m[1]).toBe("error");
    expect(String(m[0])).toContain("config boom");
  });
});

// ─── curatorMainExtension — outer REQ-LC-10 crash-catch ─────────────────────

describe("curatorMainExtension — outer REQ-LC-10 crash-catch", () => {
  let projectRoot: string;
  let homeDir: string;
  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "curator-crash-proj-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-crash-home-"));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    writeProjectConfig(projectRoot);
    clearConfigCache();
    mockState.configThrows = false;
    mockState.gateThrows = false;
    spawnMock.mockReset();
    process.env.PI_INTERCOM_EXTENSION_PATH = "/fake/intercom.ts";
  });
  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    process.env = { ...REAL_ENV };
    clearConfigCache();
    mockState.configThrows = false;
    mockState.gateThrows = false;
    vi.restoreAllMocks();
  });

  it("catches a thrown gate evaluation and notifies 'turn_end handler crashed'", async () => {
    mockState.gateThrows = true;
    const notify = vi.fn();
    const holder: { fn?: Function } = {};
    const pi: any = {
      on: vi.fn((evt: string, fn: Function) => {
        if (evt === "turn_end") holder.fn = fn;
      }),
    };
    curatorMainExtension(pi, { ui: { notify } });
    const sessionPath = path.join(projectRoot, "session.jsonl");
    fs.writeFileSync(sessionPath, JSON.stringify({ type: "session", id: "s", version: 1, cwd: "/tmp" }) + "\n", "utf8");
    await expect(
      holder.fn!({}, { cwd: projectRoot, sessionId: "ses", sessionFile: sessionPath, ui: { notify } }),
    ).resolves.toBeUndefined();
    const crash = notify.mock.calls.find((c) => /turn_end handler crashed/.test(String(c[0])));
    expect(crash).toBeTruthy();
    expect(crash[1]).toBe("error");
    expect(String(crash[0])).toContain("gate boom");
  });
});
