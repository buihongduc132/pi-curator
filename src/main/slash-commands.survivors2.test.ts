/**
 * slash-commands.survivors2.test.ts — FINAL mutation survivor remediation for
 * src/main/slash-commands.ts.
 *
 * Targets the surviving mutant clusters identified by a fresh scoped stryker
 * run (74.88% → target ≥95%):
 *
 *  1. killCurator ESRCH-guard logical/conditional mutants (L163).
 *  2. restartCurator resetSpawnCounter + already_dead/no_claim branch (L200/L212).
 *  3. formatListOutput goalFile `??` + spawn optional-chaining (L236/L242/L243).
 *  4. formatStatusOutput ageMs division (L259).
 *  5. registerSlashCommands dispatch: the `pi.registerSlashCommand?.` guard
 *     (L300), the `effectiveCtx?.cwd/sessionId/session` chains (L309/L311),
 *     and the dense `effectiveCtx?.ui?.notify?.(...)` optional-chaining
 *     cluster at every notify call site (L305/L315/L320/L328/L336/L345/
 *     L378/L381/L387). Each `?.` removal is killed by exercising the call
 *     site with effectiveCtx undefined, with ui undefined, and with notify
 *     undefined — under each mutant one of those throws, tripping the outer
 *     REQ-LC-10 crash-catch; the original no-ops. We assert NO crash notify.
 *  6. kill/restart error-result branches (L335/L337/L336/L377/L378) + the
 *     kill-success message ternary (L340).
 *  7. status `{ checkPid: true }` object/boolean mutants (L327).
 *  8. restart resetSpawnCounter marker-writing block + mkdir recursive +
 *     JSON.stringify object (L357/L365/L366/L369).
 *
 * Equivalent (unkillable) mutants are documented in the final PR report:
 *  - L212 whole-condition `→ true` (action is always already_dead/no_claim).
 *  - L394 crash-catch notify optional-chaining ×3 (inner try/catch swallows).
 *  - L220 defensive `return { ok:false }` ×2 (unreachable — killCurator never
 *    returns an unhandled ok:true action).
 *
 * No process.chdir(); HOME + projectRoot isolated in tmpdirs.
 */
// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  parseCommand,
  formatListOutput,
  formatStatusOutput,
  registerSlashCommands,
  killCurator,
  restartCurator,
} from "./slash-commands.js";
import { clearConfigCache } from "../util/config.js";
import {
  defaultPidRoot,
  curatorClaimFile,
  writeCuratorClaim,
} from "../util/team-attach-claim.js";
import type { MergedCuratorConfig, ResolvedPersona } from "../util/config.js";
import type { StalePidEntry } from "../util/staleness.js";

const REAL_ENV = { ...process.env };

function makePersona(alias: string, overrides: Partial<ResolvedPersona> = {}): ResolvedPersona {
  return {
    alias,
    enabled: true,
    goalFile: `/goals/${alias}.md`,
    taskPrompt: undefined,
    model: undefined,
    scope: "main-only",
    spawn: {},
    includeThinking: false,
    contextBudget: undefined,
    excludeTools: undefined,
    tools: undefined,
    appendDisplay: false,
    heartbeat: { intervalSec: 5, staleSec: 30, deadSec: 120 },
    ...overrides,
  } as unknown as ResolvedPersona;
}

// ─── Pure-helper survivors ───────────────────────────────────────────────────

