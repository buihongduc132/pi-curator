/**
 * curator-runtime — pi extension entry (add-curator-signal, T7 adapter).
 *
 * Curator-side entry point. A curator is a forked `pi` process spawned by the
 * main-side `curator-main` extension. When the curator loads this extension,
 * it registers the `signal_main` tool (REQ-SG-01) so the curator LLM can push
 * findings back to its spawning main session.
 *
 * ## Identity discovery
 *
 * The curator's identity (`curatorAlias`, `mainSessionId`, `mainSessionName`,
 * `spawnedAt`) is injected via the spawn environment by the main hook:
 *
 *   - `PI_CURATOR_ALIAS`      — persona alias
 *   - `PI_CURATOR_MAIN_ID`    — main session id
 *   - `PI_CURATOR_MAIN_NAME`  — main session name (pi-intercom `to:` target)
 *   - `PI_CURATOR_SPAWNED_AT` — ISO timestamp written by main at spawn
 *
 * If any of these is missing, the tool is NOT registered and a UI notify is
 * emitted (non-blocking). This keeps a curator session loadable for tests /
 * manual use without forcing the intercom wiring.
 *
 * ## D-H10 note
 *
 * The locked decision D-H10 is "no custom tool" (prose prompt + stock
 * intercom tool). This adapter registers the OPTIONAL structured `signal_main`
 * tool. Because {@link buildContent} prepends the `[STEER]`/`[APPEND]` prefix,
 * the main-side receiver recovers the kind under EITHER path. This module is
 * therefore backward-compatible with the D-H10 default.
 *
 * All behavioral logic lives in the pure, unit-tested helpers in
 * `./signal-main.ts`; this file is a thin adapter over the pi ExtensionAPI so
 * the behavior is unit-testable without a real pi binary.
 *
 * @ts-nocheck — pi ExtensionAPI types are optional and heavy; the adapter uses
 * a loose `any` surface to stay decoupled from a specific pi version.
 */

// @ts-nocheck

import * as os from "node:os";
import * as path from "node:path";

import {
  createSignalMainTool,
  type CuratorIdentity,
  type SignalMainTool,
} from "./signal-main.js";
import {
  startHeartbeat,
  createBeforeExitHandler,
} from "./heartbeat.js";
import {
  curatorClaimFile,
  defaultPidRoot,
} from "../util/team-attach-claim.js";

type AnyExtensionAPI = import("@mariozechner/pi-coding-agent").ExtensionAPI | any;
type AnyExtensionContext = any;

/** Env vars that carry the curator identity (written by the main spawn hook). */
export const ENV = {
  ALIAS: "PI_CURATOR_ALIAS",
  MAIN_ID: "PI_CURATOR_MAIN_ID",
  MAIN_NAME: "PI_CURATOR_MAIN_NAME",
  SPAWNED_AT: "PI_CURATOR_SPAWNED_AT",
} as const;

/**
 * Default fallback findings dir:
 * `~/.pi-curator/findings/<mainSessionId>`. Matches the frozen contract with
 * `add-curator-lifecycle` `/curator status` + `curator-receiver.ts`.
 */
export function defaultFindingsDir(
  mainSessionId: string,
  homeDir: string = os.homedir(),
): string {
  return path.join(homeDir, ".pi-curator", "findings", mainSessionId);
}

/**
 * Read the curator identity from the environment. Returns `null` if any
 * required field is missing (the tool will not be registered in that case).
 * Pure (apart from reading `process.env`).
 */
export function readCuratorIdentity(env: NodeJS.ProcessEnv = process.env): CuratorIdentity | null {
  const curatorAlias = env[ENV.ALIAS];
  const mainSessionId = env[ENV.MAIN_ID];
  const mainSessionName = env[ENV.MAIN_NAME];
  const spawnedAt = env[ENV.SPAWNED_AT];
  if (!curatorAlias || !mainSessionId || !mainSessionName || !spawnedAt) {
    return null;
  }
  return { curatorAlias, mainSessionId, mainSessionName, spawnedAt };
}

/**
 * Build the intercom client adapter that {@link createSignalMainTool} drives.
 *
 * The curator loads `pi-intercom` as a pi extension, which exposes
 * `ctx.tools.intercom` (a `send(payload)` method). This adapter normalizes the
 * surface so `signal-main.ts` stays decoupled from the intercom package.
 */
