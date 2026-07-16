/**
 * curator-receiver.test.ts — co-located unit tests for the curator-receiver
 * extension (add-curator-signal, task 2.1 scaffold + downstream tasks).
 *
 * These tests exercise the pure, injectable helpers so behavior is fully
 * unit-testable without a real pi binary or pi-intercom broker. The
 * default-export pi entry point is a thin adapter wired in index.ts.
 */
// @ts-nocheck
import { describe, it, expect, vi } from "vitest";
import {
  extractCuratorAlias,
  parseKindPrefix,
  isKnownCuratorSender,
  buildSendMessage,
  resolveDeliveryPath,
  resolveFindingsFilePath,
  formatFallbackLine,
  processIncoming,
  type SenderInfo,
} from "./curator-receiver";

// ─── Task 2.1: scaffold registers a hook for incoming intercom messages ──

describe("default export (task 2.1 scaffold)", () => {
  it("registers a message_start hook for incoming intercom messages", async () => {
    const mod = await import("./index");
    const pi: any = { on: vi.fn() };
    const ctx: any = {
      sessionManager: { getSessionId: () => "ses_main" },
      mode: "interactive",
      ui: {},
    };
    mod.default(pi, ctx);
    // The receiver MUST subscribe to incoming messages so curator signals
    // delivered over pi-intercom reach the handler.
    expect(pi.on).toHaveBeenCalledWith("message_start", expect.any(Function));
  });
});

// ─── Task 2.3 helper: sender-based filtering ───────────────────────────────

describe("isKnownCuratorSender (REQ-SG-03)", () => {
  const knownCurators = ["spec", "scold"];

  it("matches a sender whose name is in the curator list", () => {
    const sender: SenderInfo = { name: "spec", id: "x" };
    expect(isKnownCuratorSender(sender, knownCurators)).toBe(true);
  });

  it("rejects a sender not in the curator list", () => {
    const sender: SenderInfo = { name: "random-user", id: "x" };
    expect(isKnownCuratorSender(sender, knownCurators)).toBe(false);
  });

  it("loose-matches a sender whose name starts with 'curator' as fallback", () => {
    const sender: SenderInfo = { name: "curator-extra", id: "x" };
    expect(isKnownCuratorSender(sender, [])).toBe(true);
  });
});

describe("extractCuratorAlias (REQ-SG-03)", () => {
  it("extracts the alias from a curator-intercom rendered content", () => {
    // pi-intercom re-emits content like: **📨 From <name>** (<cwd>)\n\n<body>
    const content = "**📨 From spec** (/home/u/proj)\n\n[STEER] watch the budget";
    expect(extractCuratorAlias(content)).toBe("spec");
  });
});

// ─── Task 3.1 helper: kind recovery from body prefix ───────────────────────

describe("parseKindPrefix (REQ-SG-04, T0-Q4 confirmed)", () => {
  it("recovers steer from a [STEER] prefix", () => {
    expect(parseKindPrefix("[STEER] stop now")).toBe("steer");
  });

  it("recovers append from an [APPEND] prefix", () => {
    expect(parseKindPrefix("[APPEND] gentle note")).toBe("append");
  });

  it("returns null when no prefix is present", () => {
    expect(parseKindPrefix("just a plain message")).toBeNull();
  });
});

// ─── Task 3.2/3.3 helper: kind → delivery mapping ──────────────────────────