describe("killCurator — ESRCH guard (L163)", () => {
  let pidRoot: string;
  beforeEach(() => {
    pidRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kill-esrch-"));
  });
  afterEach(() => fs.rmSync(pidRoot, { recursive: true, force: true }));

  it("treats a non-Error throw with code=ESRCH as a hard error (not already_dead)", async () => {
    // Distinguishes `&&` from `||` and the inner conditional mutants: a plain
    // object (not an Error) with code "ESRCH" must NOT be classified as
    // already_dead — it falls through to the error return.
    await writeCuratorClaim(curatorClaimFile(pidRoot, "s1", "spec"), {
      pid: 4242,
      mainSessionId: "s1",
      curator: "spec",
      spawnedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      phase: "scanning",
    });
    const r = await killCurator("spec", {
      pidRoot,
      mainSessionId: "s1",
      kill: () => {
        // Plain object — NOT an Error instance, but carries code "ESRCH".
        throw { code: "ESRCH", message: "x" } as unknown as Error;
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("SIGTERM failed");
  });

  it("treats an Error with a non-ESRCH code as a hard error", async () => {
    // Distinguishes the `(err as any).code === "ESRCH"` → true mutant: an
    // actual Error WITH a code property that is NOT ESRCH must error, not
    // already_dead.
    await writeCuratorClaim(curatorClaimFile(pidRoot, "s1", "spec"), {
      pid: 4242,
      mainSessionId: "s1",
      curator: "spec",
      spawnedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      phase: "scanning",
    });
    const r = await killCurator("spec", {
      pidRoot,
      mainSessionId: "s1",
      kill: () => {
        const e = new Error("nope");
        (e as Error & { code: string }).code = "EPERM";
        throw e;
      },
    });
    // The ok:false return itself kills the `code === "ESRCH" → true` mutant
    // (which would wrongly return already_dead / ok:true).
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("SIGTERM failed");
  });
});

describe("restartCurator — resetSpawnCounter guard + already_dead branch", () => {
  let pidRoot: string;
  beforeEach(() => {
    pidRoot = fs.mkdtempSync(path.join(os.tmpdir(), "restart-br-"));
  });
  afterEach(() => fs.rmSync(pidRoot, { recursive: true, force: true }));

  it("resolves without calling resetSpawnCounter when none is provided (L200)", async () => {
    // Mutant `if (true)` would invoke undefined → TypeError. Original skips.
    const r = await restartCurator("ghost", {
      pidRoot,
      mainSessionId: "s1",
      kill: () => {},
      // no resetSpawnCounter
    });
    expect(r.ok).toBe(true);
  });

  it("returns killed_only with 'not running' reason for an already-dead curator (L212)", async () => {
    // Distinguishes `!== "already_dead"` and `if (false)` mutants: an
    // already_dead killResult must enter the killed_only branch (ok:true),
    // not fall through to the defensive error return.
    await writeCuratorClaim(curatorClaimFile(pidRoot, "s1", "spec"), {
      pid: 999999,
      mainSessionId: "s1",
      curator: "spec",
      spawnedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      phase: "scanning",
    });
    const r = await restartCurator("spec", {
      pidRoot,
      mainSessionId: "s1",
      kill: () => {
        const e = new Error("esrch");
        (e as Error & { code: string }).code = "ESRCH";
        throw e;
      },
      resetSpawnCounter: () => {},
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.action).toBe("killed_only");
      expect(r.reason).toContain("not running");
    }
  });
});

describe("formatListOutput — goalFile + spawn optional-chaining", () => {
  it("renders the real goalFile path, not '(none)' (L236)", () => {
    // Mutant changes `??` to `&&`: a truthy goalFile would render "(none)".
    const cfg = {
      curators: { spec: makePersona("spec", { goalFile: "/goals/SPEC.md" }) },
    } as unknown as MergedCuratorConfig;
    const out = formatListOutput(cfg);
    expect(out).toContain("/goals/SPEC.md");
    expect(out).not.toMatch(/\(none\)/);
  });

  it("does not throw when persona.spawn is undefined (L242/L243)", () => {
    // Mutants remove `?.` → `p.spawn.everyTurns` throws when spawn undefined.
    const cfg = {
      curators: { bare: makePersona("bare", { spawn: undefined as unknown as ResolvedPersona["spawn"] }) },
    } as unknown as MergedCuratorConfig;
    const out = formatListOutput(cfg);
    expect(out).toContain("no gate");
  });
});

describe("formatStatusOutput — ageMs division (L259)", () => {
  it("renders age in seconds (ageMs / 1000), not multiplied", () => {
    const entries: StalePidEntry[] = [
      {
        pid: 1,
        mainSessionId: "s",
        curator: "spec",
        spawnedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        phase: "scanning",
        liveness: "live",
        ageMs: 2500,
      } as StalePidEntry,
    ];
    const out = formatStatusOutput(entries);
    expect(out).toContain("age=2.5s");
    expect(out).not.toContain("2500");
  });
});

// ─── registerSlashCommands — pi.registerSlashCommand?. guard (L300) ──────────

describe("registerSlashCommands — pi guard", () => {
  it("does not throw when pi has no registerSlashCommand method (L300)", () => {
    // Mutant `pi.registerSlashCommand(...)` would throw on undefined method.
    expect(() => registerSlashCommands({} as any, undefined)).not.toThrow();
  });
});

// ─── registerSlashCommands — effectiveCtx optional-chaining matrix ──────────
//
// For every notify call site, the three `?.` removal mutants are killed by
// exercising the site with three slashCtx shapes. Under each mutant one shape
// throws synchronously inside the try, tripping the REQ-LC-10 crash-catch
// ("/curator handler crashed"); the original no-ops. We assert NO crash.

describe("registerSlashCommands — effectiveCtx optional-chaining matrix", () => {
  let projectRoot: string;
  let homeDir: string;
  let notify: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slash-mtx-proj-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "slash-mtx-home-"));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    // Write a project config so `list`/`restart` resolve a persona.
    fs.mkdirSync(path.join(projectRoot, ".pi-curator"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, ".pi-curator", "curators.json"),
      JSON.stringify(
        { curators: { spec: { alias: "spec", enabled: true, goalFile: path.join(projectRoot, "g.md"), spawn: { everyTurns: 3 } } } },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(path.join(projectRoot, "g.md"), "goal", "utf8");
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

  // Build a fresh handler capturing into `holder.fn`. When closureCtx is
  // undefined, effectiveCtx = slashCtx (allows testing effectiveCtx=undefined).
  function captureHandler(closureCtx?: any) {
    const holder: { fn?: (input: string, slashCtx?: any) => Promise<void> } = {};
    const pi = {
      registerSlashCommand: vi.fn((_n: string, fn: any) => {
        holder.fn = fn;
      }),
    };
    registerSlashCommands(pi, closureCtx);
    return holder;
  }

  type Variant = { name: string; slashCtx: any; closureCtx?: any };
  // Three shapes that must NOT crash under the original (each kills a
  // different `?.` removal mutant at every notify site reached).
  const variants: Variant[] = [
    { name: "effectiveCtx=undefined", slashCtx: undefined, closureCtx: undefined },
    { name: "ui=undefined", slashCtx: {} },
    { name: "notify=undefined", slashCtx: { ui: {} } },
  ];

  // A fully-populated ctx used to confirm the path actually reaches its notify
  // (so the line is "covered" and the mutants become killable, not NoCoverage).
  const fullCtx = () => ({ cwd: projectRoot, sessionId: "ses-mtx", ui: { notify } });

  // Each case: [label, input, setup?]. `setup` runs before each invocation so
  // the command reaches its PRIMARY notify site with the full ctx.
  const cases: Array<{ label: string; input: string; site: RegExp }> = [
    { label: "parse-error → L305", input: "bogus", site: /unknown command/ },
    { label: "help → L315", input: "help", site: /Commands:/ },
    { label: "list → L320", input: "list", site: /Curator personas/ },
    { label: "status → L328", input: "status", site: /Curator status|No curator registrations/ },
    { label: "reload → L387", input: "reload", site: /config cache cleared/ },
    { label: "kill no_claim → L345", input: "kill ghost", site: /no claim found/ },
    { label: "restart no_claim → L381", input: "restart spec", site: /spawn|gate reset|re-spawn/ },
  ];

  for (const c of cases) {
    describe(`${c.label}`, () => {
      it("reaches its notify site with a full ctx (coverage)", async () => {
        const holder = captureHandler({ ui: { notify } });
        await holder.fn!(c.input, fullCtx());
        expect(notify.mock.calls.some((call) => c.site.test(String(call[0])))).toBe(true);
      });

      for (const v of variants) {
        it(`does not crash when ${v.name}`, async () => {
          const holder = captureHandler(v.closureCtx);
          await expect(holder.fn!(c.input, v.slashCtx)).resolves.toBeUndefined();
          const crash = notify.mock.calls.find((call) =>
            /\/curator handler crashed/.test(String(call[0])),
          );
          expect(crash).toBeUndefined();
        });
      }
    });
  }
});

// ─── kill/restart error branches + kill-success message ─────────────────────

describe("registerSlashCommands — restart marker survives ctx-deficient dispatch (L309/L311)", () => {
  // L309/L311 sit BEFORE the switch. Under their `?.`-removal mutants they
  // throw when effectiveCtx is undefined / session is undefined, aborting the
  // switch BEFORE resetSpawnCounter writes the restart marker. The marker's
  // (non-)existence is a positive side-effect that distinguishes original
  // (marker written) from mutant (no marker) — unlike the "no crash" assert,
  // which the L394 crash-catch masks.
  let projectRoot: string;
  let homeDir: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slash-l309-proj-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "slash-l309-home-"));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    fs.mkdirSync(path.join(projectRoot, ".pi-curator"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, ".pi-curator", "curators.json"),
      JSON.stringify({ curators: { spec: { alias: "spec", enabled: true, spawn: { everyTurns: 3 } } } }, null, 2),
      "utf8",
    );
    clearConfigCache();
  });
  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    process.env = { ...REAL_ENV };
    clearConfigCache();
    vi.restoreAllMocks();
  });

  function captureHandler() {
    const holder: { fn?: (i: string, c?: any) => Promise<void> } = {};
    registerSlashCommands({ registerSlashCommand: vi.fn((_n, fn) => (holder.fn = fn)) } as any);
    return holder.fn!;
  }

  it("writes the restart marker even when effectiveCtx is undefined (kills L309 + L311 effectiveCtx? mutants)", async () => {
    await captureHandler()("restart spec", undefined);
    const markerDir = path.join(os.homedir(), ".pi-curator", "restart-markers", `pid-${process.pid}`);
    expect(fs.existsSync(path.join(markerDir, "spec.json"))).toBe(true);
  });

  it("writes the restart marker when ctx has cwd but no session (kills L311 session? mutant)", async () => {
    await captureHandler()("restart spec", { cwd: projectRoot });
    const markerDir = path.join(os.homedir(), ".pi-curator", "restart-markers", `pid-${process.pid}`);
    expect(fs.existsSync(path.join(markerDir, "spec.json"))).toBe(true);
  });
});

