/**
 * slash-commands.test.ts — unit tests for `/curator` slash command parsing +
 * behavioral helpers (REQ-LC-09).
 *
 * Covers:
 *   - parseCommand: valid commands, unknown commands, alias validation,
 *     argument count requirements, empty input.
 *   - formatListOutput: empty + populated personas.
 *   - formatStatusOutput: empty + populated entries.
 *   - formatHelp: stable shape.
 *   - killCurator: kill / already_dead / no_claim / error paths.
 *   - restartCurator: kill + counter reset.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  parseCommand,
  formatListOutput,
  formatStatusOutput,
  formatHelp,
  killCurator,
  restartCurator,
  VALID_COMMANDS,
  REQUIRES_ALIAS,
  NO_ARGS,
} from "./slash-commands.js";
import {
  writeCuratorClaim,
  defaultPidRoot,
  curatorClaimFile,
  type CuratorClaim,
} from "../util/team-attach-claim.js";
import type { MergedCuratorConfig, ResolvedPersona } from "../util/config.js";
import type { StalePidEntry } from "../util/staleness.js";

// ─── Test helpers ───────────────────────────────────────────────────────────

function makeClaim(overrides: Partial<CuratorClaim> = {}): CuratorClaim {
  return {
    pid: 99999,
    mainSessionId: "sess-1",
    curator: "spec",
    spawnedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    phase: "scanning",
    ...overrides,
  };
}

function tmpPidRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "curator-slash-"));
}

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

// ─── parseCommand ───────────────────────────────────────────────────────────

describe("parseCommand", () => {
  describe("valid commands", () => {
    it("parses 'list'", () => {
      const r = parseCommand("list");
      expect(r).toEqual({ ok: true, cmd: "list", args: [] });
    });

    it("parses 'status'", () => {
      const r = parseCommand("status");
      expect(r).toEqual({ ok: true, cmd: "status", args: [] });
    });

    it("parses 'reload'", () => {
      const r = parseCommand("reload");
      expect(r).toEqual({ ok: true, cmd: "reload", args: [] });
    });

    it("parses 'help'", () => {
      const r = parseCommand("help");
      expect(r).toEqual({ ok: true, cmd: "help", args: [] });
    });

    it("is case-insensitive for the command", () => {
      expect(parseCommand("LIST")).toEqual({ ok: true, cmd: "list", args: [] });
      expect(parseCommand("Status")).toEqual({ ok: true, cmd: "status", args: [] });
      expect(parseCommand("RELOAD")).toEqual({ ok: true, cmd: "reload", args: [] });
    });

    it("parses 'kill <alias>'", () => {
      const r = parseCommand("kill spec");
      expect(r).toEqual({ ok: true, cmd: "kill", args: ["spec"] });
    });

    it("parses 'restart <alias>'", () => {
      const r = parseCommand("restart scold");
      expect(r).toEqual({ ok: true, cmd: "restart", args: ["scold"] });
    });

    it("parses alias with hyphens", () => {
      const r = parseCommand("kill security-audit");
      expect(r).toEqual({ ok: true, cmd: "kill", args: ["security-audit"] });
    });

    it("parses alias with underscores", () => {
      const r = parseCommand("kill lessons_learned");
      expect(r).toEqual({ ok: true, cmd: "kill", args: ["lessons_learned"] });
    });

    it("parses alias starting with a digit", () => {
      const r = parseCommand("kill 1st-checker");
      expect(r).toEqual({ ok: true, cmd: "kill", args: ["1st-checker"] });
    });
  });

  describe("empty / whitespace", () => {
    it("empty string → help", () => {
      expect(parseCommand("")).toEqual({ ok: true, cmd: "help", args: [] });
    });

    it("whitespace-only → help", () => {
      expect(parseCommand("   \t  ")).toEqual({ ok: true, cmd: "help", args: [] });
    });

    it("null/undefined input → help", () => {
      expect(parseCommand(null as unknown as string)).toEqual({ ok: true, cmd: "help", args: [] });
      expect(parseCommand(undefined as unknown as string)).toEqual({ ok: true, cmd: "help", args: [] });
    });
  });

  describe("unknown commands", () => {
    it("rejects unknown command", () => {
      const r = parseCommand("frobnicate");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain("unknown command");
        expect(r.error).toContain("frobnicate");
      }
    });

    it("lists valid commands in the error", () => {
      const r = parseCommand("xyz");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        for (const c of VALID_COMMANDS) {
          expect(r.error).toContain(c);
        }
      }
    });
  });

  describe("argument validation", () => {
    it("'kill' with no alias → error", () => {
      const r = parseCommand("kill");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("requires a curator alias");
    });

    it("'restart' with no alias → error", () => {
      const r = parseCommand("restart");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("requires a curator alias");
    });

    it("'kill' with invalid alias (special chars) → error", () => {
      // The parser tokenizes on whitespace; the alias is the FIRST token
      // after the command. A token with special chars is rejected.
      const r = parseCommand("kill bad!");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("invalid alias");
    });

    it("'kill' with alias containing spaces → only first token is the alias", () => {
      // The parser tokenizes; the alias is the first token. The second token
      // is ignored (REQUIRES_ALIAS uses args[0]). This is intentional —
      // `/curator kill spec now` means "kill spec".
      const r = parseCommand("kill spec now");
      expect(r).toEqual({ ok: true, cmd: "kill", args: ["spec"] });
    });

    it("'kill' with empty alias after split → error", () => {
      const r = parseCommand("kill ");
      // After trim, "kill" has no second token.
      const r2 = parseCommand("kill");
      expect(r.ok).toBe(r2.ok);
    });

    it("no-args commands ignore extra args", () => {
      expect(parseCommand("list extra args here")).toEqual({
        ok: true,
        cmd: "list",
        args: [],
      });
      expect(parseCommand("status now")).toEqual({
        ok: true,
        cmd: "status",
        args: [],
      });
    });
  });

  describe("command classification", () => {
    it("REQUIRES_ALIAS contains kill + restart", () => {
      expect(REQUIRES_ALIAS).toContain("kill");
      expect(REQUIRES_ALIAS).toContain("restart");
      expect(REQUIRES_ALIAS).not.toContain("list");
    });

    it("NO_ARGS contains list, status, reload, help", () => {
      expect(NO_ARGS).toContain("list");
      expect(NO_ARGS).toContain("status");
      expect(NO_ARGS).toContain("reload");
      expect(NO_ARGS).toContain("help");
    });

    it("VALID_COMMANDS includes all commands", () => {
      expect(VALID_COMMANDS).toHaveLength(6);
      for (const c of ["list", "status", "kill", "restart", "reload", "help"]) {
        expect(VALID_COMMANDS).toContain(c);
      }
    });
  });
});

// ─── formatListOutput ───────────────────────────────────────────────────────

describe("formatListOutput", () => {
  it("returns a 'no personas' message when empty", () => {
    const config = { curators: {} } as unknown as MergedCuratorConfig;
    const out = formatListOutput(config);
    expect(out).toContain("No enabled curator personas");
  });

  it("lists personas with alias + gate + model", () => {
    const config = {
      curators: {
        spec: makePersona("spec", { spawn: { everyTurns: 3, everyMins: undefined } }),
        scold: makePersona("scold", { spawn: { everyMins: 10, everyTurns: undefined }, model: "cheap-model" }),
      },
    } as unknown as MergedCuratorConfig;
    const out = formatListOutput(config);
    expect(out).toContain("spec");
    expect(out).toContain("every 3 turns");
    expect(out).toContain("scold");
    expect(out).toContain("every 10m");
    expect(out).toContain("cheap-model");
    expect(out).toContain("2 enabled");
  });

  it("shows 'no gate' when persona has no spawn config", () => {
    const config = {
      curators: { bare: makePersona("bare", { spawn: {} }) },
    } as unknown as MergedCuratorConfig;
    const out = formatListOutput(config);
    expect(out).toContain("no gate");
  });

  it("shows main's model placeholder when model undefined", () => {
    const config = {
      curators: { spec: makePersona("spec") },
    } as unknown as MergedCuratorConfig;
    const out = formatListOutput(config);
    expect(out).toContain("(main's model)");
  });
});

// ─── formatStatusOutput ─────────────────────────────────────────────────────

describe("formatStatusOutput", () => {
  it("returns a 'no registrations' message when empty", () => {
    const out = formatStatusOutput([]);
    expect(out).toContain("No curator registrations");
  });

  it("formats entries with pid + liveness + age + phase", () => {
    const entries: StalePidEntry[] = [
      {
        ...makeClaim({ curator: "spec", pid: 12345, phase: "scanning" }),
        liveness: "live",
        ageMs: 5000,
      },
    ];
    const out = formatStatusOutput(entries);
    expect(out).toContain("spec");
    expect(out).toContain("pid=12345");
    expect(out).toContain("live");
    expect(out).toContain("phase=scanning");
    expect(out).toContain("1 live");
  });
});

// ─── formatHelp ─────────────────────────────────────────────────────────────

describe("formatHelp", () => {
  it("lists all commands", () => {
    const out = formatHelp();
    for (const c of ["list", "status", "kill", "restart", "reload", "help"]) {
      expect(out).toContain(c);
    }
    expect(out).toContain("Usage: /curator");
  });
});

// ─── killCurator ────────────────────────────────────────────────────────────

describe("killCurator", () => {
  it("returns 'no_claim' when the alias has no claim file", async () => {
    const pidRoot = tmpPidRoot();
    const r = await killCurator("ghost", {
      pidRoot,
      mainSessionId: "sess-1",
      kill: () => {}, // never called
    });
    expect(r).toEqual({ ok: true, action: "no_claim", alias: "ghost" });
  });

  it("SIGTERMs the process + marks phase 'killed'", async () => {
    const pidRoot = tmpPidRoot();
    const claimPath = curatorClaimFile(pidRoot, "sess-1", "spec");
    await writeCuratorClaim(claimPath, makeClaim({ curator: "spec", pid: 4242, phase: "scanning" }));

    let killedPid: number | null = null;
    let killedSignal: NodeJS.Signals | null = null;
    const r = await killCurator("spec", {
      pidRoot,
      mainSessionId: "sess-1",
      kill: (pid, sig) => {
        killedPid = pid;
        killedSignal = sig;
      },
    });
    expect(r).toEqual({ ok: true, action: "killed", alias: "spec", pid: 4242 });
    expect(killedPid).toBe(4242);
    expect(killedSignal).toBe("SIGTERM");

    // Verify the claim file was marked "killed".
    const after = JSON.parse(fs.readFileSync(claimPath, "utf8"));
    expect(after.phase).toBe("killed");
  });

  it("returns 'already_dead' when kill throws ESRCH", async () => {
    const pidRoot = tmpPidRoot();
    await writeCuratorClaim(
      curatorClaimFile(pidRoot, "sess-1", "spec"),
      makeClaim({ curator: "spec", pid: 777 }),
    );
    const r = await killCurator("spec", {
      pidRoot,
      mainSessionId: "sess-1",
      kill: () => {
        const err = new Error("No such process") as Error & { code: string };
        err.code = "ESRCH";
        throw err;
      },
    });
    expect(r).toEqual({ ok: true, action: "already_dead", alias: "spec" });
  });

  it("returns error on unexpected kill failure", async () => {
    const pidRoot = tmpPidRoot();
    await writeCuratorClaim(
      curatorClaimFile(pidRoot, "sess-1", "spec"),
      makeClaim({ curator: "spec", pid: 777 }),
    );
    const r = await killCurator("spec", {
      pidRoot,
      mainSessionId: "sess-1",
      kill: () => {
        throw new Error("EPERM: not allowed");
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("SIGTERM failed");
      expect(r.error).toContain("EPERM");
    }
  });
});

// ─── restartCurator ─────────────────────────────────────────────────────────

describe("restartCurator", () => {
  it("kills the curator + calls resetSpawnCounter", async () => {
    const pidRoot = tmpPidRoot();
    await writeCuratorClaim(
      curatorClaimFile(pidRoot, "sess-1", "spec"),
      makeClaim({ curator: "spec", pid: 4242, phase: "scanning" }),
    );

    let resetCalled = false;
    const r = await restartCurator("spec", {
      pidRoot,
      mainSessionId: "sess-1",
      kill: () => {},
      resetSpawnCounter: (a) => {
        if (a === "spec") resetCalled = true;
      },
    });
    expect(r.ok).toBe(true);
    expect(resetCalled).toBe(true);
    if (r.ok && r.action === "killed_only") {
      expect(r.alias).toBe("spec");
      expect(r.reason).toContain("killed");
    }
  });

  it("succeeds even when there is no claim (will re-spawn)", async () => {
    const pidRoot = tmpPidRoot();
    let resetCalled = false;
    const r = await restartCurator("ghost", {
      pidRoot,
      mainSessionId: "sess-1",
      kill: () => {},
      resetSpawnCounter: () => {
        resetCalled = true;
      },
    });
    expect(r.ok).toBe(true);
    expect(resetCalled).toBe(true);
    if (r.ok) {
      expect(r.action).toBe("killed_only");
      expect(r.reason).toContain("not running");
    }
  });

  it("propagates kill errors", async () => {
    const pidRoot = tmpPidRoot();
    await writeCuratorClaim(
      curatorClaimFile(pidRoot, "sess-1", "spec"),
      makeClaim({ curator: "spec", pid: 1 }),
    );
    const r = await restartCurator("spec", {
      pidRoot,
      mainSessionId: "sess-1",
      kill: () => {
        throw new Error("EPERM");
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("SIGTERM failed");
  });
});