describe("buildSendMessage (REQ-SG-05 / REQ-SG-06)", () => {
  it("maps steer → triggerTurn:true, deliverAs:steer, display:true", () => {
    const out = buildSendMessage("steer", "stop now", { appendDisplay: false });
    expect(out.msg.customType).toBe("curator_steer");
    expect(out.msg.display).toBe(true);
    expect(out.opts).toEqual({ triggerTurn: true, deliverAs: "steer" });
  });

  it("maps append → deliverAs:nextTurn, NO triggerTurn, display from persona", () => {
    const out = buildSendMessage("append", "gentle note", { appendDisplay: true });
    expect(out.msg.customType).toBe("curator_append");
    expect(out.msg.display).toBe(true);
    expect(out.opts.triggerTurn).toBeUndefined();
    expect(out.opts.deliverAs).toBe("nextTurn");
  });

  it("append defaults display:false when persona omits appendDisplay", () => {
    const out = buildSendMessage("append", "note", undefined);
    expect(out.msg.display).toBe(false);
  });
});

// ─── Task 4.1 helper: non-interactive fallback path ────────────────────────

describe("resolveDeliveryPath (REQ-SG-07, T0-Q3 confirmed)", () => {
  it("returns 'fallback-file' when main mode is rpc (non-interactive)", () => {
    expect(resolveDeliveryPath("rpc")).toBe("fallback-file");
  });

  it("returns 'intercom' when main mode is interactive", () => {
    expect(resolveDeliveryPath("interactive")).toBe("intercom");
  });
});

// ─── Task 4.1: fallback findings file writer (REQ-SG-07 primary in rpc mode) ─

describe("resolveFindingsFilePath (REQ-SG-07 fallback file path)", () => {
  it("places the file under ~/.pi-curator/findings/<mainSessionId>/<curator>-<ts>.jsonl", () => {
    const p = resolveFindingsFilePath("/home/u", "ses_main", "spec", 1782000000000);
    expect(p).toBe(
      "/home/u/.pi-curator/findings/ses_main/spec-1782000000000.jsonl",
    );
  });
});

describe("formatFallbackLine (REQ-SG-07 fallback record)", () => {
  it("emits one JSON line carrying kind + message + mainSessionId + curator", () => {
    const line = formatFallbackLine({
      kind: "steer",
      message: "stop now",
      mainSessionId: "ses_main",
      curatorAlias: "spec",
    });
    const rec = JSON.parse(line);
    expect(rec.kind).toBe("steer");
    expect(rec.message).toBe("stop now");
    expect(rec.mainSessionId).toBe("ses_main");
    expect(rec.curatorAlias).toBe("spec");
  });

  it("emits exactly one trailing newline (jsonl = one record per line)", () => {
    const line = formatFallbackLine({
      kind: "append",
      message: "note",
      mainSessionId: "ses",
      curatorAlias: "scold",
    });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.split("\n")).toHaveLength(2); // record + empty after split
  });
});

// ─── Task 8 (Task 2.3): sender-based filtering in processIncoming ──────────

describe("processIncoming (REQ-SG-03 sender filter)", () => {
  it("processes a message from a known curator sender", () => {
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
    const ctx = {
      sessionManager: { getSessionId: () => "ses_main" },
      ui: { notify: vi.fn() },
    };
    const pi = { sendMessage: vi.fn() };
    const knownCurators = ["spec", "scold"];

    processIncoming(event, ctx, pi, knownCurators);

    expect(pi.sendMessage).toHaveBeenCalled();
  });

  it("ignores a message from an unknown sender (REQ-SG-03 unknown sender scenario)", () => {
    const event = {
      message: {
        customType: "intercom_message",
        content: "**📨 From random-user** (/home/u/proj)\n\n[STEER] should be ignored",
        details: {
          from: { name: "random-user", id: "id-random" },
          bodyText: "[STEER] should be ignored",
        },
      },
    };
    const ctx = {
      sessionManager: { getSessionId: () => "ses_main" },
      ui: { notify: vi.fn() },
    };
    const pi = { sendMessage: vi.fn() };
    const knownCurators = ["spec", "scold"];

    processIncoming(event, ctx, pi, knownCurators);

    expect(pi.sendMessage).not.toHaveBeenCalled();
  });
});

// ─── Task 10 (Task 3.1): kind recovery drives customType in pipeline ───────