// ─── kill/restart error branches + kill-success message ─────────────────────

describe("registerSlashCommands — kill/restart error + success branches", () => {
  let projectRoot: string;
  let homeDir: string;
  let notify: ReturnType<typeof vi.fn>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slash-err-proj-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "slash-err-home-"));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    fs.mkdirSync(path.join(projectRoot, ".pi-curator"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, ".pi-curator", "curators.json"),
      JSON.stringify({ curators: { spec: { alias: "spec", enabled: true, spawn: { everyTurns: 3 } } } }, null, 2),
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

  function handler() {
    const holder: { fn?: (i: string, c?: any) => Promise<void> } = {};
    registerSlashCommands({ registerSlashCommand: vi.fn((_n, fn) => (holder.fn = fn)) } as any, {
      ui: { notify },
    });
    return holder.fn!;
  }
  function ctx() {
    return { cwd: projectRoot, sessionId: "ses-err", ui: { notify } };
  }

  it("kill: notifies the SIGTERM-failed error and returns (L335/L336/L337)", async () => {
    // Write a live claim so killCurator reaches process.kill, which we make
    // throw EPERM (non-ESRCH) → result.ok=false → error branch.
    const pidRoot = defaultPidRoot();
    await writeCuratorClaim(curatorClaimFile(pidRoot, "ses-err", "spec"), {
      pid: 777777,
      mainSessionId: "ses-err",
      curator: "spec",
      spawnedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      phase: "scanning",
    });
    killSpy.mockImplementation(() => {
      const e = new Error("EPERM");
      (e as Error & { code: string }).code = "EPERM";
      throw e;
    });
    await handler()("kill spec", ctx());
    const err = notify.mock.calls.find((c) => /SIGTERM failed/.test(String(c[0])));
    expect(err).toBeTruthy();
    expect(err[1]).toBe("error");
    // Mutants that skip the error block (L335/L337) would instead notify the
    // "no claim found" info message — assert it is NOT present.
    const noClaim = notify.mock.calls.find((c) => /no claim found/.test(String(c[0])));
    expect(noClaim).toBeUndefined();
  });

  it("restart: notifies the SIGTERM-failed error (L377/L378)", async () => {
    const pidRoot = defaultPidRoot();
    await writeCuratorClaim(curatorClaimFile(pidRoot, "ses-err", "spec"), {
      pid: 777778,
      mainSessionId: "ses-err",
      curator: "spec",
      spawnedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      phase: "scanning",
    });
    killSpy.mockImplementation(() => {
      const e = new Error("EPERM");
      (e as Error & { code: string }).code = "EPERM";
      throw e;
    });
    await handler()("restart spec", ctx());
    const err = notify.mock.calls.find((c) => /SIGTERM failed/.test(String(c[0])));
    expect(err).toBeTruthy();
    expect(err[1]).toBe("error");
  });

  it("kill: success message says 'killed (pid N)' for a successful SIGTERM (L340)", async () => {
    // Mutant `result.action === "killed"` → false would render "already dead"
    // / "no claim" instead. A successful kill must say "killed (pid".
    const pidRoot = defaultPidRoot();
    await writeCuratorClaim(curatorClaimFile(pidRoot, "ses-err", "spec"), {
      pid: 777779,
      mainSessionId: "ses-err",
      curator: "spec",
      spawnedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      phase: "scanning",
    });
    killSpy.mockImplementation(() => {}); // success — no throw
    await handler()("kill spec", ctx());
    const msg = notify.mock.calls.find((c) => /killed \(pid/.test(String(c[0])));
    expect(msg).toBeTruthy();
    expect(msg[0]).toContain("777779");
    expect(msg[1]).toBe("info");
  });
});

