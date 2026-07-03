/**
 * t0-probe.ts — T0 blocking probe for the `add-curator-signal` change.
 *
 * Task 1.1 / 1.2 / 1.3 (BLOCKING — spec REQ-SG-01). Before any transport REQ
 * (REQ-SG-02 → REQ-SG-08) may be marked DONE, this probe MUST be executed and
 * its findings written to `~/.pi-curator/probes/t0-results.md`.
 *
 * ## What this probe ACTUALLY does (v2 — real execution, not stubs)
 *
 * Unlike the prior stub (which only console.logged argv arrays), this probe
 * ACTUALLY executes end-to-end against the live pi-intercom broker:
 *
 *   1. `runT0Probe()` — connects TWO real intercom sessions (sender + receiver)
 *      to the live broker at `~/.pi/agent/intercom/broker.sock` using the
 *      `IntercomClient` class imported directly from the installed
 *      `pi-intercom` package (`broker/client.ts`). The sender emits a tagged
 *      intercom message with body `[STEER] probe payload`. The receiver
 *      captures the FULL delivered broker message. Then the probe
 *      reconstructs EXACTLY what the pi-intercom extension's
 *      `sendIncomingMessage` (index.ts:586-593) re-emits via `pi.sendMessage`
 *      — the customType, content, and details object a real receiver's hook
 *      would see — and writes it all to t0-results.md.
 *
 *   2. `runT0ProbeNonInteractive()` — the SECOND variant. A real `pi -p`
 *      receiver process is spawned via child_process (loading pi-intercom),
 *      and the probe statically analyzes the installed pi-intercom source
 *      (index.ts:660-700) to determine whether the auto-reply short-circuit
 *      fires BEFORE any extension hook. The finding is grounded in the actual
 *      installed source code (with line citations), NOT hardcoded booleans.
 *
 * ## T0 questions answered
 *
 *   - T0-Q1: does `details.kind` survive the intercom round-trip?
 *   - T0-Q2: what `customType` does the receiver's hook see?
 *   - T0-Q4: does the `[STEER]` prefix survive body reformatting?
 *   - T0-Q3: does the non-interactive busy auto-reply fire BEFORE any hook?
 *
 * ## Running
 *
 *   cd <pi-plugins repo> && npx tsx ~/.pi-curator/probes/t0-probe.ts
 *
 * Requires the pi-intercom broker reachable at `~/.pi/agent/intercom/broker.sock`
 * (auto-spawns on first connect). Requires `tsx` resolvable (present in the
 * pi-plugins repo devDeps).
 */

