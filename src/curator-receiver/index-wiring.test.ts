/**
 * index-wiring.test.ts — verifies the receiver entry point (index.ts) actually
 * calls `processIncoming` end-to-end (BLOCKER D1: the handler was a no-op).
 *
 * The index adapter is `@ts-nocheck` (pi ExtensionAPI types are optional); we
 * exercise it with fakes so the wiring is verifiable without a real pi binary
 * or pi-intercom broker.
 */
// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { clearConfigCache } from "../util/config.js";

const REAL_ENV = { ...process.env };

function writeProjectConfig(projectRoot: string, aliases: string[]) {
  const dir = path.join(projectRoot, ".pi-curator");
  fs.mkdirSync(dir, { recursive: true });
  const curators: Record<string, unknown> = {};
  for (const a of aliases) {
    curators[a] = { alias: a, enabled: true };
  }
  fs.writeFileSync(
    path.join(dir, "curators.json"),
    JSON.stringify({ curators }, null, 2),
    "utf8",
  );
}

describe("curator-receiver entry (D1 — message_start handler calls processIncoming)", () => {
  let projectRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "curator-rx-proj-"));
    originalCwd = process.cwd();
    process.chdir(projectRoot);
    writeProjectConfig(projectRoot, ["spec", "scold"]);
    clearConfigCache();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(projectRoot, { recursive: true, force: true });
    process.env = { ...REAL_ENV };
    clearConfigCache();
    vi.restoreAllMocks();
  });

  it("the handler re-delivers a known curator signal via pi.sendMessage", async () => {
    const mod = await import("./index");
    const sendMessage = vi.fn();
    const pi: any = { on: vi.fn(), sendMessage };
    const ctx: any = {
      cwd: projectRoot,
      sessionId: "ses_main",
      ui: { notify: vi.fn() },
    };
    mod.default(pi, ctx);

    const handler = pi.on.mock.calls.find((c: any[]) => c[0] === "message_start")[1];

    const event = {
      message: {
        customType: "intercom_message",
        content: "**📨 From spec** (/home/u/proj)\n\n[STEER] watch the budget",
        details: {
          from: { name: "spec", id: "id-spec" },
          bodyText: "[STEER] watch the budget",
        },
      },
    };

    // The handler MUST call pi.sendMessage (i.e. processIncoming ran and
    // re-delivered the signal). This is the core D1 assertion: the handler is
    // NO LONGER a no-op.
    handler(event, ctx);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [msg] = sendMessage.mock.calls[0];
    expect(msg.customType).toBe("curator_steer");
  });

  it("ignores a signal from a sender not in the project config (sender filter applied)", async () => {
    const mod = await import("./index");
    const sendMessage = vi.fn();
    const pi: any = { on: vi.fn(), sendMessage };
    const ctx: any = {
      cwd: projectRoot,
      sessionId: "ses_main",
      ui: { notify: vi.fn() },
    };
    mod.default(pi, ctx);

    const handler = pi.on.mock.calls.find((c: any[]) => c[0] === "message_start")[1];
    const event = {
      message: {
        customType: "intercom_message",
        content: "**📨 From random-user** (/home/u/proj)\n\n[STEER] ignore me",
        details: {
          from: { name: "random-user", id: "id-rand" },
          bodyText: "[STEER] ignore me",
        },
      },
    };

    handler(event, ctx);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("never throws on a malformed event (REQ-SG-09)", async () => {
    const mod = await import("./index");
    const pi: any = { on: vi.fn(), sendMessage: vi.fn() };
    const ctx: any = { cwd: projectRoot, sessionId: "ses_main", ui: { notify: vi.fn() } };
    mod.default(pi, ctx);
    const handler = pi.on.mock.calls.find((c: any[]) => c[0] === "message_start")[1];

    expect(() => handler({ message: { customType: "garbage" } }, ctx)).not.toThrow();
  });
});
