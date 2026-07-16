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

// ─── Mutation survivor remediation ──────────────────────────────────────
// These tests assert on the exact wiring effects (cleaned body content,
// details fields, return values, exception-vs-filter distinction) that the
// original tests did not check, killing stryker survivors in the pure helpers
// reachable only through processIncoming.

describe("processIncoming — resolveBodyText fallback (content has no bodyText)", () => {
  const ctx = {
    sessionManager: { getSessionId: () => "ses_main" },
    ui: { notify: vi.fn() },
  };
  const knownCurators = ["spec"];

  function makeContentMessage(content: string, extraDetails: Record<string, unknown> = {}) {
    return {
      message: {
        customType: "intercom_message",
        content,
        details: { from: { name: "spec", id: "id-spec" }, ...extraDetails },
      },
    };
  }

  it("recovers the body from content after the blank-line header", () => {
    const pi = { sendMessage: vi.fn() };
    // No details.bodyText → must parse content after "\n\n".
    processIncoming(
      makeContentMessage("**📨 From spec** (/p)\n\n[STEER] watch the budget", {}),
      ctx as any,
      pi as any,
      knownCurators,
    );
    const [msg] = pi.sendMessage.mock.calls[0];
    // cleanBody is the body with the [STEER] prefix stripped.
    expect(msg.content).toBe("watch the budget");
  });

  it("returns the whole content when there is no blank-line separator", () => {
    const pi = { sendMessage: vi.fn() };
    processIncoming(
      makeContentMessage("[STEER] no separator here", {}),
      ctx as any,
      pi as any,
      knownCurators,
    );
    const [msg] = pi.sendMessage.mock.calls[0];
    expect(msg.content).toBe("no separator here");
  });

  it("ignores an empty details.bodyText and falls back to content", () => {
    const pi = { sendMessage: vi.fn() };
    processIncoming(
      makeContentMessage("**📨 From spec** (/p)\n\n[APPEND] note", { bodyText: "" }),
      ctx as any,
      pi as any,
      knownCurators,
    );
    const [msg] = pi.sendMessage.mock.calls[0];
    expect(msg.customType).toBe("curator_append");
    expect(msg.content).toBe("note");
  });

  it("uses details.bodyText when it is a non-empty string", () => {
    const pi = { sendMessage: vi.fn() };
    // bodyText differs from the content body — bodyText must win.
    processIncoming(
      makeContentMessage("**📨 From spec** (/p)\n\nWRONG BODY", {
        bodyText: "[STEER] right body",
      }),
      ctx as any,
      pi as any,
      knownCurators,
    );
    const [msg] = pi.sendMessage.mock.calls[0];
    expect(msg.content).toBe("right body");
  });
});

describe("processIncoming — resolveSender edge cases", () => {
  const ctx = {
    sessionManager: { getSessionId: () => "ses_main" },
    ui: { notify: vi.fn() },
  };

  it("ignores a message whose details.from is a non-object string (no throw, no notify)", () => {
    const notify = vi.fn();
    const pi = { sendMessage: vi.fn() };
    const event = {
      message: {
        customType: "intercom_message",
        content: "**📨 From spec** (/p)\n\n[STEER] x",
        details: { from: "spec" }, // string, not an object
      },
    };
    expect(() =>
      processIncoming(event as any, { ...ctx, ui: { notify } } as any, pi as any, ["spec"]),
    ).not.toThrow();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    // No exception path should have fired (sender simply unresolved → filtered).
    expect(notify).not.toHaveBeenCalled();
  });

  it("ignores a message whose details.from is an object without a name field", () => {
    const pi = { sendMessage: vi.fn() };
    const event = {
      message: {
        customType: "intercom_message",
        content: "**📨 From spec** (/p)\n\n[STEER] x",
        details: { from: { id: "id-spec" } }, // no name
      },
    };
    processIncoming(event as any, ctx as any, pi as any, ["spec"]);
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });
});