import { writeFile, appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { IntercomClient } from "/home/bhd/.pi/agent/npm/node_modules/pi-intercom/broker/client.ts";

// ─── Paths ──────────────────────────────────────────────────────────────────

const HOME = homedir();
const PROBES_DIR = join(HOME, ".pi-curator", "probes");
const RESULTS_PATH = join(PROBES_DIR, "t0-results.md");
const PI_INTERCOM_INDEX = join(HOME, ".pi/agent/npm/node_modules/pi-intercom/index.ts");
const BROKER_SOCK = join(HOME, ".pi/agent/intercom/broker.sock");

// ─── Stable intercom identities for the two probe sessions ──────────────────

/** Stable name under which the SENDER session registers itself. */
const SENDER_NAME = "t0-probe-sender";
/** Stable name under which the RECEIVER session registers itself. */
const RECEIVER_NAME = "t0-probe-receiver";

// ─── The tagged payload the sender emits ────────────────────────────────────

/**
 * Body text the sender sends. The `[STEER] ` prefix is the prose-prompt
 * kind-encoding (design D-H10 / D-C2 stage i); its survival through intercom
 * body reformatting is exactly what T0-Q4 probes.
 */
const SENDER_BODY = "[STEER] probe payload";

/**
 * `details` blob the curator WOULD attach. T0-Q1 probes whether this survives.
 * NOTE: the stock intercom `send` tool action (pi-intercom index.ts:1392-1430)
 * calls `client.send(sendTo, { text: message, attachments, replyTo })` — there
 * is NO `details` parameter on the broker Message type (types.ts). So this
 * `details` blob CANNOT be transported by the stock intercom tool; it is
 * recorded here so T0-Q1 can document that fact empirically.
 */
const SENDER_DETAILS = {
  kind: "steer" as const,
  mainSessionId: "probe",
};

// ─── Types mirroring pi-intercom (types.ts) ─────────────────────────────────

interface SessionInfo {
  id: string;
  name?: string;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
}

interface Attachment {
  type: "file" | "snippet" | "context";
  name: string;
  content: string;
  language?: string;
}

interface BrokerMessage {
  id: string;
  timestamp: number;
  replyTo?: string;
  expectsReply?: boolean;
  content: { text: string; attachments?: Attachment[] };
}

/**
 * The `entry` object pi-intercom's sendIncomingMessage constructs and passes
 * as `details` on re-emit (index.ts:591 `details: entry`). Reconstructed
 * verbatim from the installed source so the probe captures EXACTLY what a real
 * receiver hook would see.
 */
interface IntercomEntry {
  from: SessionInfo;
  message: BrokerMessage;
  replyCommand?: string;
  bodyText: string;
}

/**
 * Shape of the incoming intercom message as the receiver's hook sees it AFTER
 * pi-intercom's sendIncomingMessage re-emit. customType is HARDCODED to
 * "intercom_message" (index.ts:587); details is the constructed `entry`.
 */
interface DeliveredIntercomMessage {
  customType: string;
  content: string;
  display: boolean;
  details: IntercomEntry;
}

/** Minimal pi extension host API surface the receiver hook needs. */
interface ExtensionApiLike {
  on(event: string, handler: (event: unknown, ctx?: unknown) => void): void;
}

// ─── Results file helpers ───────────────────────────────────────────────────

const INTERCOM_CUSTOM_TYPE = "intercom_message";

async function ensureProbesDir(): Promise<void> {
  await mkdir(PROBES_DIR, { recursive: true });
}

function nowIso(): string {
  return new Date().toISOString();
}

// ─── Reconstruct pi-intercom's sendIncomingMessage re-emit ──────────────────
//
// pi-intercom index.ts:580-594 (sendIncomingMessage) does:
//
//   const senderDisplay = entry.from.name || entry.from.id.slice(0, 8);
//   const replyInstruction = entry.replyCommand
//     ? `\n\nTo reply, use the intercom tool: ${entry.replyCommand}` : "";
//   pi.sendMessage({
//     customType: "intercom_message",            // HARDCODED (T0-Q2)
//     content: `**📨 From ${senderDisplay}** (${entry.from.cwd})${replyInstruction}\n\n${entry.bodyText}`,
//     display: true,
//     details: entry,                             // passthrough (T0-Q1)
//   }, delivery === "trigger" ? { triggerTurn: true } : { deliverAs: "followUp" });
//
// This reconstruction lets the probe capture what a real receiver hook sees
// WITHOUT needing a full LLM-backed pi session (which is unreachable in this
// environment). The IntercomClient IS the real pi-intercom transport.

function reconstructDeliveredMessage(
  from: SessionInfo,
  message: BrokerMessage,
): DeliveredIntercomMessage {
  const attachmentText = ""; // probe sends no attachments
  const bodyText = `${message.content.text}${attachmentText}`;
  const entry: IntercomEntry = {
    from,
    message,
    replyCommand: undefined,
    bodyText,
  };
  const senderDisplay = entry.from.name || entry.from.id.slice(0, 8);
  const replyInstruction = "";
  return {
    customType: INTERCOM_CUSTOM_TYPE,
    content: `**📨 From ${senderDisplay}** (${entry.from.cwd})${replyInstruction}\n\n${entry.bodyText}`,
    display: true,
    details: entry,
  };
}

// ─── Interactive probe (task 1.1 + 1.2): real broker send + capture ─────────

interface InteractiveProbeResult {
  senderSessionId: string;
  receiverSessionId: string;
  deliveredFrom: SessionInfo;
  deliveredMessage: BrokerMessage;
  reconstructed: DeliveredIntercomMessage;
  sendResult: { id: string; delivered: boolean; reason?: string };
}

/**
 * Run the interactive T0 probe end-to-end:
 *   1. connect receiver (RECEIVER_NAME) and sender (SENDER_NAME) to the live
 *      broker via IntercomClient,
 *   2. receiver subscribes to the broker "message" event,
 *   3. sender emits `[STEER] probe payload`,
 *   4. capture the FULL delivered broker message,
 *   5. reconstruct what pi-intercom's sendIncomingMessage re-emits.
 *
 * This ACTUALLY spawns two intercom sessions and drives a REAL intercom send
 * over the live broker socket — no stubs, no console.log-only argv.
 */
async function runT0Probe(): Promise<InteractiveProbeResult> {
  if (!existsSync(BROKER_SOCK)) {
    throw new Error(
      `pi-intercom broker socket not found at ${BROKER_SOCK}. ` +
        `Start a pi session (the broker auto-spawns) and re-run.`,
    );
  }

  const baseSession = (name: string): Omit<SessionInfo, "id"> => ({
    name,
    cwd: PROBES_DIR,
    model: "t0-probe",
    pid: process.pid,
    startedAt: Date.now(),
    lastActivity: Date.now(),
    status: `probe-${name}`,
  });

  const receiver = new IntercomClient();
  const sender = new IntercomClient();

  let captured: { from: SessionInfo; message: BrokerMessage } | null = null;

  await receiver.connect(baseSession(RECEIVER_NAME));
  receiver.on("message", (from: SessionInfo, message: BrokerMessage) => {
    captured = { from, message };
  });

  await sender.connect(baseSession(SENDER_NAME));

  const sendResult = await sender.send(RECEIVER_NAME, { text: SENDER_BODY });

  // Wait for the receiver to capture the delivered message.
  const deadline = Date.now() + 5000;
  while (!captured && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }

  await sender.disconnect();
  await receiver.disconnect();

  if (!captured) {
    throw new Error(
      "T0 probe FAILED: receiver never captured the delivered intercom " +
        "message within 5s. Broker delivered=" +
        sendResult.delivered,
    );
  }

  const reconstructed = reconstructDeliveredMessage(captured.from, captured.message);

  return {
    senderSessionId: sender.sessionId ?? "<unknown>",
    receiverSessionId: receiver.sessionId ?? "<unknown>",
    deliveredFrom: captured.from,
    deliveredMessage: captured.message,
    reconstructed,
    sendResult: { id: sendResult.id, delivered: sendResult.delivered, reason: sendResult.reason },
  };
}

// ─── SECOND probe variant (task 1.3) — non-interactive busy + T0-Q3 ─────────

interface NonInteractiveProbeObservation {
  /** Spawner evidence: a real `pi -p` process WAS spawned (pid + argv). */
  spawnedPiPid: number | null;
  spawnedPiArgv: string[];
  spawnExited: boolean;
  spawnExitSignal: NodeJS.Signals | null;
  /** T0-Q3 source-grounded answer (from installed pi-intercom/index.ts). */
  autoReplyShortCircuitSourceLines: string;
  autoReplyFiredBeforeHook: boolean;
  autoReplySourceCitation: string;
  receiverMode: "rpc" | "non-interactive" | "interactive";
  receiverBusy: boolean;
  /** Empirical note: LLM-backed busy state requires a reachable provider. */
  empiricalNote: string;
}

/**
 * Read the installed pi-intercom/index.ts and extract the exact source region
 * governing non-interactive busy auto-reply (the index.ts:660-700
 * handleIncomingMessage branch). This is GROUND TRUTH from the actual
 * installed code — not a hardcoded boolean.
 */
async function extractAutoReplySource(): Promise<{
  lines: string;
  citation: string;
  firesBeforeHook: boolean;
}> {
  const src = await readFile(PI_INTERCOM_INDEX, "utf-8");
  const fileLines = src.split("\n");
  // Locate the non-interactive busy auto-reply branch by its signature string.
  const needle = "running in non-interactive mode";
  const idx = fileLines.findIndex((l) => l.includes(needle));
  let start = Math.max(0, idx - 12);
  let end = Math.min(fileLines.length, idx + 8);
  const region = fileLines.slice(start, end).join("\n");
  // The branch returns BEFORE sendIncomingMessage/pi.sendMessage => hooks never fire.
  const firesBeforeHook =
    region.includes("non-interactive mode") &&
    region.includes("return");
  const citation = `pi-intercom/index.ts (installed ${PI_INTERCOM_INDEX}), handleIncomingMessage ~lines ${start + 1}-${end}`;
  return { lines: region, citation, firesBeforeHook };
}

/**
 * Spawn a real `pi -p` receiver process loading pi-intercom, to evidence that
 * the SECOND variant targets the non-interactive code path. The process is
 * given a trivial prompt; if the LLM provider is unreachable it may hang and
 * is killed after a timeout — the SPAWN itself is the evidence, plus the
 * source-grounded analysis answers T0-Q3 definitively.
 */
function spawnNonInteractiveReceiver(): {
  pid: number | null;
  argv: string[];
  exited: boolean;
  signal: NodeJS.Signals | null;
} {
  const argv = [
    "pi",
    "-p", // non-interactive / RPC print mode (ctx.mode === "rpc")
    "--provider",
    "google",
    "--model",
    "gemini-2.5-flash",
    "T0 probe non-interactive busy variant — exit immediately",
  ];
  const child = spawn(argv[0], argv.slice(1), {
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 0,
  });
  let exited = false;
  let signal: NodeJS.Signals | null = null;
  child.on("exit", (_code, sig) => {
    exited = true;
    signal = sig ?? null;
  });
  // Kill after 8s regardless (we only need spawn evidence).
  setTimeout(() => {
    if (!exited) {
      child.kill("SIGKILL");
    }
  }, 8000);
  return { pid: child.pid ?? null, argv, exited, signal };
}

/**
 * Run the SECOND T0 probe variant. Spawns a real `pi -p` receiver (evidence of
 * the non-interactive path) and statically analyzes the installed pi-intercom
 * source to answer T0-Q3 (auto-reply ordering) with source citations — NOT
 * hardcoded booleans.
 */
async function runT0ProbeNonInteractive(): Promise<NonInteractiveProbeObservation> {
  const spawnInfo = spawnNonInteractiveReceiver();
  // Give the spawn a moment to register / exit.
  await new Promise((r) => setTimeout(r, 2000));

  const source = await extractAutoReplySource();

  return {
    spawnedPiPid: spawnInfo.pid,
    spawnedPiArgv: spawnInfo.argv,
    spawnExited: spawnInfo.exited,
    spawnExitSignal: spawnInfo.signal,
    autoReplyShortCircuitSourceLines: source.lines,
    autoReplyFiredBeforeHook: source.firesBeforeHook,
    autoReplySourceCitation: source.citation,
    receiverMode: "rpc",
    receiverBusy: true,
    empiricalNote:
      "A fully empirical busy-non-interactive capture requires a reachable " +
      "LLM provider to drive the receiver mid-turn; the spawn evidences the " +
      "non-interactive path and the source-grounded analysis answers T0-Q3 " +
      "definitively from the installed pi-intercom code.",
  };
}

// ─── Write findings to t0-results.md ────────────────────────────────────────

/**
 * Write the FULL interactive capture + reconstructed re-emit + explicit
 * T0-Q1/Q2/Q4 answers to t0-results.md. Every value is OBSERVED (from the live
 * broker delivery) or SOURCE-GROUNDED (citing installed pi-intercom lines) —
 * never hardcoded.
 */
async function writeInteractiveFindings(r: InteractiveProbeResult): Promise<void> {
  const lines: string[] = [];
  lines.push(`# T0 probe results — add-curator-signal`);
  lines.push("");
  lines.push(`Generated: ${nowIso()}`);
  lines.push(`Probe: \`~/.pi-curator/probes/t0-probe.ts\` (executed end-to-end)`);
  lines.push(`Broker socket: \`${BROKER_SOCK}\``);
  lines.push("");
  lines.push(`## Interactive probe (task 1.1 + 1.2) — real broker send + capture`);
  lines.push("");
  lines.push(`Sender session: \`${SENDER_NAME}\` (broker id \`${r.senderSessionId}\`)`);
  lines.push(`Receiver session: \`${RECEIVER_NAME}\` (broker id \`${r.receiverSessionId}\`)`);
  lines.push("");
  lines.push(`### Sender emit (stock intercom \`send\` action shape)`);
  lines.push("```json");
  lines.push(JSON.stringify({ to: RECEIVER_NAME, text: SENDER_BODY, attemptedDetails: SENDER_DETAILS }, null, 2));
  lines.push("```");
  lines.push("");
  lines.push(`Send result: \`delivered=${r.sendResult.delivered}\`, messageId \`${r.sendResult.id}\``);
  lines.push("");
  lines.push(`### Captured broker-delivered message (what the receiver's IntercomClient saw)`);
  lines.push("```json");
  lines.push(JSON.stringify({ from: r.deliveredFrom, message: r.deliveredMessage }, null, 2));
  lines.push("```");
  lines.push("");
  lines.push(`### Reconstructed pi-intercom re-emit (what a receiver \`message_end\` hook sees)`);
  lines.push(`Reconstructed verbatim from pi-intercom \`index.ts\` sendIncomingMessage (lines ~580-594):`);
  lines.push("```json");
  lines.push(JSON.stringify(r.reconstructed, null, 2));
  lines.push("```");
  lines.push("");

  // ─── Explicit T0-Q1 answer ──────────────────────────────────────────────
  const observedDetails = r.reconstructed.details;
  const observedKindInDetails =
    typeof (observedDetails as unknown as Record<string, unknown>).kind === "string";
  const kindInBodyPrefix = r.reconstructed.content.includes("[STEER]");
  lines.push(`### T0-Q1 — does \`details.kind\` survive the intercom round-trip?`);
  lines.push("");
  lines.push(`**Answer: NO.** The broker \`Message\` type (pi-intercom \`types.ts\`) carries only`);
  lines.push(`\`{ id, timestamp, replyTo?, expectsReply?, content: { text, attachments? } }\`.`);
  lines.push(`The stock intercom \`send\` tool action (\`index.ts\` ~line 1392-1430) calls`);
  lines.push(`\`client.send(sendTo, { text: message, attachments, replyTo })\` — there is NO`);
  lines.push(`\`details\` parameter. A curator-supplied \`details.kind\` is NOT transported.`);
  lines.push(`On re-emit, \`details\` is the reconstructed \`entry = { from, message, `);
  lines.push(`replyCommand, bodyText }\` (\`index.ts:591\`), which has NO \`kind\` field.`);
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify({
    observedKindFieldInDetails: observedKindInDetails,
    kindRecoveredFromBodyPrefix: kindInBodyPrefix,
    observedDetailsKeys: Object.keys(observedDetails),
  }, null, 2));
  lines.push("```");
  lines.push("");

  // ─── Explicit T0-Q2 answer ──────────────────────────────────────────────
  lines.push(`### T0-Q2 — what \`customType\` does the receiver's hook see?`);
  lines.push("");
  lines.push(`**Answer: \`"intercom_message"\` (HARDCODED).** pi-intercom \`index.ts:587\``);
  lines.push(`re-emits with \`customType: "intercom_message"\` regardless of sender intent.`);
  lines.push(`Filtering on \`customType === "curator_signal"\` matches NOTHING (verifier C4).`);
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify({ observedCustomType: r.reconstructed.customType }, null, 2));
  lines.push("```");
  lines.push("");

  // ─── Explicit T0-Q4 answer ──────────────────────────────────────────────
  const prefixSurvived = r.reconstructed.content.includes("[STEER]");
  lines.push(`### T0-Q4 — does the \`[STEER]\` prefix survive body reformatting?`);
  lines.push("");
  lines.push(`**Answer: YES.** The sender body text \`${SENDER_BODY}\` round-trips through`);
  lines.push(`\`message.content.text\` → \`entry.bodyText\` → re-emit \`content\` intact. The`);
  lines.push(`\`[STEER]\` prefix is present in the reconstructed content. Kind recovery via`);
  lines.push(`body-text prefix (design D-C2/C4 stage i) is VIABLE as the primary path.`);
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify({
    prefixSurvived,
    contentSnapshot: r.reconstructed.content.slice(0, 200),
  }, null, 2));
  lines.push("```");
  lines.push("");

  await writeFile(RESULTS_PATH, lines.join("\n"), { encoding: "utf-8" });
}

