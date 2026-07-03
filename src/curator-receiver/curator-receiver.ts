/**
 * curator-receiver.ts — pure helpers for the add-curator-signal main-side
 * receiver (tasks 2.1/2.3/3.1/3.2/3.3/4.1, REQ-SG-03..07).
 *
 * ## Why a separate extension
 *
 * The pre-T0 `pi-curator/extensions/main/receiver.ts` filtered on
 * `customType === "curator_signal"`. T0 (see `~/.pi-curator/probes/t0-results.md`)
 * disproved that: pi-intercom HARDCODES `customType:"intercom_message"` on
 * re-emit (T0-Q2), does NOT forward a curator-supplied `details.kind`
 * (T0-Q1), BUT the `[STEER]`/`[APPEND]` body prefix DOES survive reformatting
 * (T0-Q4). So the post-T0 receiver filters by SENDER (REQ-SG-03) and recovers
 * the kind from the body prefix (REQ-SG-04 stage i), honoring the locked
 * prose-prompt decision D-H10 (NO custom signal_main tool).
 *
 * ## Design: pure helpers + injected effects
 *
 * Every behavioral function here is pure over its arguments so it is fully
 * unit-testable with fakes. The default-export pi entry point in `./index.ts`
 * is a thin adapter that bridges the live transport (ctx.sessionManager,
 * pi.sendMessage, ctx.ui) into these helpers.
 */

import { join } from "node:path";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Curator delivery kind (REQ-SG-04). `steer` forces a turn; `append` is ambient. */
export type CuratorKind = "steer" | "append";

/** Sender identity carried in the intercom-delivered message's `details.from`. */
export interface SenderInfo {
  /** Sender session name (pi-intercom `from.name`), e.g. "spec" / "scold". */
  name: string;
  /** Sender session id (pi-intercom `from.id`). */
  id?: string;
}

/** A slice of the persona config the receiver consults (REQ-SG-06). */
export interface ReceiverPersona {
  /** Whether `append` findings are displayed (default false, REQ-SG-06). */
  appendDisplay?: boolean;
}

/** Payload handed to `pi.sendMessage`. */
export interface SendMessagePayload {
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
}

/** Options handed to `pi.sendMessage`. */
export interface SendMessageOptions {
  triggerTurn?: boolean;
  deliverAs?: "steer" | "followUp" | "nextTurn";
}

/** Result of building a re-delivery (msg + opts). */
export interface BuiltSendMessage {
  msg: SendMessagePayload;
  opts: SendMessageOptions;
}

/** All effects the receiver needs (injected so it is unit-testable). */
export interface ReceiverDeps {
  /** This main session's id (REQ-SG-11 session-targeting verification). */
  sessionId: string;
  /** Re-inject into the main session (`pi.sendMessage`). */
  sendMessage: (msg: SendMessagePayload, opts: SendMessageOptions) => void;
  /** Look up the persona config by alias (for `appendDisplay`, REQ-SG-06). */
  getPersona: (alias: string) => ReceiverPersona | undefined;
  /** UI surface (a slice of pi's ExtensionContext.ui). */
  ui: {
    notify?: (message: string, level?: "info" | "warning" | "error") => void;
  };
}

/**
 * Extract the body text from the delivered message's `details.bodyText` (the
 * pi-intercom-rendered body). Falls back to parsing the content after the
 * intercom header line. Pure.
 */
function resolveBodyText(message: IncomingMessage): string {
  const details = message.details as { bodyText?: string } | undefined;
  if (details?.bodyText) return details.bodyText;
  // Fallback: content is `**📨 From <name>** (<cwd>)\n\n<body>` — take after
  // the first blank line.
  const content = typeof message.content === "string" ? message.content : "";
  const idx = content.indexOf("\n\n");
  return idx >= 0 ? content.slice(idx + 2) : content;
}

/**
 * Extract the sender from the delivered message's `details.from`. Pure.
 */