describe("processIncoming (REQ-SG-04 kind recovery)", () => {
  function makeEvent(bodyText: string, senderName = "spec") {
    return {
      message: {
        customType: "intercom_message",
        content: `**📨 From ${senderName}** (/home/u/proj)\n\n${bodyText}`,
        details: {
          from: { name: senderName, id: `id-${senderName}` },
          bodyText,
        },
      },
    };
  }
  const ctx = {
    sessionManager: { getSessionId: () => "ses_main" },
    ui: { notify: vi.fn() },
  };
  const knownCurators = ["spec", "scold"];

  it("recovers kind=steer from [STEER] prefix and re-delivers curator_steer", () => {
    const pi = { sendMessage: vi.fn() };
    processIncoming(makeEvent("[STEER] budget exceeded"), ctx, pi, knownCurators);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "curator_steer" }),
      expect.anything(),
    );
  });

  it("recovers kind=append from [APPEND] prefix and re-delivers curator_append", () => {
    const pi = { sendMessage: vi.fn() };
    processIncoming(makeEvent("[APPEND] gentle note"), ctx, pi, knownCurators);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "curator_append" }),
      expect.anything(),
    );
  });

  it("falls back to steer (safe default) when prefix is absent (REQ-SG-04)", () => {
    const pi = { sendMessage: vi.fn() };
    processIncoming(makeEvent("no prefix at all"), ctx, pi, knownCurators);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "curator_steer" }),
      expect.anything(),
    );
  });
});

// ─── Task 2.2 (id 7): try/catch wrap — REQ-SG-09 exception safety ──────────

describe("processIncoming (REQ-SG-09 exception safety — task 2.2)", () => {
  function makeEvent(bodyText: string, senderName = "spec") {
    return {
      message: {
        customType: "intercom_message",
        content: `**📨 From ${senderName}** (/home/u/proj)

${bodyText}`,
        details: {
          from: { name: senderName, id: `id-${senderName}` },
          bodyText,
        },
      },
    };
  }

  it("swallows an exception thrown by pi.sendMessage and notifies the UI (REQ-SG-09)", () => {
    const notify = vi.fn();
    const ctx = {
      sessionManager: { getSessionId: () => "ses_main" },
      ui: { notify },
    };
    const boom = new Error("transport down");
    const pi = {
      sendMessage: vi.fn(() => {
        throw boom;
      }),
    };
    // MUST NOT throw — the exception is swallowed inside the handler.
    expect(() =>
      processIncoming(makeEvent("[STEER] budget exceeded"), ctx as any, pi as any, [
        "spec",
      ]),
    ).not.toThrow();
    // The failure MUST be logged to the UI only (REQ-SG-09).
    expect(notify).toHaveBeenCalled();
    expect(notify.mock.calls[0][1]).toBe("error");
  });

  it("never blocks the main turn when the handler itself throws (malformed signal)", () => {
    const notify = vi.fn();
    const ctx = {
      sessionManager: { getSessionId: () => "ses_main" },
      ui: { notify },
    };
    const pi = { sendMessage: vi.fn() };
    // A malformed event whose details.from is missing and content is empty —
    // every internal helper must be exception-safe.
    const malformed = { message: { customType: "intercom_message" } };
    expect(() =>
      processIncoming(malformed as any, ctx as any, pi as any, ["spec"]),
    ).not.toThrow();
    // Nothing re-delivered.
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });
});

// ─── Task 2.4 (id 9): session-targeting verification (REQ-SG-11) ───────────

