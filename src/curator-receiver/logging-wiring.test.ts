/**
 * logging-wiring.test.ts — RED phase tests for OTel logging in curator-receiver.
 *
 * Asserts that processIncoming emits OTel log records at EVERY instrumentation
 * point required by flow/plans/otel-logging/design.md:
 *   - Signal received — attrs: from.name, from.id, kind, alias
 *   - Dispatch — attrs: kind, ok(bool)
 *
 * The receiver currently has NO logger. These tests assert the logger gets
 * wired via an `onLog` callback on ReceiverCtx (matching the pattern already
 * used in signal-main.ts and run-tick.ts).
 */
import { describe, expect, it, vi } from "vitest";
import {
  processIncoming,
  type ReceiverCtx,
  type ReceiverPi,
  type IncomingMessage,
} from "./curator-receiver.js";

type LogCall = { level: string; msg: string; attrs?: Record<string, unknown> };

function makeCapture(): { calls: LogCall[]; fn: (l: string, m: string, a?: Record<string, unknown>) => void } {
  const calls: LogCall[] = [];
  return {
    calls,
    fn: (level, msg, attrs) => calls.push({ level, msg, attrs }),
  };
}

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    customType: "intercom_message",
    content: "**📨 From spec** (/proj)\n\n[STEER] something is wrong",
    details: {
      from: { name: "spec", id: "ses-curator-1" },
      bodyText: "[STEER] something is wrong",
      mainSessionId: "ses-main-1",
      severity: "warn",
      curatorAlias: "spec",
      spawnedAt: "2026-07-24T00:00:00.000Z",
    },
    ...overrides,
  };
}

function makeCtx(overrides: Partial<ReceiverCtx> = {}): ReceiverCtx {
  return {
    sessionId: "ses-main-1",
    sendMessage: () => undefined,
    ui: { notify: () => undefined },
    ...overrides,
  };
}

function makePi(): { pi: ReceiverPi; sendMock: ReturnType<typeof vi.fn> } {
  const sendMock = vi.fn();
  return { pi: { sendMessage: sendMock }, sendMock };
}

describe("curator-receiver OTel logging — signal received", () => {
  it("emits a 'signal received' log with from.name, from.id, kind, alias on a known-curator signal", () => {
    const cap = makeCapture();
    const ctx = makeCtx({ onLog: cap.fn });
    const { pi } = makePi();
    const msg = makeMessage();

    processIncoming(msg, ctx, pi, ["spec"]);

    const received = cap.calls.find((c) => c.msg.includes("signal received"));
    expect(received).toBeDefined();
    expect(received!.level).toBe("info");
    expect(received!.attrs).toMatchObject({
      "from.name": "spec",
      "from.id": "ses-curator-1",
      kind: "steer",
      "persona.alias": "spec",
    });
  });

  it("emits 'signal received' even when severity forces kind override (critical → steer)", () => {
    const cap = makeCapture();
    const ctx = makeCtx({ onLog: cap.fn });
    const { pi } = makePi();
    const msg = makeMessage({
      content: "**📨 From spec** (/proj)\n\n[APPEND] minor note",
      details: {
        from: { name: "spec", id: "ses-curator-1" },
        bodyText: "[APPEND] minor note",
        mainSessionId: "ses-main-1",
        severity: "critical",
        curatorAlias: "spec",
        spawnedAt: "2026-07-24T00:00:00.000Z",
      },
    });

    processIncoming(msg, ctx, pi, ["spec"]);

    const received = cap.calls.find((c) => c.msg.includes("signal received"));
    expect(received).toBeDefined();
    // effective kind is steer (critical override), but the ORIGINAL recovered
    // kind was append. The log should record the effective kind that was
    // actually dispatched.
    expect(received!.attrs).toMatchObject({ kind: "steer" });
  });
});

describe("curator-receiver OTel logging — dispatch", () => {
  it("emits a 'dispatch ok' log (info) with kind=steer, ok=true after a successful sendMessage", () => {
    const cap = makeCapture();
    const ctx = makeCtx({ onLog: cap.fn });
    const { pi, sendMock } = makePi();
    sendMock.mockImplementation(() => undefined); // success

    processIncoming(makeMessage(), ctx, pi, ["spec"]);

    const dispatched = cap.calls.find((c) => c.msg.includes("dispatch"));
    expect(dispatched).toBeDefined();
    expect(dispatched!.level).toBe("info");
    expect(dispatched!.attrs).toMatchObject({ kind: "steer", ok: true });
  });

  it("emits a 'dispatch fail' log (error) with kind, ok=false, error when sendMessage throws", () => {
    const cap = makeCapture();
    const ctx = makeCtx({ onLog: cap.fn });
    const { pi, sendMock } = makePi();
    sendMock.mockImplementation(() => {
      throw new Error("broker down");
    });

    // processIncoming wraps in try/catch — the throw becomes a caught error,
    // logged via onLog at error level, then returns false.
    const result = processIncoming(makeMessage(), ctx, pi, ["spec"]);

    const fail = cap.calls.find((c) => c.level === "error" && c.msg.includes("dispatch"));
    expect(fail).toBeDefined();
    expect(fail!.attrs).toMatchObject({ ok: false });
    expect(String(fail!.attrs!.error)).toContain("broker down");
    expect(result).toBe(false);
  });
});

describe("curator-receiver OTel logging — filter rejections (debug)", () => {
  it("emits a debug log when sender is not a known curator (drops silently)", () => {
    const cap = makeCapture();
    const ctx = makeCtx({ onLog: cap.fn });
    const { pi } = makePi();
    const msg = makeMessage({
      details: {
        from: { name: "random-session", id: "ses-x" },
        bodyText: "[STEER] hi",
        mainSessionId: "ses-main-1",
      },
    });

    processIncoming(msg, ctx, pi, ["spec"]); // known = [spec], sender = random-session

    const rejected = cap.calls.find((c) => c.msg.includes("unknown sender") || c.msg.includes("sender rejected"));
    expect(rejected).toBeDefined();
    expect(rejected!.level).toBe("debug");
  });

  it("emits a debug log when session-targeting rejects a cross-main signal", () => {
    const cap = makeCapture();
    const ctx = makeCtx({ sessionId: "ses-main-1", onLog: cap.fn });
    const { pi } = makePi();
    const msg = makeMessage({
      details: {
        from: { name: "spec", id: "ses-curator-1" },
        bodyText: "[STEER] hi",
        mainSessionId: "ses-OTHER-main",
        curatorAlias: "spec",
      },
    });

    processIncoming(msg, ctx, pi, ["spec"]);

    const mismatch = cap.calls.find(
      (c) => c.msg.includes("session mismatch") || c.msg.includes("target mismatch"),
    );
    expect(mismatch).toBeDefined();
    expect(mismatch!.level).toBe("debug");
  });
});

describe("curator-receiver OTel logging — no onLog wired (backward compat)", () => {
  it("does not throw when onLog is undefined (legacy callers)", () => {
    const ctx = makeCtx(); // no onLog
    const { pi } = makePi();
    expect(() => processIncoming(makeMessage(), ctx, pi, ["spec"])).not.toThrow();
  });
});