function resolveSender(message: IncomingMessage): SenderInfo | null {
  const from = (message.details as { from?: SenderInfo } | undefined)?.from;
  if (from && typeof from === "object" && "name" in from) return from;
  return null;
}

/**
 * Extract the curator-declared `mainSessionId` from `details.mainSessionId`
 * (REQ-SG-11). Returns `undefined` when the message carries none (curators
 * are 1-per-main by default; the absence is NOT a mismatch — design D-MAINID).
 * Pure.
 */
function resolveMainSessionId(message: IncomingMessage): string | undefined {
  const id = (message.details as { mainSessionId?: string } | undefined)?.mainSessionId;
  return typeof id === "string" ? id : undefined;
}

// ─── Task 2.3+ (REQ-SG-03/04/05/06/11): full incoming-message pipeline ────

/** The shape of an incoming intercom message as seen by the receiver hook. */
export interface IncomingMessage {
  /** The re-emitted message type (pi-intercom hardcodes `intercom_message`). */
  customType?: string;
  /** The pi-intercom-rendered content (`**📨 From <name>** ...\n\n<body>`). */
  content?: string;
  /** pi-intercom forwards `details = { from, message, bodyText }`. */
  details?: unknown;
}

/**
 * The receiver adapter extracts this slice from the live pi ExtensionContext.
 * Kept minimal so `processIncoming` is unit-testable with fakes.
 */
export interface ReceiverCtx {
  sessionId?: string;
  sessionManager?: { getSessionId: () => string };
  sendMessage?: (msg: SendMessagePayload, opts: SendMessageOptions) => void;
  ui: { notify?: (message: string, level?: "info" | "warning" | "error") => void };
}

/**
 * The `pi` object the extension receives. Carries `sendMessage` for
 * re-injecting the finding into the main session.
 */
export interface ReceiverPi {
  sendMessage: (msg: SendMessagePayload, opts: SendMessageOptions) => void;
}

/**
 * Full incoming-message pipeline (tasks 2.3, 3.1, 3.2, 3.3, 2.4). Wires the
 * pure helpers together:
 * 1. Sender filter (REQ-SG-03): drop non-curator senders.
 * 2. Session targeting (REQ-SG-11): drop messages for a different main.
 * 3. Kind recovery (REQ-SG-04): parse `[STEER]`/`[APPEND]` prefix; default
 *    `steer` (safe) when unrecoverable.
 * 4. Delivery map (REQ-SG-05 steer / REQ-SG-06 append).
 *
 * Returns `true` if the message was re-delivered, `false` if it was ignored.
 */