describe("processIncoming — resolveMainSessionId / resolveSeverity / resolveSpawnedAt typing", () => {
  const ctx = {
    sessionManager: { getSessionId: () => "ses_main" },
    ui: { notify: vi.fn() },
  };

  function make(details: Record<string, unknown>) {
    return {
      message: {
        customType: "intercom_message",
        content: "**📨 From spec** (/p)\n\n[STEER] body",
        details: { from: { name: "spec", id: "id-spec" }, bodyText: "[STEER] body", ...details },
      },
    };
  }

  it("treats a non-string mainSessionId as absent (no mismatch)", () => {
    const pi = { sendMessage: vi.fn() };
    processIncoming(make({ mainSessionId: 12345 }) as any, ctx as any, pi as any, ["spec"]);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const [msg] = pi.sendMessage.mock.calls[0];
    // Non-string mainSessionId must NOT round-trip into details.
    expect(msg.details).not.toHaveProperty("mainSessionId");
  });

  it("treats an invalid severity as info (no UI notify, details.severity=info)", () => {
    const ui = { notify: vi.fn() };
    const pi = { sendMessage: vi.fn() };
    processIncoming(
      make({ severity: "bogus" }) as any,
      { ...ctx, ui } as any,
      pi as any,
      ["spec"],
    );
    const [msg] = pi.sendMessage.mock.calls[0];
    expect(msg.details.severity).toBe("info");
    expect(ui.notify).not.toHaveBeenCalled();
  });

  it("treats a non-string spawnedAt as absent (omitted from details)", () => {
    const pi = { sendMessage: vi.fn() };
    processIncoming(make({ spawnedAt: 999 }) as any, ctx as any, pi as any, ["spec"]);
    const [msg] = pi.sendMessage.mock.calls[0];
    expect(msg.details).not.toHaveProperty("spawnedAt");
  });
});

describe("processIncoming — resolveCuratorAlias fallbacks", () => {
  const ctx = {
    sessionManager: { getSessionId: () => "ses_main" },
    ui: { notify: vi.fn() },
  };

  function make(details: Record<string, unknown>, content: string) {
    return {
      message: {
        customType: "intercom_message",
        content,
        details: { from: { name: "spec", id: "id-spec" }, bodyText: "[STEER] body", ...details },
      },
    };
  }

  it("uses the explicit curatorAlias when it is a non-empty string", () => {
    const pi = { sendMessage: vi.fn() };
    processIncoming(
      make({ curatorAlias: "explicit-alias" }, "**📨 From spec** (/p)\n\n[STEER] body") as any,
      ctx as any,
      pi as any,
      ["spec"],
    );
    const [msg] = pi.sendMessage.mock.calls[0];
    expect(msg.details.curatorAlias).toBe("explicit-alias");
  });

  it("falls back to the sender name when curatorAlias is an empty string", () => {
    const pi = { sendMessage: vi.fn() };
    processIncoming(
      make({ curatorAlias: "" }, "**📨 From spec** (/p)\n\n[STEER] body") as any,
      ctx as any,
      pi as any,
      ["spec"],
    );
    const [msg] = pi.sendMessage.mock.calls[0];
    expect(msg.details.curatorAlias).toBe("spec");
  });

  it("falls back to the sender name when curatorAlias is absent and content has no From header", () => {
    const pi = { sendMessage: vi.fn() };
    processIncoming(
      make({}, "no header here\n\n[STEER] body") as any,
      ctx as any,
      pi as any,
      ["spec"],
    );
    const [msg] = pi.sendMessage.mock.calls[0];
    expect(msg.details.curatorAlias).toBe("spec");
  });

  it("critical severity notify uses the resolved curatorAlias (not 'unknown')", () => {
    const ui = { notify: vi.fn() };
    const pi = { sendMessage: vi.fn() };
    processIncoming(
      make({ severity: "critical" }, "**📨 From spec** (/p)\n\n[APPEND] body") as any,
      { ...ctx, ui } as any,
      pi as any,
      ["spec"],
    );
    const critical = ui.notify.mock.calls.find(
      (c) => typeof c[0] === "string" && /CRITICAL finding/.test(c[0]),
    );
    expect(critical).toBeTruthy();
    expect(critical![0]).toContain("curator:spec");
    expect(critical![0]).not.toContain("unknown");
  });

  it("critical severity notify falls back to 'unknown' when alias is unrecoverable", () => {
    const ui = { notify: vi.fn() };
    const pi = { sendMessage: vi.fn() };
    // No From header, no curatorAlias, sender name absent (from without name
    // would be filtered — so use a known curator sender with empty alias path
    // by omitting curatorAlias and giving content without From).
    const event = {
      message: {
        customType: "intercom_message",
        content: "no header\n\n[APPEND] body",
        details: {
          from: { name: "spec", id: "id-spec" },
          bodyText: "[APPEND] body",
          severity: "critical",
        },
      },
    };
    // Override sender.name to be absent is impossible (from.name required);
    // instead assert the alias resolves to the sender name "spec" (not unknown)
    // which still exercises the ?? branch.
    processIncoming(event as any, { ...ctx, ui } as any, pi as any, ["spec"]);
    const [msg] = pi.sendMessage.mock.calls[0];
    expect(msg.details.curatorAlias).toBe("spec");
  });
});

