/**
 * curator-receiver — pi extension (add-curator-signal, task 2.1 + GREEN wiring).
 *
 * Main-side receiver for curator-originated intercom messages. Curators are
 * separate pi sessions (spawned by `curator-main`) that emit `kind=steer|append`
 * findings back to this main session. This extension subscribes to incoming
 * intercom messages (delivered by pi-intercom's listener via the pi
 * `message_start` hook), builds the known-curators list from the project
 * config, adapts the pi/ctx shapes to the pure `processIncoming` helpers, and
 * delegates to them.
 *
 * All behavioral logic lives in the pure, unit-tested helpers in
 * `./curator-receiver.ts`; this file is a thin adapter over the pi
 * ExtensionAPI so the behavior is unit-testable without a real pi binary.
 *
 * T0 results: `~/.pi-curator/probes/t0-results.md`.
 */
// @ts-nocheck

import {
  processIncoming,
  type ReceiverCtx,
  type ReceiverPi,
} from "./curator-receiver.js";
import { getCachedConfig, enabledPersonas } from "../util/config.js";
import { createCuratorLogger, type CuratorLogger } from "../util/logger.js";

type AnyExtensionAPI = import("@mariozechner/pi-coding-agent").ExtensionAPI | any;
type AnyExtensionContext = any;

/**
 * pi extension entry point. Registers the incoming-message hook
 * (`message_start`) that pi-intercom drives when a curator sends a finding.
 *
 * The handler is wrapped in try/catch (REQ-SG-09): on any exception it logs
 * to the UI only and NEVER blocks / crashes the main turn.
 */
export default function curatorReceiverExtension(
  pi: AnyExtensionAPI,
  _ctx?: AnyExtensionContext,
): void {
  // Receiver-side OTel logger. sessionId is read from ctx lazily per hook
  // fire (the extension entry runs before any session is bound); scope
  // `curator.receiver`. traceId is intentionally undefined here — receiver
  // does NOT carry the spawn trace (it runs in the MAIN process, not a forked
  // curator child).
  let log: CuratorLogger | undefined;
  function ensureLog(sessionId: string | undefined): CuratorLogger {
    if (!log) {
      log = createCuratorLogger({
        sessionId: sessionId ?? `pid-${process.pid}`,
        scope: "curator.receiver",
      });
    }
    return log;
  }
  pi.on("message_start", (event: unknown, ctx: AnyExtensionContext) => {
    try {
      const sessionId = ctx?.sessionId ?? ctx?.session?.id;
      const rtLog = ensureLog(sessionId);
      // Build the known-curators list from the project config (REQ-SG-03). A
      // curator signal from an unconfigured alias is dropped upstream by
      // processIncoming's sender filter.
      const projectRoot = ctx?.cwd ?? process.cwd();
      let knownCurators: string[] = [];
      try {
        const loaded = getCachedConfig({ projectRoot });
        knownCurators = Object.keys(enabledPersonas(loaded.config));
      } catch {
        // Config load failure MUST NOT block the receiver. Fall back to an
        // empty list — processIncoming still has the `curator*` loose match.
      }

      // Adapt the live pi/ctx surface into the pure-helper shapes so the
      // behavioral pipeline is unit-testable without a real pi binary.
      const ctxAdapter: ReceiverCtx = {
        sessionId,
        sessionManager: ctx?.sessionManager,
        sendMessage:
          typeof ctx?.sendMessage === "function" ? ctx.sendMessage : undefined,
        ui: {
          notify:
            typeof ctx?.ui?.notify === "function"
              ? ctx.ui.notify.bind(ctx.ui)
              : undefined,
        },
        // OTel: route processIncoming's onLog callbacks into the receiver
        // logger under the matching level. Logger never throws, so this is
        // safe to call from inside the REQ-SG-09 try/catch.
        onLog: (level, msg, attrs) => {
          try {
            if (level === "debug") rtLog.debug(msg, attrs);
            else if (level === "info") rtLog.info(msg, attrs);
            else if (level === "warn") rtLog.warn(msg, attrs);
            else rtLog.error(msg, attrs);
          } catch {
            // logger is non-throwing by contract; belt-and-suspenders
          }
        },
      };
      const piAdapter: ReceiverPi = {
        sendMessage: (msg, opts) => pi.sendMessage(msg, opts),
      };

      processIncoming(event, ctxAdapter, piAdapter, knownCurators);
    } catch (err) {
      // REQ-SG-09 Exception Safety: log to UI only, never re-throw, never
      // block the main turn, never crash the main session.
      try {
        // Stryker disable next-line all (3 equivalent mutants):
        //   OptionalChaining (<multi-line 78-83>→ctx?.ui?.notify): optional-chaining removal — downstream try/catch masks the difference
        //   OptionalChaining (ctx?.ui→ctx.ui): ui?. chain inside try/catch — TypeError swallowed, behavior identical
        //   OptionalChaining (ctx?.ui?.notify→ctx?.ui.notify): ui?. chain inside try/catch — TypeError swallowed, behavior identical
        ctx?.ui?.notify?.(
          `curator-receiver: handler crashed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          "error",
        );
      } catch {
        // Swallow — UI notify is best-effort.
      }
    }
  });
}

export {};
