/**
 * slash-commands.survivors.test.ts — kills the large NoCoverage cluster in
 * src/main/slash-commands.ts by exercising the registerSlashCommands handler
 * dispatch (help/list/status/kill/restart/reload + error paths), which the
 * existing tests did not invoke.
 *
 * No process.chdir(); HOME redirected into a tmpdir so defaultPidRoot() and the
 * restart-marker dir stay isolated.
 */
// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { registerSlashCommands } from "./slash-commands.js";
import { clearConfigCache } from "../util/config.js";
import { defaultPidRoot, curatorClaimFile, writeCuratorClaim } from "../util/team-attach-claim.js";

const REAL_ENV = { ...process.env };

function writeConfig(projectRoot: string) {
  const dir = path.join(projectRoot, ".pi-curator");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "curators.json"),
    JSON.stringify(
      {
        curators: {
          spec: { alias: "spec", enabled: true, goalFile: path.join(projectRoot, "g.md"), spawn: { everyTurns: 3 }, model: "qwen3-coder" },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

describe("registerSlashCommands — handler dispatch", () => {
  let projectRoot: string;
  let homeDir: string;
  let pi: any;
  let handler: ((input: string, ctx?: any) => Promise<void>) | undefined;
  let notify: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slash-proj-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "slash-home-"));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    writeConfig(projectRoot);
    clearConfigCache();
    notify = vi.fn();
    handler = undefined;
    pi = {
      registerSlashCommand: vi.fn((_name: string, fn: any) => {
        handler = fn;
      }),
    };
    registerSlashCommands(pi, { ui: { notify } });
    expect(handler).toBeDefined();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    process.env = { ...REAL_ENV };
    clearConfigCache();
    vi.restoreAllMocks();
  });

  function ctx() {
    return { cwd: projectRoot, sessionId: "ses-slash", ui: { notify } };
  }

  it("registers a single 'curator' slash command", () => {
    expect(pi.registerSlashCommand).toHaveBeenCalledTimes(1);
    expect(pi.registerSlashCommand.mock.calls[0][0]).toBe("curator");
  });

  it("help: notifies the help text", async () => {
    await handler!("help", ctx());
    const m = notify.mock.calls.find((c) => typeof c[0] === "string" && /Commands:/.test(c[0]));
    expect(m).toBeTruthy();
    expect(m[1]).toBe("info");
  });

  it("list: notifies the persona list output", async () => {
    await handler!("list", ctx());
    const m = notify.mock.calls.find((c) => typeof c[0] === "string" && /Curator personas/.test(c[0]));
    expect(m).toBeTruthy();
    expect(m[0]).toContain("spec");
    expect(m[1]).toBe("info");
  });

  it("status: notifies the liveness status output", async () => {
    await handler!("status", ctx());
    const calls = notify.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => /Curator status|No curator registrations/.test(s))).toBe(true);
    const m = notify.mock.calls.find((c) => /Curator status|No curator registrations/.test(String(c[0])));
    expect(m[1]).toBe("info");
  });

  it("reload: clears the cache and notifies", async () => {
    await handler!("reload", ctx());
    const m = notify.mock.calls.find((c) => typeof c[0] === "string" && /config cache cleared/.test(c[0]));
    expect(m).toBeTruthy();
    expect(m[1]).toBe("info");
  });

  it("kill: notifies 'no claim found' when no claim exists for the alias", async () => {
    await handler!("kill ghost", ctx());
    const m = notify.mock.calls.find((c) => typeof c[0] === "string" && /no claim found for ghost/.test(c[0]));
    expect(m).toBeTruthy();
    expect(m[1]).toBe("info");
  });

  it("kill: notifies 'already dead' when the claim points at a dead pid", async () => {
    const pidRoot = defaultPidRoot();
    const claimPath = curatorClaimFile(pidRoot, "ses-slash", "spec");
    await writeCuratorClaim(claimPath, {
      pid: 999999,
      mainSessionId: "ses-slash",
      curator: "spec",
      spawnedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      phase: "scanning",
    });
    await handler!("kill spec", ctx());
    const m = notify.mock.calls.find((c) => /was already dead/.test(String(c[0])));
    expect(m).toBeTruthy();
  });

  it("restart: writes a restart marker and notifies the reason", async () => {
    await handler!("restart spec", ctx());
    const m = notify.mock.calls.find((c) => /spawn|gate reset|re-spawn/.test(String(c[0])));
    expect(m).toBeTruthy();
    expect(m[1]).toBe("info");
    // A restart-marker file must have been written (handler uses os.homedir()).
    const markerDir = path.join(os.homedir(), ".pi-curator", "restart-markers", "ses-slash");
    expect(fs.existsSync(path.join(markerDir, "spec.json"))).toBe(true);
  });

  it("invalid command: notifies the parse error", async () => {
    await handler!("bogus", ctx());
    const m = notify.mock.calls.find((c) => typeof c[0] === "string" && /unknown command/.test(c[0]));
    expect(m).toBeTruthy();
    expect(m[1]).toBe("error");
  });

  it("kill without alias: notifies a parse error", async () => {
    await handler!("kill", ctx());
    const m = notify.mock.calls.find((c) => typeof c[0] === "string" && /kill/i.test(c[0]) && c[1] === "error");
    expect(m).toBeTruthy();
  });

  it("does not throw when ctx is absent (uses the closure ctx)", async () => {
    // No slashCtx → falls back to the ctx passed at registration.
    await expect(handler!("help")).resolves.toBeUndefined();
  });

  it("does not crash the session when a handler sub-call throws (REQ-LC-10)", async () => {
    // A throwing `cwd` getter makes `effectiveCtx?.cwd` throw → outer catch →
    // '/curator handler crashed' notify (the handler must NOT propagate).
    const crashCtx = {
      get cwd() { throw new Error("cwd boom"); },
      sessionId: "ses-slash",
      ui: { notify },
    } as any;
    await expect(handler!("list", crashCtx)).resolves.toBeUndefined();
    const crash = notify.mock.calls.find((c) => /\/curator handler crashed/.test(String(c[0])));
    expect(crash).toBeTruthy();
    expect(crash[1]).toBe("error");
    expect(String(crash[0])).toContain("cwd boom");
  });

  it("default export registers the curator slash commands", async () => {
    const mod = await import("./slash-commands.js");
    const defPi: any = { registerSlashCommand: vi.fn() };
    expect(() => mod.default(defPi, { ui: { notify } })).not.toThrow();
    expect(defPi.registerSlashCommand).toHaveBeenCalledWith("curator", expect.any(Function));
  });
});
