/**
 * slash-commands.survivors3.test.ts — final-round mutation survivor kills for
 * src/main/slash-commands.ts.
 *
 * Targets the NON-equivalent survivors from a fresh scoped stryker run:
 *  - L212 ConditionalExpression→true (restart already_dead/no_claim branch):
 *    a SUCCESSFUL kill (action="killed") must report "re-spawn", not "not running".
 *  - L327 ObjectLiteral→{} (status `{ checkPid: true }`): a dead-pid entry must
 *    classify as "dead", not "live".
 *  - L357/L365 BlockStatement→{} + L366 ObjectLiteral→{} + L366 BooleanLiteral
 *    →false (restart resetSpawnCounter marker write): the marker file must be
 *    written with real alias/at contents, even when the parent dir is absent
 *    (recursive mkdir).
 *
 * NOTE on the OptionalChaining notify cluster (L305..L394): these are genuinely
 * equivalent under this stryker/vitest setup. Each `effectiveCtx?.ui?.notify?.()`
 * sits inside the handler try block; the `?.`-removal mutants only differ when
 * ctx/ui/notify is undefined, in which case they throw → caught by the outer
 * REQ-LC-10 crash-catch → which re-notifies via the SAME effectiveCtx (also a
 * no-op). Empirically verified: a probe test that fails the mutant under a
 * manual `sed` edit is NOT detected by stryker (a known stryker+esbuild
 * optional-chaining instrumentation quirk). Documented as equivalent.
 *
 * No process.chdir(); HOME + projectRoot isolated in tmpdirs.
 */
// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { registerSlashCommands } from "./slash-commands.js";
import { clearConfigCache } from "../util/config.js";
import {
  defaultPidRoot,
  curatorClaimFile,
  writeCuratorClaim,
} from "../util/team-attach-claim.js";

const REAL_ENV = { ...process.env };

function makeCtx(projectRoot: string, sessionId: string, notify: any) {
  return { cwd: projectRoot, sessionId, ui: { notify } };
}

describe("registerSlashCommands — restart SUCCESSFUL-kill branch (L212)", () => {
  let projectRoot: string;
  let homeDir: string;
  let notify: any;
  let killSpy: any;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sc-l212-proj-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-l212-home-"));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    fs.mkdirSync(path.join(projectRoot, ".pi-curator"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, ".pi-curator", "curators.json"),
      JSON.stringify({
        curators: { spec: { alias: "spec", enabled: true, spawn: { everyTurns: 3 } } },
      }, null, 2),
      "utf8",
    );
    clearConfigCache();
    notify = vi.fn();
    killSpy = vi.spyOn(process, "kill");
  });
  afterEach(() => {
    killSpy.mockRestore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    process.env = { ...REAL_ENV };
    clearConfigCache();
    vi.restoreAllMocks();
  });

  it("restart: a SUCCESSFUL kill reports 'will re-spawn on next turn_end' (not 'not running')", async () => {
    // L212 mutant `if (true)` would ALWAYS enter the already_dead/no_claim
    // branch and report "was not running". A real successful kill (action=killed)
    // MUST report "killed (pid N); will re-spawn".
    const pidRoot = defaultPidRoot();
    await writeCuratorClaim(curatorClaimFile(pidRoot, "ses-212", "spec"), {
      pid: 135791,
      mainSessionId: "ses-212",
      curator: "spec",
      spawnedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      phase: "scanning",
    });
    killSpy.mockImplementation(() => {}); // successful SIGTERM, no throw

    const holder: any = {};
    registerSlashCommands(
      { registerSlashCommand: vi.fn((_n, fn) => (holder.fn = fn)) } as any,
      { ui: { notify } },
    );
    await holder.fn("restart spec", makeCtx(projectRoot, "ses-212", notify));

    const respawn = notify.mock.calls.find((c: any[]) =>
      /will re-spawn on next turn_end/.test(String(c[0])),
    );
    expect(respawn).toBeTruthy();
    expect(respawn[0]).toContain("135791");
    // The mutant would instead emit the "was not running" reason.
    const notRunning = notify.mock.calls.find((c: any[]) =>
      /was not running/.test(String(c[0])),
    );
    expect(notRunning).toBeUndefined();
  });
});

