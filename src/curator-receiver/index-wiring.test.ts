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

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "curator-rx-proj-"));
    // NOTE: deliberately NOT using process.chdir() — the handler resolves the
    // project root from ctx.cwd (passed explicitly below), and process.chdir()
    // is unsupported inside vitest worker threads (breaks stryker mutation runs).
    writeProjectConfig(projectRoot, ["spec", "scold"]);
    clearConfigCache();
  });

  afterEach(() => {
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

// ─── Mutation survivor remediation: adapter wiring ───────────────────────────

describe("curator-receiver entry — adapter wiring (mutation survivors)", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "curator-rx-proj-"));
    writeProjectConfig(projectRoot, ["spec", "scold"]);
    clearConfigCache();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    process.env = { ...REAL_ENV };
    clearConfigCache();
    vi.restoreAllMocks();
  });

  function defaultCtx() {
    return {
      cwd: projectRoot,
      sessionId: "ses_main",
      ui: { notify: vi.fn() },
    };
  }

  function knownCuratorEvent(senderName: string, extraDetails: Record<string, unknown> = {}) {
    return {
      message: {
        customType: "intercom_message",
        content: `**📨 From ${senderName}** (/p)\n\n[STEER] body`,
        details: {
          from: { name: senderName, id: `id-${senderName}` },
          bodyText: "[STEER] body",
          ...extraDetails,
        },
      },
    };
  }

  it("threads ctx.sessionId into session-targeting (rejects a different main)", async () => {
    // Kills: line 58 ObjectLiteral→{} + line 59 OptionalChaining/LogicalOperator +
    // line 60 OptionalChaining (ctxAdapter would lose sessionId/sessionManager).
    const mod = await import("./index");
    const sendMessage = vi.fn();
    const pi: any = { on: vi.fn(), sendMessage };
    const ctx: any = {
      cwd: projectRoot,
      sessionId: "ses_main",
      sessionManager: { getSessionId: () => "ses_main" },
      ui: { notify: vi.fn() },
    };
    mod.default(pi, ctx);
    const handler = pi.on.mock.calls.find((c: any[]) => c[0] === "message_start")[1];
    // Signal targets a DIFFERENT main session → must be ignored.
    handler(knownCuratorEvent("spec", { mainSessionId: "ses_OTHER" }), ctx);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("binds ctx.ui.notify and invokes it for critical severity", async () => {
    // Kills: line 62 ObjectLiteral→{} + line 64 ConditionalExpression/
    // EqualityOperator/OptionalChaining on the notify.bind path.
    const mod = await import("./index");
    const sendMessage = vi.fn();
    const pi: any = { on: vi.fn(), sendMessage };
    const notify = vi.fn();
    const ctx: any = { cwd: projectRoot, sessionId: "ses_main", ui: { notify } };
    mod.default(pi, ctx);
    const handler = pi.on.mock.calls.find((c: any[]) => c[0] === "message_start")[1];
    handler(
      knownCuratorEvent("spec", { severity: "critical", curatorAlias: "spec" }),
      ctx,
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalled();
  });

  it("does not crash and still re-delivers when ctx.ui has no notify", async () => {
    // Kills: line 64 ConditionalExpression→true (would call .bind on undefined
    // → throws before processIncoming → no re-delivery).
    const mod = await import("./index");
    const sendMessage = vi.fn();
    const pi: any = { on: vi.fn(), sendMessage };
    const ctx: any = { cwd: projectRoot, sessionId: "ses_main", ui: {} };
    mod.default(pi, ctx);
    const handler = pi.on.mock.calls.find((c: any[]) => c[0] === "message_start")[1];
    expect(() => handler(knownCuratorEvent("spec"), ctx)).not.toThrow();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("uses ctx.session.id when sessionId is absent (falls back through ??)", async () => {
    // Covers line 59 NoCoverage ctx?.session?.id branch.
    const mod = await import("./index");
    const sendMessage = vi.fn();
    const pi: any = { on: vi.fn(), sendMessage };
    const ctx: any = {
      cwd: projectRoot,
      session: { id: "ses_main" },
      ui: { notify: vi.fn() },
    };
    mod.default(pi, ctx);
    const handler = pi.on.mock.calls.find((c: any[]) => c[0] === "message_start")[1];
    // mainSessionId matches ctx.session.id → processed.
    handler(knownCuratorEvent("spec", { mainSessionId: "ses_main" }), ctx);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    // And a mismatched mainSessionId is rejected using ctx.session.id.
    handler(knownCuratorEvent("scold", { mainSessionId: "ses_OTHER" }), ctx);
    expect(sendMessage).toHaveBeenCalledTimes(1); // still 1, not 2
  });

  it("ArrayDeclaration survivor: empty knownCurators never matches 'Stryker was here'", async () => {
    // Kills: line 47 ArrayDeclaration→["Stryker was here"] (a sender literally
    // named "Stryker was here" must NEVER be re-delivered, even on config failure).
    // Use a project root with NO curators.json so config load fails → knownCurators
    // stays at its initial value (mutant would be ["Stryker was here"]).
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "curator-rx-empty-"));
    try {
      clearConfigCache();
      const mod = await import("./index");
      const sendMessage = vi.fn();
      const pi: any = { on: vi.fn(), sendMessage };
      const ctx: any = {
        cwd: emptyRoot,
        sessionId: "ses_main",
        ui: { notify: vi.fn() },
      };
      mod.default(pi, ctx);
      const handler = pi.on.mock.calls.find((c: any[]) => c[0] === "message_start")[1];
      handler(knownCuratorEvent("Stryker was here"), ctx);
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
      clearConfigCache();
    }
  });

  it("ctx.cwd OptionalChaining: handler works when ctx is undefined (loose curator match)", async () => {
    // Kills: line 46 OptionalChaining ctx.cwd (mutant throws when ctx is undefined).
    // process.cwd() is used instead; a 'curator*' sender loose-matches regardless.
    const mod = await import("./index");
    const sendMessage = vi.fn();
    const pi: any = { on: vi.fn(), sendMessage };
    mod.default(pi, undefined);
    const handler = pi.on.mock.calls.find((c: any[]) => c[0] === "message_start")[1];
    // ctx undefined → projectRoot = process.cwd(); sender 'curator-x' loose-matches.
    const event = {
      message: {
        customType: "intercom_message",
        content: "**📨 From curator-x** (/p)\n\n[STEER] body",
        details: { from: { name: "curator-x", id: "id-c" }, bodyText: "[STEER] body" },
      },
    };
    expect(() => handler(event, undefined)).not.toThrow();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
