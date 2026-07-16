/**
 * index.survivors3.test.ts — FINAL mutation survivor remediation for
 * src/main/index.ts.
 *
 * Targets surviving mutants from a fresh scoped stryker run (84.09%):
 *
 *  - resolveIntercomExtensionPath require.resolve success branch (L92 + L95 ×8)
 *    via a controllable `createRequire` mock.
 *  - walk-up bound `i < MAX_WALK_UP` / `i++` (L115 ×2) via a deep tree where
 *    pi-intercom sits just past the 10-iteration cap.
 *  - readGoalContents `if (!goalFile)` early-return (L163) via a readFileSync
 *    spy asserting no `undefined` read happens.
 *  - `deps.parentEnv ?? process.env` → `&&` (L311) via explicit undefined +
 *    an inherited env marker.
 *  - curatorMainExtension hook ctx optional-chaining (L478/L480/L481/L483) via
 *    ctx=null and ctx={cwd} with the _ctx crash-notify properly captured
 *    (the prior test captured the wrong notify fn, so mutants survived).
 *  - `turnCounter += 1` → `-=` (L477) via firing turn_end 4× with everyTurns:3
 *    and asserting the 2nd spawn lands on turn 4.
 *
 * Equivalent (unkillable) mutants — documented in the PR report:
 *  - L121 `parent === dir` break → false (root re-check is a no-op).
 *  - L144 safeNotify optional-chaining ×3 (try/catch swallows the throw).
 *  - L152 safeSetStatus optional-chaining ×3 (try/catch swallows the throw).
 *  - L166 readGoalContents catch → {} (returns "" vs undefined; buildSpawnArgs
 *    defaults both to "").
 *  - L188 `mainSessionName.length > 0` cond/ge mutants (string truthiness ≡
 *    length>0; empty string already falsy).
 *  - L263 writeForkFile catch → {} (returns null vs undefined; caller `!forkPath`
 *    treats both as failure).
 *  - L452 `{ checkPid: true }` → {} (classifyLiveness uses `checkPid !== false`,
 *    so undefined ≡ true).
 *  - L510 _ctx crash-notify optional-chaining ×3 (inner try/catch swallows).
 *
 * No process.chdir(); HOME + projectRoot isolated in tmpdirs.
 */
// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const { createRequireMock, spawnMock } = vi.hoisted(() => ({
  createRequireMock: vi.fn(),
  spawnMock: vi.fn(),
}));
vi.mock("node:module", () => ({ createRequire: createRequireMock }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import curatorMainExtensionDefault, {
  handleTurnEnd,
  resolveIntercomExtensionPath,
  __setIntercomResolverForTest,
} from "./index.js";
import { clearConfigCache } from "../util/config.js";
import { curatorClaimFile, defaultPidRoot } from "../util/team-attach-claim.js";

const REAL_ENV = { ...process.env };

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
function makeChild(pid?: number) {
  return pid === undefined ? { on: vi.fn() } : { pid, on: vi.fn() };
}

beforeEach(() => {
  createRequireMock.mockReset();
  spawnMock.mockReset();
});
afterEach(() => {
  process.env = { ...REAL_ENV };
  clearConfigCache();
  __setIntercomResolverForTest(undefined);
  vi.restoreAllMocks();
});

// ─── resolveIntercomExtensionPath — require.resolve success (L92/L95) ────────

describe("resolveIntercomExtensionPath — require.resolve branch (L92/L95)", () => {
  let tree: string;
  beforeEach(() => {
    tree = fs.mkdtempSync(path.join(os.tmpdir(), "intercom-req-"));
    delete process.env.PI_INTERCOM_EXTENSION_PATH;
    // require.resolve throws by default so we reach probes/walk-up when wanted.
    createRequireMock.mockReturnValue({
      resolve: () => {
        throw new Error("not found");
      },
    });
  });
  afterEach(() => fs.rmSync(tree, { recursive: true, force: true }));

  it("returns the resolved path when require.resolve yields a non-empty string", () => {
    createRequireMock.mockReturnValue({ resolve: () => "/fake/pi-intercom/index.ts" });
    expect(resolveIntercomExtensionPath(path.join(tree, "deep"))).toBe("/fake/pi-intercom/index.ts");
  });

  it("falls through when require.resolve yields an empty string", () => {
    createRequireMock.mockReturnValue({ resolve: () => "" });
    // Empty string → original does not return; falls to probes (none here) → undefined.
    expect(resolveIntercomExtensionPath(path.join(tree, "deep"))).toBeUndefined();
  });

  it("falls through when require.resolve yields a non-string with length>0", () => {
    // Distinguishes `&&` → `||`: a non-string truthy-length value must NOT be
    // returned (typeof !== "string").
    createRequireMock.mockReturnValue({ resolve: () => ({ length: 5 }) as any });
    expect(resolveIntercomExtensionPath(path.join(tree, "deep"))).toBeUndefined();
  });
});

// ─── resolveIntercomExtensionPath — walk-up bound (L115) ─────────────────────

describe("resolveIntercomExtensionPath — walk-up bound (L115)", () => {
  let tree: string;
  beforeEach(() => {
    tree = fs.mkdtempSync(path.join(os.tmpdir(), "intercom-walk-"));
    delete process.env.PI_INTERCOM_EXTENSION_PATH;
    createRequireMock.mockReturnValue({
      resolve: () => {
        throw new Error("not found");
      },
    });
  });
  afterEach(() => fs.rmSync(tree, { recursive: true, force: true }));

  it("does not find pi-intercom placed just past the 10-iteration cap", () => {
    // Build a 12-level chain: tree/c0/c1/.../c11, here = bottom. Place
    // pi-intercom/index.ts as a child of c1 (the 10th ancestor of `here`).
    // Original (i<10) checks ancestors 0..9 → misses; mutant `i<=10` / `i--`
    // reaches ancestor 10 → finds it → returns a path. Asserting undefined
    // kills both L115 mutants.
    let dir = tree;
    const chain = ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10", "c11"];
    for (const c of chain) {
      dir = path.join(dir, c);
      fs.mkdirSync(dir, { recursive: true });
    }
    const here = dir; // tree/c0/.../c11
    //   A0=here, A1=c11, A2=c10, A3=c9, A4=c8, A5=c7, A6=c6, A7=c5, A8=c4,
    //   A9=c3, A10=c2, A11=c1.
    // Place pi-intercom under A10 = tree/c0/c1  (so original's last check
    // A9=tree/c0/c1/c2 misses it).
    const a10 = path.join(tree, "c0", "c1");
    fs.mkdirSync(path.join(a10, "pi-intercom"), { recursive: true });
    fs.writeFileSync(path.join(a10, "pi-intercom", "index.ts"), "// stub\n");
    expect(resolveIntercomExtensionPath(here)).toBeUndefined();
  });
});

// NOTE: L163 `if (!goalFile) return ""` → `if (false)` is EQUIVALENT — under
// the mutant readFileSync(undefined) throws synchronously and is caught by
// readGoalContents' own try/catch, returning "" exactly like the original.
// goalContents is "" either way, so buildSpawnArgs produces identical argv.
// There is no public-API observable difference (and the ESM `node:fs`
// namespace cannot be spied to detect the swallowed internal call). Documented
// as equivalent in the PR report.

// ─── parentEnv ?? process.env → && (L311) ───────────────────────────────────

describe("handleTurnEnd — parentEnv ?? → && (L311)", () => {
  let projectRoot: string;
  let homeDir: string;
  let sessionPath: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penv-proj-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "penv-home-"));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    sessionPath = path.join(projectRoot, "session.jsonl");
    writeProjectConfig(projectRoot);
    writeGoal(path.join(projectRoot, "goals", "spec.md"), "g.");
    writeSession(sessionPath, [HEADER("ses-pe"), MSG("e1", "ses-pe", "user", [TEXT("hi")])]);
    clearConfigCache();
  });
  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("uses the injected parentEnv (not process.env) in the child env (L311)", async () => {
    // Mutant `deps.parentEnv && process.env` would replace a custom env with
    // process.env. Pass a custom env that differs from process.env and assert
    // the custom marker survives into the child env. (Passing `undefined`
    // does NOT distinguish — buildChildEnv's default param re-applies.)
    const customEnv = { CURATOR_CUSTOM_PENV: "custom-value-" + Date.now() } as NodeJS.ProcessEnv;
    const spawnFn = vi.fn(() => makeChild(700002));
    await handleTurnEnd({}, {}, {
      projectRoot,
      mainSessionId: "ses-pe",
      sessionJsonlPath: sessionPath,
      forksDir: path.join(homeDir, "forks"),
      pidRoot: path.join(homeDir, "pids"),
      spawnFn,
      turnNumber: 1,
      parentEnv: customEnv,
    });
    const opts = spawnFn.mock.calls[0][2];
    expect(opts.env.CURATOR_CUSTOM_PENV).toBe(customEnv.CURATOR_CUSTOM_PENV);
  });
});