describe("registerSlashCommands — status checkPid object (L327)", () => {
  let projectRoot: string;
  let homeDir: string;
  let notify: any;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sc-l327-proj-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-l327-home-"));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    fs.mkdirSync(path.join(projectRoot, ".pi-curator"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, ".pi-curator", "curators.json"),
      JSON.stringify({
        curators: { spec: { alias: "spec", enabled: true, spawn: { everyTurns: 3 } } },
      }, null, 2),
      "utf8",
    );
    clearConfigCache();
    notify = vi.fn();
  });
  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    process.env = { ...REAL_ENV };
    clearConfigCache();
    vi.restoreAllMocks();
  });

  it("status: a fresh-heartbeat entry with a DEAD pid classifies as 'dead' (checkPid:true)", async () => {
    // L327 ObjectLiteral→{} drops checkPid → the fresh-heartbeat entry would be
    // classified "live" by heartbeat age alone. checkPid:true reveals the dead
    // pid. Assert the per-entry line shows "dead" and the summary "1 dead"/"0 live".
    const pidRoot = defaultPidRoot();
    await writeCuratorClaim(curatorClaimFile(pidRoot, "ses-327", "spec"), {
      pid: 888888, // nonexistent pid → not alive
      mainSessionId: "ses-327",
      curator: "spec",
      spawnedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(), // fresh heartbeat
      phase: "scanning",
    });

    const holder: any = {};
    registerSlashCommands(
      { registerSlashCommand: vi.fn((_n, fn) => (holder.fn = fn)) } as any,
      { ui: { notify } },
    );
    await holder.fn("status", makeCtx(projectRoot, "ses-327", notify));

    const status = notify.mock.calls.find((c: any[]) =>
      /Curator status/.test(String(c[0])),
    );
    expect(status).toBeTruthy();
    const text = String(status[0]);
    expect(text).toContain("1 dead");
    expect(text).toContain("0 live");
    expect(text).toMatch(/spec\s+pid=888888\s+dead/);
  });
});

describe("registerSlashCommands — restart marker write block (L357/L365/L366)", () => {
  let projectRoot: string;
  let homeDir: string;
  let notify: any;
  let killSpy: any;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sc-l357-proj-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-l357-home-"));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    fs.mkdirSync(path.join(projectRoot, ".pi-curator"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, ".pi-curator", "curators.json"),
      JSON.stringify({
        curators: { spec: { alias: "spec", enabled: true, spawn: { everyTurns: 3 } } },
      }, null, 2),
      "utf8",
    );
    clearConfigCache();
    notify = vi.fn();
    killSpy = vi.spyOn(process, "kill");
  });
  afterEach(() => {
    killSpy.mockRestore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    process.env = { ...REAL_ENV };
    clearConfigCache();
    vi.restoreAllMocks();
  });

  it("restart: writes a marker file with real alias/at contents (L365/L366)", async () => {
    // L365 BlockStatement→{} empties the mkdir/writeFile block → no marker.
    // L366 ObjectLiteral→{} writes "{}" instead of {alias, at}.
    // Assert the marker exists AND carries real alias/at fields.
    const holder: any = {};
    registerSlashCommands(
      { registerSlashCommand: vi.fn((_n, fn) => (holder.fn = fn)) } as any,
      { ui: { notify } },
    );
    await holder.fn("restart spec", makeCtx(projectRoot, "ses-357", notify));

    const markerDir = path.join(os.homedir(), ".pi-curator", "restart-markers", "ses-357");
    const markerPath = path.join(markerDir, "spec.json");
    expect(fs.existsSync(markerPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    expect(parsed.alias).toBe("spec");
    expect(typeof parsed.at).toBe("number");
  });

  it("restart: marker write uses recursive mkdir (parent dir absent) (L366 recursive)", async () => {
    // L366 BooleanLiteral recursive:false would make mkdirSync fail when the
    // restart-markers/<session>/ parent doesn't exist → marker absent (caught).
    // The homeDir is fresh, so the parent chain definitely doesn't pre-exist.
    const holder: any = {};
    registerSlashCommands(
      { registerSlashCommand: vi.fn((_n, fn) => (holder.fn = fn)) } as any,
      { ui: { notify } },
    );
    await holder.fn("restart spec", makeCtx(projectRoot, "ses-rec", notify));

    const markerPath = path.join(
      os.homedir(), ".pi-curator", "restart-markers", "ses-rec", "spec.json",
    );
    expect(fs.existsSync(markerPath)).toBe(true);
  });

  it("restart: invokes resetSpawnCounter callback (L357 block)", async () => {
    // L357 BlockStatement→{} empties the entire resetSpawnCounter callback body
    // → no marker written. Assert the marker exists (callback ran).
    const holder: any = {};
    registerSlashCommands(
      { registerSlashCommand: vi.fn((_n, fn) => (holder.fn = fn)) } as any,
      { ui: { notify } },
    );
    await holder.fn("restart spec", makeCtx(projectRoot, "ses-cb", notify));
    const markerPath = path.join(
      os.homedir(), ".pi-curator", "restart-markers", "ses-cb", "spec.json",
    );
    expect(fs.existsSync(markerPath)).toBe(true);
  });
});