export function processIncoming(
  event: { message?: IncomingMessage } | IncomingMessage,
  ctx: ReceiverCtx,
  pi: ReceiverPi,
  knownCurators: string[],
): boolean {
  // REQ-SG-09 Exception Safety (task 2.2): wrap the ENTIRE handler in
  // try/catch. On any exception, log to the UI only (display:false, never
  // re-throw, never block the main turn, never crash the main session).
  // A malformed curator signal is dropped after logging, not fatal.
  try {
    // Extract the message from the event wrapper if present.
    const message = "message" in event ? event.message : event;
    if (!message) return false;

    // 1. Sender filter (REQ-SG-03) — match sender, NOT customType.
    const sender = resolveSender(message);
    if (!sender || !isKnownCuratorSender(sender, knownCurators)) {
      return false; // unknown sender — ignore (no throw, REQ-SG-09).
    }

    // 2. Session-targeting verification (REQ-SG-11, task 2.4): a curator
    //    signal meant for a DIFFERENT main session is ignored. Curators are
    //    1-per-main by default, so an ABSENT mainSessionId is NOT a mismatch
    //    (design D-MAINID). This prevents a curator signal leaking into the
    //    wrong main if the broker ever broadcasts.
    const thisSessionId = ctx.sessionManager?.getSessionId?.() ?? ctx.sessionId;
    const targetMainId = resolveMainSessionId(message);
    if (
      thisSessionId &&
      targetMainId &&
      targetMainId !== thisSessionId
    ) {
      return false; // different main session — ignore.
    }

    // 3. Kind recovery (REQ-SG-04 stage i — body prefix, T0-Q4 confirmed).
    const body = resolveBodyText(message);
    const kind: CuratorKind = parseKindPrefix(body) ?? "steer"; // safe default

    // 4. Build the re-delivery per kind map (REQ-SG-05 / REQ-SG-06).
    const cleanBody = stripKindPrefix(body);
    const { msg, opts } = buildSendMessage(kind, cleanBody, undefined);

    // 5. Re-deliver into the main session.
    pi.sendMessage(msg, opts);
    return true;
  } catch (err) {
    // REQ-SG-09: log to UI only, never re-throw, never block the main turn.
    safeNotifyError(
      ctx,
      `curator-receiver: failed to handle curator signal: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

/** Fire-and-forget UI error notify; swallow failures (never block the main turn). */
function safeNotifyError(ctx: ReceiverCtx, message: string): void {
  try {
    ctx?.ui?.notify?.(message, "error");
  } catch {
    // best-effort — UI is optional and can disappear mid-turn.
  }
}

// ─── REQ-SG-04: kind recovery from body prefix (T0-Q4 confirmed) ───────────

const STEER_PREFIX = /^\s*\[STEER\]\s*/i;
const APPEND_PREFIX = /^\s*\[APPEND\]\s*/i;

/**
 * Recover the kind from the delivered message body (REQ-SG-04, T0-confirmed
 * stage i). T0-Q4 proved the `[STEER]`/`[APPEND]` text prefix round-trips
 * through pi-intercom's body reformatting intact, so prefix parsing is the
 * primary (and, per D-H10, only) recovery path. Returns `null` when neither
 * prefix is present — the caller applies the safe default `steer`.
 */
export function parseKindPrefix(body: string): CuratorKind | null {
  if (STEER_PREFIX.test(body)) return "steer";
  if (APPEND_PREFIX.test(body)) return "append";
  return null;
}

/** Strip the kind prefix from the body, returning the clean finding text. */
export function stripKindPrefix(body: string): string {
  return body.replace(STEER_PREFIX, "").replace(APPEND_PREFIX, "");
}

// ─── REQ-SG-03: sender-based filtering (NOT customType) ────────────────────

/**
 * Loose fallback: a sender whose name starts with `curator` is treated as a
 * known curator when the lifecycle-provided curator list is unavailable
 * (design Risks, sender-based filtering mitigation). Logged as a warning by
 * the caller when this path is taken.
 */
export function isCuratorNameLooseMatch(name: string): boolean {
  return name.toLowerCase().startsWith("curator");
}

/**
 * Determine whether a delivered message originated from a known curator for
 * this main session (REQ-SG-03). The receiver MUST NOT filter on top-level
 * `customType` (T0-Q2: hardcoded to `"intercom_message"`, matches nothing);
 * it matches the sender's name against the curator list provided by
 * `add-curator-lifecycle`, with a loose `curator*` fallback (logged).
 */
export function isKnownCuratorSender(
  sender: SenderInfo,
  knownCurators: string[],
): boolean {
  if (knownCurators.includes(sender.name)) return true;
  return isCuratorNameLooseMatch(sender.name);
}

// ─── REQ-SG-03: curator alias extraction from rendered content ─────────────

/**
 * Extract the curator alias from the pi-intercom-rendered content. pi-intercom
 * re-emits content as `**📨 From <name>** (<cwd>)\n\n<body>` (T0 capture). The
 * receiver uses this to look up the persona config (appendDisplay) and to
 * confirm sender identity when the structured `details.from` is absent.
 */
export function extractCuratorAlias(content: string): string | null {
  const match = content.match(/\*\*📨\s*From\s+([^\s*]+)\*\*/i);
  return match ? match[1] : null;
}

// ─── REQ-SG-05 / REQ-SG-06: kind → delivery mapping ────────────────────────

/**
 * Build the `pi.sendMessage` payload + options for a recovered kind
 * (REQ-SG-05 steer / REQ-SG-06 append). Mirrors the proven recipe in
 * `todo-enforcer/index.ts:226-236`.
 *
 * - `steer` → `{triggerTurn:true, deliverAs:"steer"}`, `display:true`.
 * - `append` → `{deliverAs:"nextTurn"}` (NO triggerTurn), `display` per
 *   persona (default false). `nextTurn` (not `followUp`) because `followUp`
 *   against an idle agent stalls forever (todo-enforcer index.ts:200-212);
 *   `nextTurn` is the only true ambient mode.
 */
export function buildSendMessage(
  kind: CuratorKind,
  content: string,
  persona: ReceiverPersona | undefined,
): BuiltSendMessage {
  if (kind === "steer") {
    return {
      msg: { customType: "curator_steer", content, display: true },
      opts: { triggerTurn: true, deliverAs: "steer" },
    };
  }
  // append — pure ambient, NO triggerTurn, rides next user prompt.
  return {
    msg: {
      customType: "curator_append",
      content,
      display: persona?.appendDisplay ?? false,
    },
    opts: { deliverAs: "nextTurn" },
  };
}

// ─── REQ-SG-07: non-interactive fallback path (T0-Q3 confirmed) ────────────

/** How a curator finding reaches main, given main's run mode. */
export type DeliveryPath = "intercom" | "fallback-file";

/**
 * Decide the delivery path from main's run mode (REQ-SG-07, T0-Q3). When main
 * runs non-interactively (`ctx.mode === "rpc"`), pi-intercom's busy
 * auto-reply fires BEFORE any extension hook (T0-Q3), so the intercom
 * receiver path is unreachable — the curator writes findings to the fallback
 * file as the PRIMARY path. Interactive main uses intercom.
 */
export function resolveDeliveryPath(mode: string): DeliveryPath {
  return mode === "rpc" ? "fallback-file" : "intercom";
}

// ─── REQ-SG-07: fallback findings file path + record format ───────────────

/** One curator finding written to the fallback findings file (REQ-SG-07). */
export interface FallbackFinding {
  kind: CuratorKind;
  message: string;
  mainSessionId: string;
  curatorAlias: string;
}

/**
 * Resolve the fallback findings file path (REQ-SG-07, design D-FALLBACK-FILE):
 * `~/.pi-curator/findings/<mainSessionId>/<curator>-<ts>.jsonl`. Pure.
 *
 * This is the PRIMARY delivery path when main runs non-interactively
 * (`ctx.mode === "rpc"`, T0-Q3) and the SHARED fallback when the intercom
 * broker is unreachable (REQ-SG-08, D-FALLBACK-FILE). `/curator status`
 * (owned by `add-curator-lifecycle`, lifecycle task 9.2) reads and surfaces
 * this file.
 *
 * STABLE CONTRACT (add-curator-signal task 4.3): the path layout AND the
 * `FallbackFinding` JSONL record shape are a frozen inter-change contract
 * consumed by `add-curator-lifecycle` `/curator status` (task 9.2). Do NOT
 * rename fields or restructure the path without coordinating that change —
 * see `verification.test.ts` which locks both.
 */
export function resolveFindingsFilePath(
  homeDir: string,
  mainSessionId: string,
  curatorAlias: string,
  nowMs: number,
): string {
  return join(
    homeDir,
    ".pi-curator",
    "findings",
    mainSessionId,
    `${curatorAlias}-${nowMs}.jsonl`,
  );
}

/**
 * Format one fallback findings record as a single JSONL line with a trailing
 * newline (REQ-SG-07). One finding per line so `/curator status` can stream
 * and recover records independently. Pure.
 */
export function formatFallbackLine(finding: FallbackFinding): string {
  return JSON.stringify(finding) + "\n";
}

export {};