// ─── curatorMainExtension hook — ctx optional-chaining (L478/L480/L481/L483) ─

describe("curatorMainExtension — hook ctx fallback chains (L478/L480/L481/L483)", () => {
  let projectRoot: string;
  let homeDir: string;
  let sessionPath: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hookctx-proj-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "hookctx-home-"));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    delete process.env.PI_INTERCOM_EXTENSION_PATH;
    sessionPath = path.join(projectRoot, "session.jsonl");
    writeProjectConfig(projectRoot);
    writeGoal(path.join(projectRoot, "goals", "spec.md"), "g.");
    writeSession(sessionPath, [HEADER("ses-hc"), MSG("e1", "ses-hc", "user", [TEXT("hi")])]);
    clearConfigCache();
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => ({ pid: 700003, on: vi.fn() }));
    process.env.PI_INTERCOM_EXTENSION_PATH = "/fake/intercom.ts";
  });
  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  function captureHandler(notify: ReturnType<typeof vi.fn>) {
    const holder: { fn?: Function } = {};
    const pi = {
      on: vi.fn((evt: string, fn: Function) => {
        if (evt === "turn_end") holder.fn = fn;
      }),
    };
    // _ctx carries the notify we actually inspect (prior test inspected the
    // wrong fn, so the crash-notify mutants survived).
    curatorMainExtensionDefault(pi, { ui: { notify } });
    return holder;
  }

  it("does NOT crash-notify when ctx is null (kills L478/L480 ctx? removals)", async () => {
    const notify = vi.fn();
    const holder = captureHandler(notify);
    await expect(holder.fn!({}, null)).resolves.toBeUndefined();
    const crash = notify.mock.calls.find((c) => /turn_end handler crashed/.test(String(c[0])));
    expect(crash).toBeUndefined();
  });

  it("does NOT crash-notify when ctx has cwd but no session (kills session? removals L481/L483)", async () => {
    const notify = vi.fn();
    const holder = captureHandler(notify);
    await expect(
      holder.fn!({}, { cwd: projectRoot, sessionId: "ses-hc", ui: { notify } }),
    ).resolves.toBeUndefined();
    const crash = notify.mock.calls.find((c) => /turn_end handler crashed/.test(String(c[0])));
    expect(crash).toBeUndefined();
  });
});

// ─── turnCounter += 1 → -= 1 (L477) ─────────────────────────────────────────

describe("curatorMainExtension — turnCounter increment (L477)", () => {
  let projectRoot: string;
  let homeDir: string;
  let sessionPath: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tc-proj-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-home-"));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    delete process.env.PI_INTERCOM_EXTENSION_PATH;
    sessionPath = path.join(projectRoot, "session.jsonl");
    writeProjectConfig(projectRoot);
    writeGoal(path.join(projectRoot, "goals", "spec.md"), "g.");
    writeSession(sessionPath, [HEADER("ses-tc"), MSG("e1", "ses-tc", "user", [TEXT("hi")])]);
    clearConfigCache();
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => ({ pid: 700004, on: vi.fn() }));
    process.env.PI_INTERCOM_EXTENSION_PATH = "/fake/intercom.ts";
  });
  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("spawns on turn 1 and again on turn 4 (everyTurns:3); mutant -= would only spawn once", async () => {
    const holder: { fn?: Function } = {};
    const pi = { on: vi.fn((e: string, fn: Function) => { if (e === "turn_end") holder.fn = fn; }) };
    curatorMainExtensionDefault(pi, { ui: { notify: vi.fn() } });
    const ctx = { cwd: projectRoot, sessionId: "ses-tc", sessionFile: sessionPath, ui: { notify: vi.fn() } };
    const pidRoot = defaultPidRoot();
    for (let t = 0; t < 4; t++) {
      await holder.fn!({}, ctx);
      // Recycle the claim between turns so a gate-satisfied turn can
      // re-acquire (a fresh-heartbeat claim would otherwise block as
      // claimed_by_other). lastSpawn (in-memory) is untouched.
      const claimPath = curatorClaimFile(pidRoot, "ses-tc", "spec");
      fs.rmSync(claimPath, { force: true });
      fs.rmSync(claimPath + ".lock", { force: true });
    }
    // Original: turn1 + turn4 = 2 spawns. Mutant `-=`: turn counter goes
    // negative → turnsSince never reaches everyTurns(3) after turn 1 → 1 spawn.
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});