// ─── status checkPid + restart marker block ─────────────────────────────────

describe("registerSlashCommands — status checkPid + restart marker", () => {
  let projectRoot: string;
  let homeDir: string;
  let notify: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slash-st-proj-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "slash-st-home-"));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    fs.mkdirSync(path.join(projectRoot, ".pi-curator"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, ".pi-curator", "curators.json"),
      JSON.stringify({ curators: { spec: { alias: "spec", enabled: true, spawn: { everyTurns: 3 } } } }, null, 2),
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

  function handler() {
    const holder: { fn?: (i: string, c?: any) => Promise<void> } = {};
    registerSlashCommands({ registerSlashCommand: vi.fn((_n, fn) => (holder.fn = fn)) } as any, {
      ui: { notify },
    });
    return holder.fn!;
  }
  function ctx() {
    return { cwd: projectRoot, sessionId: "ses-st", ui: { notify } };
  }

  it("status: classifies a stale-pid claim as 'dead' via checkPid:true (L327)", async () => {
    // Mutants {} and checkPid:false would skip the pid liveness check → a
    // recent-heartbeat entry renders "live" instead of "dead".
    const pidRoot = defaultPidRoot();
    await writeCuratorClaim(curatorClaimFile(pidRoot, "ses-st", "spec"), {
      pid: 999999, // nonexistent → isPidAlive false → dead (with checkPid)
      mainSessionId: "ses-st",
      curator: "spec",
      spawnedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(), // fresh heartbeat
      phase: "scanning",
    });
    await handler()("status", ctx());
    const status = notify.mock.calls.find((c) => /Curator status/.test(String(c[0])));
    expect(status).toBeTruthy();
    const text = String(status[0]);
    // checkPid:true must classify the nonexistent pid as dead. Mutants that
    // drop checkPid would render the fresh-heartbeat entry as live.
    expect(text).toContain("1 dead");
    expect(text).toContain("0 live");
    // The per-entry line (not the summary) must carry the dead classification.
    expect(text).toMatch(/spec\s+pid=999999\s+dead/);
  });

  it("restart: writes a marker file with alias/at and uses recursive mkdir (L357/L365/L366/L369)", async () => {
    await handler()("restart spec", ctx());
    const markerDir = path.join(os.homedir(), ".pi-curator", "restart-markers", "ses-st");
    const markerPath = path.join(markerDir, "spec.json");
    expect(fs.existsSync(markerPath)).toBe(true);
    // Mutant JSON.stringify({}) would write "{}"; assert real contents.
    const parsed = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    expect(parsed.alias).toBe("spec");
    expect(typeof parsed.at).toBe("number");
  });
});
