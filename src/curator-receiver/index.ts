/**
 * curator-receiver — pi extension (add-curator-signal, task 2.1 scaffold).
 *
 * Main-side receiver for curator-originated intercom messages. Curators are
 * separate pi sessions (spawned by `add-curator-lifecycle`) that emit
 * `kind=steer|append` findings back to this main session. This extension
 * subscribes to incoming intercom messages (delivered by pi-intercom's
 * listener via the pi `message_start` hook), filters them by SENDER (NOT
 * customType — T0-Q2 proved customType is hardcoded to `"intercom_message"`),
 * recovers the kind from the `[STEER]`/`[APPEND]` body prefix (T0-Q4), and
 * re-delivers with the exact `deliverAs`/`triggerTurn` semantics per kind.
 *
 * All behavioral logic lives in the pure, unit-tested helpers in
 * `./curator-receiver.ts`; this file is a thin adapter over the pi
 * ExtensionAPI so the behavior is unit-testable without a real pi binary.
 *
 * T0 results: `~/.pi-curator/probes/t0-results.md`.
 *
 * NOTE: full sender-filtering / kind-recovery / delivery wiring lands in
 * later add-curator-signal tasks (2.3, 3.1, 3.2, 3.3, 4.1). This scaffold
 * (task 2.1) registers the `message_start` hook for incoming intercom
 * messages and wraps the handler in try/catch (REQ-SG-09 exception safety).
 */
// @ts-nocheck

type AnyExtensionAPI = import("@mariozechner/pi-coding-agent").ExtensionAPI | any;
type AnyExtensionContext = any;

/**
 * pi extension entry point. Registers the incoming-message hook
 * (`message_start`) that pi-intercom drives when a curator sends a finding.
 *
 * The handler is wrapped in try/catch (REQ-SG-09): on any exception it logs
 * to the UI only and NEVER blocks / crashes the main turn. Full processing
 * (sender filter, kind recovery, kind→deliverAs map) is wired in later tasks
 * via `processIncoming` from `./curator-receiver.ts`.
 */
export default function curatorReceiverExtension(
  pi: AnyExtensionAPI,
  _ctx?: AnyExtensionContext,
): void {
  pi.on("message_start", (event: unknown, ctx: AnyExtensionContext) => {
    try {
      // Placeholder: full processing lands in task 2.3+. The scaffold's
      // contract is to (a) subscribe to incoming intercom messages and
      // (b) never let handling crash the main turn (REQ-SG-09).
      void event;
      void ctx;
    } catch (err) {
      // REQ-SG-09 Exception Safety: log to UI only, never re-throw, never
      // block the main turn, never crash the main session.
      try {
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