describe("processIncoming (REQ-SG-11 session-targeting)", () => {
  function makeEvent(mainSessionId: string | undefined, senderName = "spec") {
    const bodyText = "[STEER] budget exceeded";
    const details: Record<string, unknown> = {
      from: { name: senderName, id: `id-${senderName}` },
      bodyText,
    };
    if (mainSessionId !== undefined) details.mainSessionId = mainSessionId;
    return {
      message: {
        customType: "intercom_message",
        content: `**📨 From ${senderName}** (/home/u/proj)\n\n${bodyText}`,
        details,
      },
    };
  }
  const knownCurators = ["spec", "scold"];

  it("processes a signal whose mainSessionId equals this main's session id", () => {
    const ctx = {
      sessionManager: { getSessionId: () => "ses_main" },
      ui: { notify: vi.fn() },
    };
    const pi = { sendMessage: vi.fn() };
    processIncoming(makeEvent("ses_main"), ctx as any, pi as any, knownCurators);
    expect(pi.sendMessage).toHaveBeenCalled();
  });

  it("ignores a signal whose mainSessionId targets a DIFFERENT main session (REQ-SG-11)", () => {
    const ctx = {
      sessionManager: { getSessionId: () => "ses_main" },
      ui: { notify: vi.fn() },
    };
    const pi = { sendMessage: vi.fn() };
    processIncoming(makeEvent("ses_OTHER"), ctx as any, pi as any, knownCurators);
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("processes a signal when no mainSessionId is carried (curator 1-per-main default)", () => {
    const ctx = {
      sessionManager: { getSessionId: () => "ses_main" },
      ui: { notify: vi.fn() },
    };
    const pi = { sendMessage: vi.fn() };
    processIncoming(makeEvent(undefined), ctx as any, pi as any, knownCurators);
    expect(pi.sendMessage).toHaveBeenCalled();
  });
});

// ─── D5: buildSendMessage must include details {kind,severity,curatorAlias,mainSessionId,spawnedAt} ─

describe("buildSendMessage (REQ-SG-03 details field — D5)", () => {
  it("steer message carries kind, severity, curatorAlias, mainSessionId, spawnedAt in details", () => {
    const out = buildSendMessage("steer", "stop now", { appendDisplay: false }, {
      severity: "critical",
      curatorAlias: "scold",
      mainSessionId: "ses_main",
      spawnedAt: "2026-07-07T10:00:00.000Z",
    });
    expect(out.msg.details).toEqual({
      kind: "steer",
      severity: "critical",
      curatorAlias: "scold",
      mainSessionId: "ses_main",
      spawnedAt: "2026-07-07T10:00:00.000Z",
    });
  });

  it("append message carries kind, severity, curatorAlias, mainSessionId, spawnedAt in details", () => {
    const out = buildSendMessage("append", "gentle note", { appendDisplay: true }, {
      severity: "warn",
      curatorAlias: "spec",
      mainSessionId: "ses_main",
      spawnedAt: "2026-07-07T11:00:00.000Z",
    });
    expect(out.msg.details).toEqual({
      kind: "append",
      severity: "warn",
      curatorAlias: "spec",
      mainSessionId: "ses_main",
      spawnedAt: "2026-07-07T11:00:00.000Z",
    });
  });

  it("defaults severity to 'info' when not provided", () => {
    const out = buildSendMessage("steer", "stop now", undefined);
    expect(out.msg.details).toEqual({
      kind: "steer",
      severity: "info",
    });
  });
});

// ─── D5: processIncoming extracts structured signal metadata from details ──

describe("processIncoming (REQ-SG-03 structured details — D5)", () => {
  function makeEvent(bodyText: string, extraDetails: Record<string, unknown> = {}) {
    return {
      message: {
        customType: "intercom_message",
        content: `**📨 From spec** (/home/u/proj)\n\n${bodyText}`,
        details: {
          from: { name: "spec", id: "id-spec" },
          bodyText,
          ...extraDetails,
        },
      },
    };
  }

  const ctx = {
    sessionManager: { getSessionId: () => "ses_main" },
    ui: { notify: vi.fn() },
  };

  it("threads severity/curatorAlias/mainSessionId/spawnedAt into pi.sendMessage details", () => {
    const pi = { sendMessage: vi.fn() };
    const extra = {
      severity: "warn",
      curatorAlias: "spec",
      mainSessionId: "ses_main",
      spawnedAt: "2026-07-07T12:00:00.000Z",
    };
    processIncoming(makeEvent("[STEER] budget exceeded", extra), ctx, pi, ["spec"]);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const [msg] = pi.sendMessage.mock.calls[0];
    expect(msg.details).toMatchObject({
      kind: "steer",
      severity: "warn",
      curatorAlias: "spec",
      mainSessionId: "ses_main",
      spawnedAt: "2026-07-07T12:00:00.000Z",
    });
  });

  it("extracts severity from the structured payload (default info when missing)", () => {
    const pi = { sendMessage: vi.fn() };
    processIncoming(makeEvent("[STEER] plain"), ctx, pi, ["spec"]);
    const [msg] = pi.sendMessage.mock.calls[0];
    expect(msg.details).toMatchObject({
      kind: "steer",
      severity: "info",
    });
  });
});

// ─── REQ-SG-08: receiver-side severity routing (critical→force-steer, warn/critical→UI notify) ──

describe("processIncoming (REQ-SG-08 receiver-side severity routing)", () => {
  function makeEvent(bodyText: string, extraDetails: Record<string, unknown> = {}) {
    return {
      message: {
        customType: "intercom_message",
        content: `**📨 From spec** (/home/u/proj)\n\n${bodyText}`,
        details: {
          from: { name: "spec", id: "id-spec" },
          bodyText,
          ...extraDetails,
        },
      },
    };
  }

  it("critical severity overrides an [APPEND] body to steer (force attention) + notifies error", () => {
    const ui = { notify: vi.fn() };
    const ctx = {
      sessionManager: { getSessionId: () => "ses_main" },
      ui,
    };
    const pi = { sendMessage: vi.fn() };
    processIncoming(
      makeEvent("[APPEND] gentle note", {
        severity: "critical",
        curatorAlias: "spec",
        mainSessionId: "ses_main",
        spawnedAt: "2026-07-07T12:00:00.000Z",
      }),
      ctx,
      pi,
      ["spec"],
    );
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = pi.sendMessage.mock.calls[0];
    // kind overridden append→steer
    expect(msg.details).toMatchObject({ kind: "steer", severity: "critical" });
    expect(opts.triggerTurn).toBe(true);
    expect(opts.deliverAs).toBe("steer");
    expect(ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
  });

  it("warn severity keeps the recovered kind but notifies warning", () => {
    const ui = { notify: vi.fn() };
    const ctx = {
      sessionManager: { getSessionId: () => "ses_main" },
      ui,
    };
    const pi = { sendMessage: vi.fn() };
    processIncoming(
      makeEvent("[APPEND] soft note", {
        severity: "warn",
        curatorAlias: "spec",
        mainSessionId: "ses_main",
        spawnedAt: "2026-07-07T12:00:00.000Z",
      }),
      ctx,
      pi,
      ["spec"],
    );
    const [msg, opts] = pi.sendMessage.mock.calls[0];
    expect(msg.details).toMatchObject({ kind: "append", severity: "warn" });
    expect(opts.triggerTurn).toBeUndefined(); // append never forces a turn
    expect(opts.deliverAs).toBe("nextTurn");
    expect(ui.notify).toHaveBeenCalledWith(expect.any(String), "warning");
  });

  it("info severity delivers silently (no UI notification)", () => {
    const ui = { notify: vi.fn() };
    const ctx = {
      sessionManager: { getSessionId: () => "ses_main" },
      ui,
    };
    const pi = { sendMessage: vi.fn() };
    processIncoming(
      makeEvent("[STEER] normal", { curatorAlias: "spec", mainSessionId: "ses_main", spawnedAt: "t" }),
      ctx,
      pi,
      ["spec"],
    );
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(ui.notify).not.toHaveBeenCalled();
  });
});