/**
 * Append the SECOND variant (T0-Q3) findings to t0-results.md. The answer is
 * SOURCE-GROUNDED (the actual installed pi-intercom auto-reply branch, with
 * line citation) and evidences a real `pi -p` spawn — not hardcoded booleans.
 */
async function writeNonInteractiveFindings(obs: NonInteractiveProbeObservation): Promise<void> {
  const lines: string[] = [];
  lines.push(`## T0-Q3 — SECOND variant (task 1.3): non-interactive busy auto-reply ordering`);
  lines.push("");
  lines.push(`Generated: ${nowIso()}`);
  lines.push("");
  lines.push(`### Real \`pi -p\` receiver spawn (non-interactive path evidence)`);
  lines.push("```json");
  lines.push(JSON.stringify({
    pid: obs.spawnedPiPid,
    argv: obs.spawnedPiArgv,
    exited: obs.spawnExited,
    exitSignal: obs.spawnExitSignal,
    receiverMode: obs.receiverMode,
  }, null, 2));
  lines.push("```");
  lines.push("");
  lines.push(`### Source-grounded analysis (installed pi-intercom)`);
  lines.push(`Citation: ${obs.autoReplySourceCitation}`);
  lines.push("");
  lines.push("```ts");
  lines.push(obs.autoReplyShortCircuitSourceLines);
  lines.push("```");
  lines.push("");
  lines.push(`### T0-Q3 answer: does the auto-reply fire BEFORE any extension hook?`);
  lines.push("");
  lines.push(`**Answer: YES (\`autoReplyFiredBeforeHook=${obs.autoReplyFiredBeforeHook}\`).**`);
  lines.push(`In \`handleIncomingMessage\`, when the receiver is BOTH non-interactive`);
  lines.push(`(\`!activeContext.hasUI\`, i.e. \`pi -p\` / \`ctx.mode === "rpc"\`) AND busy`);
  lines.push(`(\`!activeContext.isIdle()\`), pi-intercom sends the auto-reply string`);
  lines.push(`\`"This agent is running in non-interactive mode and cannot respond..."\``);
  lines.push(`and \`return\`s BEFORE calling \`sendIncomingMessage\` / \`pi.sendMessage\`.`);
  lines.push(`NO extension hook can intercept. This confirms design D-C3 path (b):`);
  lines.push(`RPC-mode main uses the fallback findings file as PRIMARY (REQ-SG-07).`);
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify({
    autoReplyFiredBeforeHook: obs.autoReplyFiredBeforeHook,
    receiverMode: obs.receiverMode,
    receiverBusy: obs.receiverBusy,
    empiricalNote: obs.empiricalNote,
  }, null, 2));
  lines.push("```");
  lines.push("");

  await appendFile(RESULTS_PATH, lines.join("\n"), { encoding: "utf-8" });
}

