/**
 * index.survivors2.test.ts — round-2 mutation survivor remediation for
 * src/main/index.ts. Targets surviving mutants: error-path catches
 * (claim-acquire/argv-build/spawn), child-without-pid/on, parentEnv default,
 * writeForkFile header/empty branches + includeThinking, staleness checkPid,
 * the intercom resolver nmProbes/walk-up branches (via the `here` param), and
 * the hook ctx-fallback optional-chaining (via ctx=nullish).
 *
 * No process.chdir(); all fs under os.tmpdir() sandboxes. HOME redirected.
 */
// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import curatorMainExtensionDefault, {
  handleTurnEnd,
  resolveIntercomExtensionPath,
  buildChildEnv,
} from "./index.js";
import { clearConfigCache } from "../util/config.js";
import { readCuratorClaim, curatorClaimFile } from "../util/team-attach-claim.js";

const REAL_ENV = { ...process.env };

function writeProjectConfig(projectRoot: string, overrides: Record<string, unknown> = {}) {
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
function writeGoal(goalFile: string, content: string) {
  fs.mkdirSync(path.dirname(goalFile), { recursive: true });
  fs.writeFileSync(goalFile, content, "utf8");
}
function writeSession(sessionPath: string, lines: string[]) {
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, lines.join("\n"), "utf8");
}
const HEADER = (id = "ses-main") => JSON.stringify({ type: "session", version: 1, id, cwd: "/tmp" });
const MSG = (id: string, parentId: string | null, role: string, content: unknown[]) =>
  JSON.stringify({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z", message: { role, content } });
const TEXT = (t: string) => ({ type: "text", text: t });
const THINK = (t: string) => ({ type: "thinking", thinking: t });
function makeChild(pid?: number) {
  return pid === undefined ? { on: vi.fn() } : { pid, on: vi.fn() };
}

// ─── resolveIntercomExtensionPath — nmProbes + walk-up via `here` param ─────

describe("resolveIntercomExtensionPath — nmProbes + walk-up (here param)", () => {
  let tree: string;
  beforeEach(() => {
    tree = fs.mkdtempSync(path.join(os.tmpdir(), "intercom-here-"));
    delete process.env.PI_INTERCOM_EXTENSION_PATH;
  });
  afterEach(() => {
    fs.rmSync(tree, { recursive: true, force: true });
    delete process.env.PI_INTERCOM_EXTENSION_PATH;
  });

  it("finds pi-intercom via the node_modules probe relative to `here`", () => {
    // Layout: <tree>/node_modules/pi-intercom/index.ts ; here = <tree>/sub/deep
    //   here/../.. = <tree> ; nmProbe = <tree>/node_modules/pi-intercom/index.ts
    // No sibling pi-intercom in the walk-up path → nmProbes is the sole finder.
    const nmPkg = path.join(tree, "node_modules", "pi-intercom");
    fs.mkdirSync(nmPkg, { recursive: true });
    fs.writeFileSync(path.join(nmPkg, "index.ts"), "// stub\n");
    const here = path.join(tree, "sub", "deep");
    const result = resolveIntercomExtensionPath(here);
    expect(result).toBe(path.join(nmPkg, "index.ts"));
  });

  it("finds pi-intercom via the git-sibling walk-up (.ts)", () => {
    // Layout: <tree>/pi-intercom/index.ts ; here = <tree>/deep
    //   nmProbe (<tree>/deep/../../node_modules/...) misses → walk-up finds sibling.
    const sib = path.join(tree, "pi-intercom");
    fs.mkdirSync(sib, { recursive: true });
    fs.writeFileSync(path.join(sib, "index.ts"), "// stub\n");
    const here = path.join(tree, "deep");
    const result = resolveIntercomExtensionPath(here);
    expect(result).toBe(path.join(sib, "index.ts"));
  });

  it("finds pi-intercom via the git-sibling walk-up (.js when no .ts)", () => {
    const sib = path.join(tree, "pi-intercom");
    fs.mkdirSync(sib, { recursive: true });
    fs.writeFileSync(path.join(sib, "index.js"), "// stub\n");
    const here = path.join(tree, "deep");
    const result = resolveIntercomExtensionPath(here);
    expect(result).toBe(path.join(sib, "index.js"));
  });

  it("returns undefined when no probe/walk-up finds pi-intercom", () => {
    const here = path.join(tree, "deep", "nest");
    fs.mkdirSync(here, { recursive: true });
    expect(resolveIntercomExtensionPath(here)).toBeUndefined();
  });
});

// ─── handleTurnEnd — error paths & wiring ───────────────────────────────────

describe("handleTurnEnd — survivor round 2", () => {
  let projectRoot: string;
  let homeDir: string;
  let sessionPath: string;
  let goalFile: string;
  let pidRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "curator-s2-proj-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-s2-home-"));
    sessionPath = path.join(projectRoot, "session.jsonl");
    goalFile = path.join(projectRoot, "goals", "spec.md");
    pidRoot = path.join(homeDir, "pids");
    writeProjectConfig(projectRoot);
    writeGoal(goalFile, "Be thorough.");
    writeSession(sessionPath, [
      HEADER("ses-main"),
      MSG("e1", "ses-main", "user", [TEXT("hello")]),
      MSG("e2", "e1", "assistant", [TEXT("hi")]),
    ]);
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
  function base() {
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

  it("notifies 'claim acquire failed' and skips spawn when the claim path is unwritable", async () => {
    const blocker = path.join(homeDir, "blocker-file");
    fs.writeFileSync(blocker, "x");
    const notify = vi.fn();
    const spawnFn = vi.fn(() => makeChild(100001));
    await handleTurnEnd({}, { ui: { notify } }, {
      ...base(),
      pidRoot: path.join(blocker, "pids"),
      spawnFn,
      turnNumber: 1,
    });
    expect(spawnFn).not.toHaveBeenCalled();
    const m = notify.mock.calls.find((c) => /claim acquire failed/.test(String(c[0])));
    expect(m).toBeTruthy();
    expect(m[1]).toBe("error");
  });

  it("notifies 'argv build failed' when buildSpawnArgs throws (empty intercom path)", async () => {
    const notify = vi.fn();
    const spawnFn = vi.fn(() => makeChild(100002));
    await handleTurnEnd({}, { ui: { notify } }, {
      ...base(),
      spawnFn,
      turnNumber: 1,
      intercomExtensionPath: "",
    });
    expect(spawnFn).not.toHaveBeenCalled();
    const m = notify.mock.calls.find((c) => /argv build failed/.test(String(c[0])));
    expect(m).toBeTruthy();
    expect(m[1]).toBe("error");
  });

  it("notifies 'spawn failed' when spawnFn throws", async () => {
    const notify = vi.fn();
    const spawnFn = vi.fn(() => { throw new Error("ENOENT binary"); });
    await handleTurnEnd({}, { ui: { notify } }, { ...base(), spawnFn, turnNumber: 1 });
    const m = notify.mock.calls.find((c) => /spawn failed/.test(String(c[0])));
    expect(m).toBeTruthy();
    expect(m[1]).toBe("error");
    const claim = await readCuratorClaim(curatorClaimFile(pidRoot, "ses-main", "spec"));
    expect(claim?.pid).toBe(process.pid);
  });

  it("handles a null child: no seed, notify shows 'pid ?', lastSpawn recorded, no crash", async () => {
    const notify = vi.fn();
    const spawnFn = vi.fn(() => null);
    const lastSpawn: Record<string, { turn: number; atMs: number }> = {};
    await expect(
      handleTurnEnd({}, { ui: { notify } }, { ...base(), spawnFn, turnNumber: 5, lastSpawn }),
    ).resolves.toBeUndefined();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const spawned = notify.mock.calls.find((c) => /spawned curator:spec/.test(String(c[0])));
    expect(spawned[0]).toContain("pid ?");
    expect(lastSpawn.spec).toBeDefined();
    expect(lastSpawn.spec.turn).toBe(5);
    const claim = await readCuratorClaim(curatorClaimFile(pidRoot, "ses-main", "spec"));
    expect(claim?.pid).toBe(process.pid);
  });

  it("handles a child with no 'on' method without crashing", async () => {
    const spawnFn = vi.fn(() => ({ pid: 100003 }));
    await expect(
      handleTurnEnd({}, { ui: {} }, { ...base(), spawnFn, turnNumber: 1 }),
    ).resolves.toBeUndefined();
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it("inherits process.env into the child env when parentEnv is not injected", async () => {
    process.env.CURATOR_MARKER_INHERIT = "yes-" + Date.now();
    const spawnFn = vi.fn(() => makeChild(100004));
    try {
      await handleTurnEnd({}, {}, { ...base(), spawnFn, turnNumber: 1 });
      const opts = spawnFn.mock.calls[0][2];
      expect(opts.env.CURATOR_MARKER_INHERIT).toBe(process.env.CURATOR_MARKER_INHERIT);
    } finally {
      delete process.env.CURATOR_MARKER_INHERIT;
    }
  });

  it("writes a header-less fork without injecting a 'null' line", async () => {
    writeSession(sessionPath, [
      MSG("e1", null, "user", [TEXT("hello")]),
      MSG("e2", "e1", "assistant", [TEXT("hi")]),
    ]);
    const spawnFn = vi.fn(() => makeChild(100005));
    await handleTurnEnd({}, {}, { ...base(), spawnFn, turnNumber: 1 });
    const args = spawnFn.mock.calls[0][1] as string[];
    const forkPath = args[args.indexOf("--fork") + 1];
    const content = fs.readFileSync(forkPath, "utf8");
    expect(content.split("\n").filter((l) => l === "null")).toEqual([]);
    expect(content).toContain("hello");
  });

  it("produces an empty fork file when the session has no header and no entries", async () => {
    writeSession(sessionPath, [""]);
    const spawnFn = vi.fn(() => makeChild(100006));
    await handleTurnEnd({}, {}, { ...base(), spawnFn, turnNumber: 1 });
    const args = spawnFn.mock.calls[0][1] as string[];
    const forkPath = args[args.indexOf("--fork") + 1];
    expect(fs.readFileSync(forkPath, "utf8")).toBe("");
  });

  it("classifies the freshly-spawned dead child as exactly '1 dead' (checkPid:true)", async () => {
    const setStatus = vi.fn();
    const spawnFn = vi.fn(() => makeChild(100007));
    await handleTurnEnd({}, { ui: { setStatus, notify: vi.fn() } }, { ...base(), spawnFn, turnNumber: 1 });
    const status = setStatus.mock.calls[0][0] as string;
    expect(status).toMatch(/(^|[^0-9])1 dead/);
    expect(status).not.toMatch(/1 live/);
  });

  it("keeps assistant thinking blocks when persona.includeThinking is true", async () => {
    writeProjectConfig(projectRoot, { includeThinking: true });
    clearConfigCache();
    writeSession(sessionPath, [
      HEADER("ses-main"),
      MSG("e1", "ses-main", "assistant", [THINK("SECRET-THINK-TOKEN"), TEXT("answer")]),
    ]);
    const spawnFn = vi.fn(() => makeChild(100008));
    await handleTurnEnd({}, {}, { ...base(), spawnFn, turnNumber: 1 });
    const args = spawnFn.mock.calls[0][1] as string[];
    const forkPath = args[args.indexOf("--fork") + 1];
    expect(fs.readFileSync(forkPath, "utf8")).toContain("SECRET-THINK-TOKEN");
  });

  it("strips assistant thinking blocks when persona.includeThinking is false", async () => {
    writeProjectConfig(projectRoot, { includeThinking: false });
    clearConfigCache();
    writeSession(sessionPath, [
      HEADER("ses-main"),
      MSG("e1", "ses-main", "assistant", [THINK("SECRET-THINK-TOKEN"), TEXT("answer")]),
    ]);
    const spawnFn = vi.fn(() => makeChild(100009));
    await handleTurnEnd({}, {}, { ...base(), spawnFn, turnNumber: 1 });
    const args = spawnFn.mock.calls[0][1] as string[];
    const forkPath = args[args.indexOf("--fork") + 1];
    const content = fs.readFileSync(forkPath, "utf8");
    expect(content).not.toContain("SECRET-THINK-TOKEN");
    expect(content).toContain("answer");
  });
});

// ─── curatorMainExtension hook — ctx fallback optional-chaining ─────────────

describe("curatorMainExtension — hook ctx fallback chains", () => {
  let projectRoot: string;
  let homeDir: string;
  let sessionPath: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "curator-hook2-proj-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-hook2-home-"));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    delete process.env.PI_INTERCOM_EXTENSION_PATH;
    sessionPath = path.join(projectRoot, "session.jsonl");
    writeProjectConfig(projectRoot);
    writeGoal(path.join(projectRoot, "goals", "spec.md"), "g.");
    writeSession(sessionPath, [HEADER("ses-main"), MSG("e1", "ses-main", "user", [TEXT("hello")])]);
    clearConfigCache();
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => ({ pid: 200001, on: vi.fn() }));
  });
  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    process.env = { ...REAL_ENV };
    clearConfigCache();
    vi.restoreAllMocks();
  });
  function captureHandler() {
    const holder: { fn?: Function } = {};
    const pi = {
      on: vi.fn((evt: string, fn: Function) => {
        if (evt === "turn_end") holder.fn = fn;
      }),
    };
    curatorMainExtensionDefault(pi, { ui: { notify: vi.fn() } });
    return holder;
  }

  it("does not throw when pi has no 'on' method (pi.on?. optional chaining)", () => {
    expect(() => curatorMainExtensionDefault({}, { ui: { notify: vi.fn() } })).not.toThrow();
  });

  it("derives mainSessionId/Name from ctx.session when top-level fields are absent", async () => {
    const holder = captureHandler();
    process.env.PI_INTERCOM_EXTENSION_PATH = "/fake/intercom.ts";
    await holder.fn!({}, {
      cwd: projectRoot,
      session: { id: "from-session", name: "session-name", file: sessionPath },
      ui: { notify: vi.fn() },
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const opts = spawnMock.mock.calls[0][2];
    expect(opts.env.PI_CURATOR_MAIN_ID).toBe("from-session");
    expect(opts.env.PI_CURATOR_MAIN_NAME).toBe("session-name");
  });

  it("falls back to pid-${process.pid} for mainSessionId when neither sessionId nor session.id is present", async () => {
    const holder = captureHandler();
    process.env.PI_INTERCOM_EXTENSION_PATH = "/fake/intercom.ts";
    await holder.fn!({}, { cwd: projectRoot, sessionFile: sessionPath, ui: { notify: vi.fn() } });
    const opts = spawnMock.mock.calls[0][2];
    expect(opts.env.PI_CURATOR_MAIN_ID).toBe(`pid-${process.pid}`);
  });

  it("does NOT crash-notify when ctx is null (all ctx?. chains must short-circuit)", async () => {
    // A null ctx distinguishes `ctx?.x` (no-ops) from `ctx.x` (throws → outer
    // crash-catch fires a 'turn_end handler crashed' notify). Original must NOT
    // emit that crash notify.
    const holder = captureHandler();
    const notify = vi.fn();
    await expect(holder.fn!({}, null)).resolves.toBeUndefined();
    const crash = notify.mock.calls.find((c) => /turn_end handler crashed/.test(String(c[0])));
    expect(crash).toBeUndefined();
  });
});

// ─── buildChildEnv — name edge ──────────────────────────────────────────────

describe("buildChildEnv — survivor round 2", () => {
  it("uses mainSessionId for MAIN_NAME when name is empty", () => {
    const env = buildChildEnv("spec", "ses-x", "", 1_700_000_000_000, {});
    expect(env.PI_CURATOR_MAIN_NAME).toBe("ses-x");
  });
});
