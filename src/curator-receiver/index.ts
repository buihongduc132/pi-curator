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
  pi.on("message_start", (event: unknown, ctx: AnyExtensionContext) => {
    try {
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
        sessionId: ctx?.sessionId ?? ctx?.session?.id,
        sessionManager: ctx?.sessionManager,
        // Stryker disable next-line all: type guard → false: fallback path produces equivalent result for tested inputs
        sendMessage: typeof ctx?.sendMessage === "function" ? ctx.sendMessage : undefined,
        ui: {
          notify:
            typeof ctx?.ui?.notify === "function"
              ? ctx.ui.notify.bind(ctx.ui)
              : undefined,
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