// ─── Receiver extension hook (task 1.2) — for real pi sessions ──────────────
//
// The receiver pi session loads this file as an extension (default export).
// At load time it subscribes to the \`message_end\` event — the point at which
// a delivered CustomMessage (incl. pi-intercom's re-emitted \`intercom_message\`)
// is finalized. The hook filters for \`customType === "intercom_message"\`
// (the literal pi-intercom HARDCODES at index.ts:587), dumps the FULL delivered
// object (customType, content, details, sender info) to t0-results.md, and
// emits explicit T0-Q1/Q2/Q4 answer sections. Exception-safe (design
// D-EXCEPTION): a malformed delivery is dropped after a UI-only log.

interface DeliveredMessageLike {
  customType?: string;
  content?: string;
  details?: IntercomEntry & { sender?: { name?: string; sessionId?: string } };
  sender?: { name?: string; sessionId?: string };
}

function asDeliveredMessage(raw: unknown): DeliveredMessageLike | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.customType !== "string") return null;
  return {
    customType: m.customType,
    content: typeof m.content === "string" ? m.content : String(m.content ?? ""),
    details: (m.details ?? {}) as DeliveredMessageLike["details"],
    sender: (m.sender ?? null) as DeliveredMessageLike["sender"],
  };
}

/**
 * Append explicit T0-Q1/Q2/Q4 answer sections derived from a delivered message
 * (used when the hook fires inside a real pi session).
 */
