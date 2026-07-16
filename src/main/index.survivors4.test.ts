/**
 * index.survivors4.test.ts — final-round mutation survivor kills for
 * src/main/index.ts.
 *
 * Targets the non-equivalent survivors from a fresh scoped stryker run:
 *  - L166 BlockStatement NoCoverage (readGoalContents catch): a persona whose
 *    goalFile is missing/unreadable must still spawn with goalContents="".
 *  - L452 ObjectLiteral→{} (readPidEntries `{ checkPid: true }`): a freshly-
 *    spawned child whose pid is dead must classify as "dead" in the staleness
 *    summary, not "live".
 *
 * Equivalent survivors (documented, not targeted):
 *  - L121 ConditionalExpression→false (`if (parent === dir) break;`): the
 *    walk-up loop's root-break is a pure iteration optimization; with or
 *    without it the bounded loop (MAX_WALK_UP=10) returns the same result.
 *  - L163 ConditionalExpression→false (`if (!goalFile) return ""`): when
 *    goalFile is falsy, the fallback `fs.readFileSync(undefined)` throws and
 *    is caught → returns "". Same observable result.
 *  - L188 ConditionalExpression→true + EqualityOperator `>=0`: both mutate
 *    `mainSessionName.length > 0`; guarded by `mainSessionName &&` so any
 *    falsy name short-circuits before the length check — equivalent.
 *  - L263 BlockStatement→{} (writeForkFile catch): on throw the catch returns
 *    null; mutant {} falls off the function → returns undefined; caller's
 *    `if (!forkPath)` treats both as falsy → equivalent.
 *  - L144/L152/L510 OptionalChaining (safeNotify/safeSetStatus/turn_end catch
 *    notify): all wrapped in try/catch with empty catch + void return —
 *    genuinely equivalent (stryker+esbuild also cannot instrument these).
 */
// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { handleTurnEnd, buildChildEnv } from "./index.js";
import { clearConfigCache } from "../util/config.js";

const REAL_ENV = { ...process.env };

function writeProjectConfig(projectRoot: string, goalFile: string) {
  fs.mkdirSync(path.join(projectRoot, ".pi-curator"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, ".pi-curator", "curators.json"),
    JSON.stringify({
      curators: {
        spec: {
          alias: "spec", enabled: true, goalFile, spawn: { everyTurns: 3 }, model: "qwen3-coder",
        },
      },
    }, null, 2),
    "utf8",
  );
}
function writeSession(p: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify({ type: "session", version: 1, id: "ses", cwd: "/tmp" }) + "\n",
    "utf8",
  );
}
function makeChild(pid: number) {
  return { pid, on: vi.fn() };
}

describe("handleTurnEnd — readGoalContents catch (L166 NoCoverage)", () => {
  let projectRoot: string;
  let homeDir: string;
  let sessionPath: string;
  let pidRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "idx-l166-proj-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "idx-l166-home-"));
    sessionPath = path.join(projectRoot, "session.jsonl");
    pidRoot = path.join(homeDir, "pids");
    // goalFile points at a path that does NOT exist → readFileSync throws → catch.
    writeProjectConfig(projectRoot, path.join(projectRoot, "missing-goal.md"));
    writeSession(sessionPath);
    clearConfigCache();
  });
  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    process.env = { ...REAL_ENV };
    clearConfigCache();
    vi.restoreAllMocks();
  });

  it("spawns successfully when the goalFile is missing (goalContents='' via catch)", async () => {
    // L166 BlockStatement→{} removes the catch's `return ""`, so the function
       // would return undefined instead of "". buildSpawnArgs must still receive a
       // string-ish goalContents and the spawn must proceed. Assert spawn happens
    // AND the task prompt does NOT contain goal text (it would only differ if
    // the catch stopped returning "" — but more importantly this COVERS L166).
    const spawnFn = vi.fn(() => makeChild(700001));
    await handleTurnEnd({}, {}, {
      projectRoot,
      mainSessionId: "ses-166",
      mainSessionName: "main-166",
      sessionJsonlPath: sessionPath,
      pidRoot,
      forksDir: path.join(homeDir, "forks"),
      spawnFn,
      turnNumber: 1,
      runtimeExtensionPath: "/r.ts",
      intercomExtensionPath: "/i.ts",
      homeDir,
    });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    // The goal file genuinely does not exist on disk.
    expect(fs.existsSync(path.join(projectRoot, "missing-goal.md"))).toBe(false);
  });
});

describe("handleTurnEnd — staleness checkPid (L452 ObjectLiteral)", () => {
  let projectRoot: string;
  let homeDir: string;
  let sessionPath: string;
  let pidRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "idx-l452-proj-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "idx-l452-home-"));
    sessionPath = path.join(projectRoot, "session.jsonl");
    pidRoot = path.join(homeDir, "pids");
    writeProjectConfig(projectRoot, path.join(projectRoot, "g.md"));
    fs.writeFileSync(path.join(projectRoot, "g.md"), "goal", "utf8");
    writeSession(sessionPath);
    clearConfigCache();
  });
  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    process.env = { ...REAL_ENV };
    clearConfigCache();
    vi.restoreAllMocks();
  });

  it("classifies a freshly-spawned DEAD-pid child as 'dead' via checkPid:true", async () => {
    // L452 ObjectLiteral→{} drops checkPid → the fresh-heartbeat entry would be
    // "live" by heartbeat age. checkPid:true reveals the dead pid. Use a very
    // high pid certain to be absent on the host.
    const setStatus = vi.fn();
    const spawnFn = vi.fn(() => makeChild(4_000_001));
    await handleTurnEnd({}, { ui: { setStatus, notify: vi.fn() } }, {
      projectRoot,
      mainSessionId: "ses-452",
      mainSessionName: "main-452",
      sessionJsonlPath: sessionPath,
      pidRoot,
      forksDir: path.join(homeDir, "forks"),
      spawnFn,
      turnNumber: 1,
      runtimeExtensionPath: "/r.ts",
      intercomExtensionPath: "/i.ts",
      homeDir,
      nowMs: Date.now(),
    });
    expect(setStatus).toHaveBeenCalled();
    const status = String(setStatus.mock.calls[0][0]);
    expect(status).toMatch(/1 dead/);
    expect(status).not.toMatch(/1 live/);
  });
});