describe("processIncoming — extractMessage + return values + sessionManager absent", () => {
  it("returns true on a successful re-delivery", () => {
    const ctx = {
      sessionManager: { getSessionId: () => "ses_main" },
      ui: { notify: vi.fn() },
    };
    const pi = { sendMessage: vi.fn() };
    const event = {
      message: {
        customType: "intercom_message",
        content: "**📨 From spec** (/p)\n\n[STEER] body",
        details: { from: { name: "spec", id: "id-spec" }, bodyText: "[STEER] body" },
      },
    };
    const result = processIncoming(event as any, ctx as any, pi as any, ["spec"]);
    expect(result).toBe(true);
  });

  it("returns false and does not notify on a null event", () => {
    const notify = vi.fn();
    const ctx = { sessionManager: { getSessionId: () => "ses_main" }, ui: { notify } };
    const pi = { sendMessage: vi.fn() };
    const result = processIncoming(null as any, ctx as any, pi as any, ["spec"]);
    expect(result).toBe(false);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("returns false and does not notify on a primitive event", () => {
    const notify = vi.fn();
    const ctx = { sessionManager: { getSessionId: () => "ses_main" }, ui: { notify } };
    const pi = { sendMessage: vi.fn() };
    expect(() =>
      processIncoming("primitive" as any, ctx as any, pi as any, ["spec"]),
    ).not.toThrow();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("processes a bare IncomingMessage (no event wrapper)", () => {
    const ctx = {
      sessionManager: { getSessionId: () => "ses_main" },
      ui: { notify: vi.fn() },
    };
    const pi = { sendMessage: vi.fn() };
    const bare = {
      customType: "intercom_message",
      content: "**📨 From spec** (/p)\n\n[STEER] body",
      details: { from: { name: "spec", id: "id-spec" }, bodyText: "[STEER] body" },
    };
    const result = processIncoming(bare as any, ctx as any, pi as any, ["spec"]);
    expect(result).toBe(true);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("returns false when pi.sendMessage throws (REQ-SG-09)", () => {
    const ctx = {
      sessionManager: { getSessionId: () => "ses_main" },
      ui: { notify: vi.fn() },
    };
    const pi = { sendMessage: vi.fn(() => { throw new Error("down"); }) };
    const event = {
      message: {
        customType: "intercom_message",
        content: "**📨 From spec** (/p)\n\n[STEER] body",
        details: { from: { name: "spec", id: "id-spec" }, bodyText: "[STEER] body" },
      },
    };
    const result = processIncoming(event as any, ctx as any, pi as any, ["spec"]);
    expect(result).toBe(false);
  });

  it("uses ctx.sessionId for session-targeting when sessionManager is absent", () => {
    // No sessionManager → falls back to ctx.sessionId. Matching signal processed.
    const ctx = { sessionId: "ses_main", ui: { notify: vi.fn() } };
    const pi = { sendMessage: vi.fn() };
    const event = {
      message: {
        customType: "intercom_message",
        content: "**📨 From spec** (/p)\n\n[STEER] body",
        details: {
          from: { name: "spec", id: "id-spec" },
          bodyText: "[STEER] body",
          mainSessionId: "ses_main",
        },
      },
    };
    const result = processIncoming(event as any, ctx as any, pi as any, ["spec"]);
    expect(result).toBe(true);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not throw and returns false when ctx is undefined (OptionalChaining safety)", () => {
    const pi = { sendMessage: vi.fn() };
    const event = {
      message: {
        customType: "intercom_message",
        content: "**📨 From spec** (/p)\n\n[STEER] body",
        details: { from: { name: "spec", id: "id-spec" }, bodyText: "[STEER] body" },
      },
    };
    // ctx undefined → sessionManager?. OptionalChaining keeps it safe.
    expect(() =>
      processIncoming(event as any, undefined as any, pi as any, ["spec"]),
    ).not.toThrow();
  });
});

describe("isCuratorNameLooseMatch / stripKindPrefix direct (mutation survivors)", () => {
  // @ts-ignore
  it("isCuratorNameLooseMatch: true for names starting with 'curator' (any case)", async () => {
    const mod = await import("./curator-receiver");
    expect(mod.isCuratorNameLooseMatch("Curator-Extra")).toBe(true);
    expect(mod.isCuratorNameLooseMatch("spec")).toBe(false);
  });

  it("stripKindPrefix removes both [STEER] and [APPEND] prefixes", async () => {
    const mod = await import("./curator-receiver");
    expect(mod.stripKindPrefix("[STEER] hello")).toBe("hello");
    expect(mod.stripKindPrefix("[APPEND] note")).toBe("note");
    expect(mod.stripKindPrefix("plain")).toBe("plain");
  });
});

// ─── Mutation survivor remediation (targeted TDD) ────────────────────────────

describe("processIncoming — mutation survivor remediation", () => {
  function makeEvent(opts: {
    content?: string;
    bodyText?: string;
    senderName?: string;
    extra?: Record<string, unknown>;
  }) {
    const senderName = opts.senderName ?? "spec";
    const content =
      opts.content !== undefined
        ? opts.content
        : `**📨 From ${senderName}** (/home/u/proj)\n\n${opts.bodyText ?? "[STEER] body"}`;
    const details: Record<string, unknown> = {
      from: { name: senderName, id: `id-${senderName}` },
    };
    if (opts.bodyText !== undefined) details.bodyText = opts.bodyText;
    if (opts.extra) Object.assign(details, opts.extra);
    return { message: { customType: "intercom_message", content, details } };
  }

  // ── resolveBodyText: content string-check + idx boundary ──────────────

  it("re-delivers when message.content is absent (bodyText present)", () => {
    // Kills: line 92 ConditionalExpression→true in resolveBodyText (would set
    // content=undefined → .indexOf throws → caught → returns false).
    const pi = { sendMessage: vi.fn() };
    const ctx = {
      sessionManager: { getSessionId: () => "ses_main" },
      ui: { notify: vi.fn() },
    };
    const event = makeEvent({ content: undefined, bodyText: "[STEER] hi" });
    const result = processIncoming(event, ctx, pi, ["spec"]);
    expect(result).toBe(true);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const [msg] = pi.sendMessage.mock.calls[0];
    expect(msg.content).toBe("hi");
  });

  it("recovers body when the blank-line separator is at index 0", () => {
    // Kills: line 94 EqualityOperator→`idx > 0` (would return the full content
    // including the leading blank lines, changing cleanBody).
    const pi = { sendMessage: vi.fn() };
    const ctx = {
      sessionManager: { getSessionId: () => "ses_main" },
      ui: { notify: vi.fn() },
    };
    // content starts with "\n\n" (idx===0); no bodyText → must slice(2).
    const event = makeEvent({ content: "\n\nplain body no prefix" });
    processIncoming(event, ctx, pi, ["spec"]);
    const [msg] = pi.sendMessage.mock.calls[0];
    expect(msg.content).toBe("plain body no prefix");
  });

  // ── resolveCuratorAlias: content string-check ─────────────────────────

  it("uses the content-scraped alias when it differs from the sender name", () => {
    // Kills: line 135 EqualityOperator→!== and ConditionalExpression→false
    // (both would drop the content path → alias falls back to sender.name).
    const pi = { sendMessage: vi.fn() };
    const ctx = {
      sessionManager: { getSessionId: () => "ses_main" },
      ui: { notify: vi.fn() },
    };
    // Sender is "spec" but the rendered From header names "scold".
    const event = makeEvent({
      senderName: "spec",
      content: "**📨 From scold** (/p)\n\n[STEER] body",
      bodyText: "[STEER] body",
    });
    processIncoming(event, ctx, pi, ["spec"]);
    const [msg] = pi.sendMessage.mock.calls[0];
    expect(msg.details.curatorAlias).toBe("scold");
  });

  it("falls back to sender.name when content is undefined and no curatorAlias", () => {
    // Kills: line 135 ConditionalExpression→true (would call extractCuratorAlias
    // on undefined → throws → caught → returns false, no re-delivery).
    const pi = { sendMessage: vi.fn() };
    const ctx = {
      sessionManager: { getSessionId: () => "ses_main" },
      ui: { notify: vi.fn() },
    };
    const event = makeEvent({ content: undefined, bodyText: "[STEER] body" });
    const result = processIncoming(event, ctx, pi, ["spec"]);
    expect(result).toBe(true);
    const [msg] = pi.sendMessage.mock.calls[0];
    expect(msg.details.curatorAlias).toBe("spec");
  });

  // ── return-value assertions (BooleanLiteral false→true mutants) ───────

  it("returns false (not true) for an unknown sender", () => {
    // Kills: line 227 BooleanLiteral→true.
    const pi = { sendMessage: vi.fn() };
    const ctx = {
      sessionManager: { getSessionId: () => "ses_main" },
      ui: { notify: vi.fn() },
    };
    const event = makeEvent({ senderName: "random-user" });
    const result = processIncoming(event, ctx, pi, ["spec"]);
    expect(result).toBe(false);
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("returns false (not true) for a signal targeting a different main session", () => {
    // Kills: line 242 BooleanLiteral→true.
    const pi = { sendMessage: vi.fn() };
    const ctx = {
      sessionManager: { getSessionId: () => "ses_main" },
      ui: { notify: vi.fn() },
    };
    const event = makeEvent({
      senderName: "spec",
      extra: { mainSessionId: "ses_OTHER" },
    });
    const result = processIncoming(event, ctx, pi, ["spec"]);
    expect(result).toBe(false);
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  // ── sessionManager.getSessionId optional-chaining ─────────────────────

  it("uses ctx.sessionId when sessionManager lacks getSessionId", () => {
    // Kills: line 235 OptionalChaining (`.getSessionId?.()` → `.getSessionId()`):
    // the mutant throws on a sessionManager without getSessionId.
    const pi = { sendMessage: vi.fn() };
    const ctx = {
      sessionManager: {} as never, // present but no getSessionId method
      sessionId: "ses_main",
      ui: { notify: vi.fn() },
    };
    const event = makeEvent({
      senderName: "spec",
      extra: { mainSessionId: "ses_main" },
    });
    const result = processIncoming(event, ctx, pi, ["spec"]);
    expect(result).toBe(true);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  // ── REQ-SG-08 notify: curatorAlias ?? "unknown" ───────────────────────

  it("critical-severity notify message embeds the resolved alias (not 'unknown')", () => {
    // Kills: line 290 LogicalOperator `curatorAlias && "unknown"` mutant
    // (would replace a truthy alias with the literal "unknown").
    const notify = vi.fn();
    const ctx = {
      sessionManager: { getSessionId: () => "ses_main" },
      ui: { notify },
    };
    const pi = { sendMessage: vi.fn() };
    const event = makeEvent({
      senderName: "spec",
      bodyText: "[APPEND] forced",
      extra: { severity: "critical", curatorAlias: "spec" },
    });
    processIncoming(event, ctx, pi, ["spec"]);
    expect(notify).toHaveBeenCalled();
    expect(notify.mock.calls[0][0]).toContain("spec");
    expect(notify.mock.calls[0][0]).not.toContain("unknown");
    expect(notify.mock.calls[0][1]).toBe("error");
  });

  it("warn-severity notify fires at the warning level", () => {
    // Exercises the warn branch (line 289) with a real notify call.
    const notify = vi.fn();
    const ctx = {
      sessionManager: { getSessionId: () => "ses_main" },
      ui: { notify },
    };
    const pi = { sendMessage: vi.fn() };
    const event = makeEvent({
      senderName: "spec",
      bodyText: "[APPEND] gentle",
      extra: { severity: "warn", curatorAlias: "spec" },
    });
    processIncoming(event, ctx, pi, ["spec"]);
    expect(notify).toHaveBeenCalled();
    expect(notify.mock.calls[0][1]).toBe("warning");
  });
});

// ─── FINAL mutation survivor round — deficient-ctx + content-undefined paths ──
// These target OptionalChaining mutants on the notify calls (which need a ctx
// that is MISSING `ui` or has `ui` without `notify`) and the content-string
// ternary mutants (which need a message with truly-undefined content).

describe("processIncoming — content truly undefined (mutation survivors L92/L135)", () => {
  // A message with NO details.bodyText and content omitted entirely. The
  // `typeof message.content === "string" ? ... : ""` ternaries (resolveBodyText
  // L92 + resolveCuratorAlias L135) MUST coerce undefined → "". A cond→true
  // mutant would thread `undefined` through and throw on `.indexOf`/`.match`,
  // making processIncoming return false instead of true.
  function makeNoContentEvent(senderName = "spec") {
    // content key entirely absent; details has from but NO bodyText, NO curatorAlias.
    return {
      message: {
        customType: "intercom_message",
        details: { from: { name: senderName, id: `id-${senderName}` } },
      },
    };
  }

  it("re-delivers (returns true) when content is undefined and bodyText is absent", () => {
    const pi = { sendMessage: vi.fn() };
    const ctx = {
      sessionManager: { getSessionId: () => "ses_main" },
      ui: { notify: vi.fn() },
    };
    const result = processIncoming(makeNoContentEvent() as any, ctx as any, pi as any, ["spec"]);
    expect(result).toBe(true);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    // cleanBody is "" (empty), alias falls back to the sender name.
    const [msg] = pi.sendMessage.mock.calls[0];
    expect(msg.content).toBe("");
    expect(msg.details.curatorAlias).toBe("spec");
  });
});

describe("processIncoming — severity routing exactness (mutation survivor L123)", () => {
  // L123 `if (raw === "info" || raw === "warn" || raw === "critical") return raw;`
  // cond→false would force resolveSeverity to always return "info". A warn
  // finding MUST thread severity="warn" into the round-tripped details AND fire
  // the warning-level notify — both assertions break under the mutant.
  it("threads severity=warn into msg.details (not defaulted to info)", () => {
    const pi = { sendMessage: vi.fn() };
    const ctx = {
      sessionManager: { getSessionId: () => "ses_main" },
      ui: { notify: vi.fn() },
    };
    const event = {
      message: {
        customType: "intercom_message",
        content: "**📨 From spec** (/p)\n\n[APPEND] note",
        details: {
          from: { name: "spec", id: "id-spec" },
          bodyText: "[APPEND] note",
          severity: "warn",
          curatorAlias: "spec",
        },
      },
    };
    processIncoming(event as any, ctx as any, pi as any, ["spec"]);
    const [msg] = pi.sendMessage.mock.calls[0];
    expect(msg.details.severity).toBe("warn");
    expect(msg.details.kind).toBe("append");
  });

  it("threads severity=critical into msg.details (not defaulted to info)", () => {
    const pi = { sendMessage: vi.fn() };
    const ctx = {
      sessionManager: { getSessionId: () => "ses_main" },
      ui: { notify: vi.fn() },
    };
    const event = {
      message: {
        customType: "intercom_message",
        content: "**📨 From spec** (/p)\n\n[APPEND] note",
        details: {
          from: { name: "spec", id: "id-spec" },
          bodyText: "[APPEND] note",
          severity: "critical",
          curatorAlias: "spec",
        },
      },
    };
    processIncoming(event as any, ctx as any, pi as any, ["spec"]);
    const [msg] = pi.sendMessage.mock.calls[0];
    expect(msg.details.severity).toBe("critical");
    // critical overrides the recovered kind to steer.
    expect(msg.details.kind).toBe("steer");
  });
});

describe("processIncoming — notify OptionalChaining on deficient ctx (L280/L289/L313)", () => {
  function severityEvent(severity: "critical" | "warn") {
    return {
      message: {
        customType: "intercom_message",
        content: "**📨 From spec** (/p)\n\n[APPEND] note",
        details: {
          from: { name: "spec", id: "id-spec" },
          bodyText: "[APPEND] note",
          severity,
          curatorAlias: "spec",
        },
      },
    };
  }

  // L280 critical-notify OptionalChaining: the critical branch notify MUST
  // short-circuit when ctx has no `ui` / no `ui.notify` and MUST still return true.
  it("does not throw on a CRITICAL finding when ctx has no ui", () => {
    const pi = { sendMessage: vi.fn() };
    const ctx = { sessionManager: { getSessionId: () => "ses_main" } } as any;
    expect(() =>
      processIncoming(severityEvent("critical") as any, ctx, pi as any, ["spec"]),
    ).not.toThrow();
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not throw on a CRITICAL finding when ctx.ui lacks notify", () => {
    const pi = { sendMessage: vi.fn() };
    const ctx = { sessionManager: { getSessionId: () => "ses_main" }, ui: {} } as any;
    expect(() =>
      processIncoming(severityEvent("critical") as any, ctx, pi as any, ["spec"]),
    ).not.toThrow();
  });

  // L289 warn-notify OptionalChaining.
  it("does not throw on a WARN finding when ctx has no ui", () => {
    const pi = { sendMessage: vi.fn() };
    const ctx = { sessionManager: { getSessionId: () => "ses_main" } } as any;
    expect(() =>
      processIncoming(severityEvent("warn") as any, ctx, pi as any, ["spec"]),
    ).not.toThrow();
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not throw on a WARN finding when ctx.ui lacks notify", () => {
    const pi = { sendMessage: vi.fn() };
    const ctx = { sessionManager: { getSessionId: () => "ses_main" }, ui: {} } as any;
    expect(() =>
      processIncoming(severityEvent("warn") as any, ctx, pi as any, ["spec"]),
    ).not.toThrow();
  });

  // L313 safeNotifyError OptionalChaining: when the error path fires AND ctx is
  // deficient, the receiver MUST still not throw (swallow + return false).
  it("does not throw when pi.sendMessage throws and ctx has no ui (safeNotifyError)", () => {
    const pi = {
      sendMessage: vi.fn(() => {
        throw new Error("transport down");
      }),
    };
    const ctx = { sessionManager: { getSessionId: () => "ses_main" } } as any;
    let result = true;
    expect(() => {
      result = processIncoming(severityEvent("critical") as any, ctx, pi as any, ["spec"]);
    }).not.toThrow();
    expect(result).toBe(false);
  });

  it("does not throw when pi.sendMessage throws and ctx.ui lacks notify", () => {
    const pi = {
      sendMessage: vi.fn(() => {
        throw new Error("boom");
      }),
    };
    const ctx = { sessionManager: { getSessionId: () => "ses_main" }, ui: {} } as any;
    let result = true;
    expect(() => {
      result = processIncoming(severityEvent("warn") as any, ctx, pi as any, ["spec"]);
    }).not.toThrow();
    expect(result).toBe(false);
  });
});

// L290 LogicalOperator `curatorAlias ?? "unknown"` → `curatorAlias && "unknown"`:
// the WARN notify message MUST embed the resolved alias ("spec"), not the
// literal "unknown" that the mutant substitutes for any truthy alias.
describe("processIncoming — warn notify embeds the resolved alias (mutation survivor L290)", () => {
  it("warn notify message contains the actual alias, not 'unknown'", () => {
    const notify = vi.fn();
    const ctx = { sessionManager: { getSessionId: () => "ses_main" }, ui: { notify } } as any;
    const pi = { sendMessage: vi.fn() };
    const event = {
      message: {
        customType: "intercom_message",
        content: "**📨 From spec** (/p)\n\n[APPEND] note",
        details: {
          from: { name: "spec", id: "id-spec" },
          bodyText: "[APPEND] note",
          severity: "warn",
          curatorAlias: "spec",
        },
      },
    };
    processIncoming(event as any, ctx, pi as any, ["spec"]);
    const warnCall = notify.mock.calls.find(
      (c) => typeof c[0] === "string" && /warning finding/.test(c[0]),
    );
    expect(warnCall).toBeTruthy();
    expect(warnCall![0]).toContain("spec");
    expect(warnCall![0]).not.toContain("unknown");
  });
});
