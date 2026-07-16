/**
 * logging-wiring.test.ts — proves the OTel logger actually fires at each
 * curator step (main turn_end gate/spawn/seed, signal_main send paths, janitor
 * tick). Uses the deps-injection seams (deps.logger / deps.onLog) so no real
 * file IO is needed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { handleTurnEnd } from "./index.js";
import { clearConfigCache } from "../util/config.js";
import { createSignalMainTool } from "../runtime/signal-main.js";
import { runTick } from "../janitor/run-tick.js";

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

function mockLogger() {
  const calls: { level: string; msg: string; attrs?: Record<string, unknown> }[] = [];
  const log = (level: string) => (msg: string, attrs?: Record<string, unknown>) =>
    calls.push({ level, msg, attrs });
  return {
    calls,
    logger: {
      trace: log("trace"), debug: log("debug"), info: log("info"),
      warn: log("warn"), error: log("error"),
      child: (_scope: string, extra?: Record<string, unknown>) => ({
        trace: log("trace"), debug: log("debug"), info: log("info"),
        warn: log("warn"), error: log("error"),
        child: () => mockLogger().logger,
      }),
    } as any,
  };
}

describe("main handleTurnEnd — logs every spawn step", () => {
  let projectRoot: string;
  let sessionPath: string;
  let goalFile: string;
  let pidRoot: string;
  let homeDir: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "curator-log-main-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-log-home-"));
    sessionPath = path.join(projectRoot, "session.jsonl");
    goalFile = path.join(projectRoot, "goals", "spec.md");
    pidRoot = path.join(homeDir, "pids");
    writeProjectConfig(projectRoot, goalFile);
    writeGoalFile(goalFile, "be concise.");
    writeSessionJsonl(sessionPath);
    clearConfigCache();
  });
  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    process.env = { ...(process.env as object) } as NodeJS.ProcessEnv;
  });

  it("emits gate-open + spawned + pid-seed records on a successful spawn", async () => {
    const { calls, logger } = mockLogger();
    const child = { pid: 4242, on: vi.fn() };
    await handleTurnEnd(
      {} as any,
      { ui: { notify: vi.fn(), setStatus: vi.fn() } } as any,
      {
        projectRoot,
        mainSessionId: "ses-main",
        mainSessionName: "main-session",
        sessionJsonlPath: sessionPath,
        pidRoot,
        turnNumber: 5,
        runtimeExtensionPath: "/r.ts",
        intercomExtensionPath: "/i.ts",
        spawnFn: (() => child) as any,
        logger,
      },
    );
    const msgs = calls.map((c) => c.msg);
    expect(msgs).toContain("gate open");
    expect(msgs).toContain("fork written");
    expect(msgs).toContain("claim acquired");
    expect(msgs).toContain("curator spawned");
    expect(msgs).toContain("claim pid seeded");
    const spawnRec = calls.find((c) => c.msg === "curator spawned");
    expect(spawnRec?.attrs).toMatchObject({ pid: 4242, phase: "spawned" });
  });

  it("emits a gate-closed debug record (no spawn) when the gate is closed", async () => {
    const { calls, logger } = mockLogger();
    // everyTurns huge → gate closed on turn 1.
    const cfg = path.join(projectRoot, ".pi-curator.json");
    fs.writeFileSync(
      cfg,
      JSON.stringify({
        curators: { spec: { enabled: true, alias: "spec", goalFile, spawn: { everyTurns: 999 } } },
      }),
    );
    clearConfigCache();
    await handleTurnEnd(
      {} as any,
      { ui: { notify: vi.fn(), setStatus: vi.fn() } } as any,
      {
        projectRoot,
        mainSessionId: "ses-main",
        sessionJsonlPath: sessionPath,
        pidRoot,
        turnNumber: 1,
        runtimeExtensionPath: "/r.ts",
        intercomExtensionPath: "/i.ts",
        logger,
        // Force the gate closed: spec last spawned at turn 1, so turnsSince=0 < 999.
        lastSpawn: { spec: { turn: 1, atMs: Date.now() } },
      },
    );
    expect(calls.some((c) => c.msg === "gate closed")).toBe(true);
    expect(calls.some((c) => c.msg === "curator spawned")).toBe(false);
  });
});

describe("signal_main — logs send / fallback / failure", () => {
  const identity = {
    curatorAlias: "spec",
    mainSessionId: "ses-main",
    mainSessionName: "main",
  } as any;

  it("logs info on successful intercom send", async () => {
    const calls: any[] = [];
    const tool = createSignalMainTool(
      {
        client: { send: async () => undefined } as any,
        fallbackDir: "/tmp",
        onLog: (lvl, msg, attrs) => calls.push({ lvl, msg, attrs }),
      },
      identity,
    );
    await tool.execute({ kind: "append", message: "hi" } as any);
    expect(calls.some((c) => c.lvl === "info" && /sent via intercom/.test(c.msg))).toBe(true);
  });

  it("logs warn (fallback) then writes file when broker unreachable", async () => {
    const calls: any[] = [];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sig-fallback-"));
    try {
      const tool = createSignalMainTool(
        {
          client: { send: async () => Promise.reject(new Error("nope")) } as any,
          fallbackDir: tmp,
          onLog: (lvl, msg, attrs) => calls.push({ lvl, msg, attrs }),
        },
        identity,
      );
      await tool.execute({ kind: "append", message: "hi" } as any);
      expect(calls.some((c) => c.lvl === "error" && /failed after retry/.test(c.msg))).toBe(true);
      expect(calls.some((c) => c.lvl === "warn" && /fallback file/.test(c.msg))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("janitor runTick — logs tick start + complete", () => {
  it("emits tick start and tick complete records via onLog", async () => {
    const calls: any[] = [];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "janitor-log-"));
    const pidsDir = path.join(tmp, "pids");
    const archiveDir = path.join(tmp, "archive");
    const forksDir = path.join(tmp, "forks");
    fs.mkdirSync(pidsDir, { recursive: true });
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.mkdirSync(forksDir, { recursive: true });
    try {
      await runTick(pidsDir, {
        archiveDir,
        forksDir,
        killPids: false,
        checkPid: false,
        onLog: (lvl, msg, attrs) => calls.push({ lvl, msg, attrs }),
      });
      expect(calls.some((c) => c.msg === "janitor tick start")).toBe(true);
      expect(calls.some((c) => c.msg === "janitor tick complete")).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