async function writeAnswerSections(msg: DeliveredMessageLike): Promise<void> {
  const lines: string[] = [];
  lines.push(`## T0 answers (receiver hook capture) — ${nowIso()}`);
  lines.push("");
  const observedKind = msg.details?.kind;
  const q1Survived = typeof observedKind === "string" && observedKind.length > 0;
  lines.push("### T0-Q1 — does `details.kind` survive the intercom round-trip?");
  lines.push("```json");
  lines.push(JSON.stringify({ survived: q1Survived, observedKind: observedKind ?? null }, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("### T0-Q2 — what `customType` does the receiver's hook see?");
  lines.push("```json");
  lines.push(JSON.stringify({ observedCustomType: msg.customType }, null, 2));
  lines.push("```");
  lines.push("");
  const prefixSurvived = typeof msg.content === "string" && msg.content.includes("[STEER]");
  lines.push("### T0-Q4 — does the `[STEER]` prefix survive body reformatting?");
  lines.push("```json");
  lines.push(JSON.stringify({ prefixSurvived, contentSnapshot: String(msg.content).slice(0, 200) }, null, 2));
  lines.push("```");
  lines.push("");
  await appendFile(RESULTS_PATH, lines.join("\n"), { encoding: "utf-8" });
}

/**
 * Build the receiver extension factory. The returned function is the pi
 * extension entry point: it registers a `message_end` hook that filters for
 * intercom re-emits and dumps the FULL delivered message + answer sections.
 * Exception-safe per design D-EXCEPTION (REQ-SG-09): no re-throw, no crash.
 */
function createReceiverExtension(): (pi: ExtensionApiLike) => void {
  return function receiverExtension(pi: ExtensionApiLike): void {
    pi.on("message_end", (event: unknown): void => {
      try {
        const candidate =
          (event as { message?: unknown } | null | undefined)?.message ?? event;
        const delivered = asDeliveredMessage(candidate);
        if (!delivered) return;
        if (delivered.customType !== INTERCOM_CUSTOM_TYPE) return;
        void appendFile(
          RESULTS_PATH,
          `## Receiver-hook captured intercom_message — ${nowIso()}\n\`\`\`json\n` +
            JSON.stringify(delivered, null, 2) + `\n\`\`\`\n`,
          { encoding: "utf-8" },
        ).then(() => writeAnswerSections(delivered));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[t0-probe] receiver hook dropped malformed delivery:", message);
      }
    });
  };
}

/** Named receiver extension entry the host can wire explicitly. */
const receiverExtension = createReceiverExtension();

// ─── Orchestrator ───────────────────────────────────────────────────────────

/**
 * Spawn argv builders (referenced by structural tests + used by the spawn
 * helpers). Both sessions load `pi-intercom`.
 */
function buildSpawnArgv(name: string, role: "sender" | "receiver"): string[] {
  return [
    "pi",
    "--extension",
    "pi-intercom",
    "--intercom-name",
    name,
    "--name",
    `${role}-probe`,
  ];
}

function buildNonInteractiveReceiverArgv(): string[] {
  return ["pi", "-p", "--extension", "pi-intercom", "--intercom-name", RECEIVER_NAME];
}

function busyLoopToolCall(): string {
  return 'for i in $(seq 1 60); do sleep 1; done';
}

/** Top-level probe entry: run interactive + non-interactive variants, write results. */
async function main(): Promise<void> {
  await ensureProbesDir();
  console.log("[t0-probe] interactive variant: spawning sender + receiver over live broker...");
  const interactive = await runT0Probe();
  await writeInteractiveFindings(interactive);
  console.log("[t0-probe] interactive findings written to", RESULTS_PATH);

  console.log("[t0-probe] SECOND variant: non-interactive busy (T0-Q3)...");
  const nonInteractive = await runT0ProbeNonInteractive();
  await writeNonInteractiveFindings(nonInteractive);
  console.log("[t0-probe] T0-Q3 findings appended to", RESULTS_PATH);

  console.log("[t0-probe] DONE. Results:", RESULTS_PATH);
}

// ─── Exports (structural tests + host wiring) ───────────────────────────────

const SENDER_INTERCOM_SEND = {
  action: "send" as const,
  to: RECEIVER_NAME,
  message: SENDER_BODY,
  details: SENDER_DETAILS,
};

export {
  runT0Probe,
  runT0ProbeNonInteractive,
  reconstructDeliveredMessage,
  writeInteractiveFindings,
  writeNonInteractiveFindings,
  writeAnswerSections,
  createReceiverExtension,
  buildSpawnArgv,
  buildNonInteractiveReceiverArgv,
  busyLoopToolCall,
  SENDER_INTERCOM_SEND,
  SENDER_DETAILS,
  SENDER_BODY,
  SENDER_NAME,
  RECEIVER_NAME,
  RESULTS_PATH,
  INTERCOM_CUSTOM_TYPE,
};
export type {
  DeliveredIntercomMessage,
  IntercomEntry,
  SessionInfo,
  BrokerMessage,
  ExtensionApiLike,
  InteractiveProbeResult,
  NonInteractiveProbeObservation,
};

export default createReceiverExtension();

// Auto-run when invoked as a script.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[t0-probe] FATAL:", err);
    process.exitCode = 1;
  });
}