function buildIntercomClient(ctx: AnyExtensionContext): { send: (p: any) => Promise<unknown> } | null {
  const intercom = ctx?.tools?.intercom ?? ctx?.intercom;
  if (intercom && typeof intercom.send === "function") {
    return { send: (p) => Promise.resolve(intercom.send(p)) };
  }
  return null;
}

/**
 * pi extension entry point. Registers the `signal_main` tool (REQ-SG-01) when
 * the curator identity env vars are present. Non-blocking: any setup failure
 * is logged to the UI and swallowed — the curator session still loads.
 */
export default function curatorRuntimeExtension(
  pi: AnyExtensionAPI,
  ctx?: AnyExtensionContext,
): void {
  try {
    const identity = readCuratorIdentity();
    if (!identity) {
      // Not spawned by the curator-main hook (manual / test session). The tool
      // is intentionally NOT registered — there is no main to signal back to.
      ctx?.ui?.notify?.(
        "curator-runtime: identity env not set — signal_main tool not registered",
        "info",
      );
      return;
    }

    const client = buildIntercomClient(ctx);
    if (!client) {
      // pi-intercom not loaded yet. We still register the tool — its execute
      // path will fall back to the findings file when send() rejects. This is
      // the correct behavior under D-H10 (intercom optional).
      ctx?.ui?.notify?.(
        "curator-runtime: pi-intercom not found — signal_main will use findings fallback",
        "warn",
      );
    }

    const fallbackDir = defaultFindingsDir(identity.mainSessionId);
    const tool: SignalMainTool = createSignalMainTool(
      {
        // Use a no-op client when intercom is unavailable; execute() will catch
        // the rejection and fall back to the findings file (REQ-SG-08).
        client: client ?? { send: async () => Promise.reject(new Error("pi-intercom not loaded")) },
        fallbackDir,
      },
      identity,
    );

    // pi ExtensionAPI.registerTool expects a pi-tool-shaped object. Our tool
    // matches the required shape (name/description/parameters/execute).
    pi.registerTool?.(tool);
    ctx?.ui?.notify?.(
      `curator-runtime: signal_main registered (target: ${identity.mainSessionName})`,
      "info",
    );

    // Start the heartbeat refresh loop (REQ-CR "Heartbeat refresh loop") +
    // register the terminal `done` write on beforeExit (REQ-CR "Curator sets
    // done before exit"). The claim file (`pids/<mainSessionId>/<curator>.json`)
    // is the SHARED contract with the staleness detector (REQ-LC-06) and the
    // janitor (REQ-LC-08). The curator's own session id (LD1 pointer) is read
    // from the pi context so `/curator status` can link back to this session.
    //
    // This is production wiring: WITHOUT this call, the heartbeat loop never
    // starts, the claim file is never refreshed after the main-side `phase:
    // "spawned"` seed, and `curatorSessionId` (LD1) is never written — making
    // both the liveness heartbeat and the LD1 pointer dead code in prod.
    const pidsFile = curatorClaimFile(
      defaultPidRoot(),
      identity.mainSessionId,
      identity.curatorAlias,
    );
    const curatorSessionId = ctx?.sessionId ?? ctx?.session?.id;
    startHeartbeat({
      pidsFile,
      pid: process.pid,
      curatorSessionId,
      onError: (err) => {
        ctx?.ui?.notify?.(
          `curator-runtime: heartbeat write failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          "warn",
        );
      },
    });
    // Terminal write: stamp `phase: "done"` as this curator's last act so the
    // staleness detector frees the slot immediately (vs waiting for the
    // dead-heartbeat timeout). Non-throwing per REQ-CR.
    const writeDone = createBeforeExitHandler(pidsFile, process.pid);
    process.on("beforeExit", () => {
      void writeDone();
    });
    ctx?.ui?.notify?.(
      `curator-runtime: heartbeat started (pid ${process.pid}${
        curatorSessionId ? `, session ${curatorSessionId}` : ""
      })`,
      "info",
    );
  } catch (err) {
    // REQ-SG-09 Exception Safety: log to UI only, never re-throw, never
    // block the curator session from loading.
    try {
      ctx?.ui?.notify?.(
        `curator-runtime: setup failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } catch {
      // Swallow — UI notify is best-effort.
    }
  }
}

export {};
