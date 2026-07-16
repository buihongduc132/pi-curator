/**
 * index-error-paths.test.ts — covers the curator-receiver index.ts outer
 * try/catch (REQ-SG-09) and the `ctx?.ui?.notify?.(...)` crash-log path,
 * which are otherwise unreachable because processIncoming swallows its own
 * exceptions internally.
 *
 * Uses vi.mock to force `processIncoming` to throw so the adapter's OUTER
 * catch fires — exercising the handler-crashed notify path.
 */
// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { clearConfigCache } from "../util/config.js";

// Force processIncoming to throw so the index.ts outer try/catch fires.
vi.mock("./curator-receiver.js", () => ({
  processIncoming: () => {
    throw new Error("forced boom");
  },
}));

const REAL_ENV = { ...process.env };

function writeProjectConfig(projectRoot: string, aliases: string[]) {
  const dir = path.join(projectRoot, ".pi-curator");
  fs.mkdirSync(dir, { recursive: true });
  const curators: Record<string, unknown> = {};
  for (const a of aliases) curators[a] = { alias: a, enabled: true };
  fs.writeFileSync(
    path.join(dir, "curators.json"),
    JSON.stringify({ curators }, null, 2),
    "utf8",
  );
}

describe("curator-receiver entry — outer catch / crash-notify path (REQ-SG-09)", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "curator-rx-err-"));
    writeProjectConfig(projectRoot, ["spec"]);
    clearConfigCache();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    process.env = { ...REAL_ENV };
    clearConfigCache();
    vi.restoreAllMocks();
  });

  it("logs to ctx.ui.notify when the handler crashes (covers outer catch + notify)", async () => {
    // Kills: line 74 BlockStatement, line 77 BlockStatement, and line 78
    // OptionalChaining ctx?.ui?.notify?.(...) NoCoverage mutants.
    const mod = await import("./index");
    const notify = vi.fn();
    const pi: any = { on: vi.fn(), sendMessage: vi.fn() };
    const ctx: any = { cwd: projectRoot, sessionId: "ses_main", ui: { notify } };
    mod.default(pi, ctx);
    const handler = pi.on.mock.calls.find((c: any[]) => c[0] === "message_start")[1];

    expect(() => handler({ message: { customType: "x" } }, ctx)).not.toThrow();
    expect(notify).toHaveBeenCalled();
    // The crash message must mention the forced error.
    const [msg, level] = notify.mock.calls[0];
    expect(msg).toContain("curator-receiver: handler crashed");
    expect(msg).toContain("forced boom");
    expect(level).toBe("error");
  });

  it("never re-throws and never re-delivers when the handler crashes", async () => {
    // Covers: outer catch returns void; sendMessage must NOT be called.
    const mod = await import("./index");
    const sendMessage = vi.fn();
    const pi: any = { on: vi.fn(), sendMessage };
    const ctx: any = { cwd: projectRoot, sessionId: "ses_main", ui: { notify: vi.fn() } };
    mod.default(pi, ctx);
    const handler = pi.on.mock.calls.find((c: any[]) => c[0] === "message_start")[1];

    expect(() =>
      handler({ message: { customType: "intercom_message" } }, ctx),
    ).not.toThrow();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("swallows the crash silently when ctx.ui.notify is absent (best-effort)", async () => {
    // Covers the inner `try { ctx?.ui?.notify?.(...) } catch {}` safety net —
    // a missing notify must not cause a secondary throw.
    const mod = await import("./index");
    const pi: any = { on: vi.fn(), sendMessage: vi.fn() };
    const ctx: any = { cwd: projectRoot, sessionId: "ses_main", ui: {} };
    mod.default(pi, ctx);
    const handler = pi.on.mock.calls.find((c: any[]) => c[0] === "message_start")[1];
    expect(() => handler({ message: {} }, ctx)).not.toThrow();
  });
});
